import {
	type GenerationParams,
	GUIDE_KINDS,
	type GuideKind,
	type ModelSpec,
	type ProviderAdapter,
	type ProviderContext,
	type ProviderEvent,
	type ProviderRequest,
	type ReferenceImage,
	ValidationError,
} from "@hatchlight/core";
import {
	errorMessage,
	type Fetch,
	refusal,
	send,
	sleep,
	toDataUri,
} from "./http";

const QUEUE = "https://queue.fal.run";
const MAX_POLL_FAILURES = 5;
const RATIOS = [
	"21:9",
	"16:9",
	"3:2",
	"4:3",
	"5:4",
	"1:1",
	"4:5",
	"3:4",
	"2:3",
	"9:16",
];

/** fal's FLUX endpoints take named sizes instead of ratios. */
const FLUX_SIZES: Record<string, string> = {
	"1:1": "square_hd",
	"4:3": "landscape_4_3",
	"16:9": "landscape_16_9",
	"3:4": "portrait_4_3",
	"9:16": "portrait_16_9",
};

interface FalModel {
	spec: ModelSpec;
	/**
	 * The endpoint to call; some models use a separate one for editing, or
	 * for following a guide picture.
	 */
	endpoint(references: ReferenceImage[], guide?: ReferenceImage): string;
	input(
		params: GenerationParams,
		references: ReferenceImage[],
		guide?: ReferenceImage,
	): object;
}

/** How fal's Z-Image ControlNet makes the map of each kind of guide. */
const PREPROCESS: Record<GuideKind, string> = {
	outlines: "canny",
	pose: "pose",
	depth: "depth",
};

function spec(
	endpoint: string,
	name: string,
	rest: Pick<ModelSpec, "operations" | "capabilities"> &
		Partial<Pick<ModelSpec, "media" | "pricing">>,
): ModelSpec {
	return {
		id: `fal/${endpoint}`,
		providerId: "fal",
		providerModelId: endpoint,
		name,
		media: "image",
		...rest,
	};
}

interface VideoOptions {
	name: string;
	/** The text-to-video endpoint, which is also the model's id. */
	text: string;
	/** The image-to-video endpoint and the name of its image field, if any. */
	image?: { endpoint: string; field: string; takesRatio: boolean };
	ratios: string[];
	durations: number[];
	/** How the endpoint wants a length of `seconds` written. */
	duration(seconds: number): string | number;
	seed: boolean;
	/** List price at the endpoint's default resolution and audio setting. */
	usdPerSecond: number;
}

/** A video model: one endpoint from text, optionally another from a first frame. */
function video(options: VideoOptions): FalModel {
	const { image } = options;
	return {
		spec: spec(options.text, options.name, {
			media: "video",
			operations: image ? ["generate", "edit"] : ["generate"],
			capabilities: {
				aspectRatios: options.ratios,
				seed: options.seed,
				maxCount: 1,
				maxReferenceImages: image ? 1 : 0,
				durations: options.durations,
			},
			pricing: { usdPerSecond: options.usdPerSecond },
		}),
		endpoint: (references) =>
			image && references.length > 0 ? image.endpoint : options.text,
		input: (params, references) => {
			const [first] = references;
			const fromImage = image && first;
			return {
				prompt: params.prompt,
				...(params.durationSeconds != null && {
					duration: options.duration(params.durationSeconds),
				}),
				...(params.aspectRatio &&
					(!fromImage || image.takesRatio) && {
						aspect_ratio: params.aspectRatio,
					}),
				...(params.seed != null && { seed: params.seed }),
				...(fromImage && { [image.field]: toDataUri(first.data, first.mime) }),
				...params.extras,
			};
		},
	};
}

function flux(endpoint: string, name: string): FalModel {
	return {
		spec: spec(endpoint, name, {
			operations: ["generate"],
			capabilities: {
				aspectRatios: Object.keys(FLUX_SIZES),
				seed: true,
				maxCount: 4,
				maxReferenceImages: 0,
				// Its T5 and CLIP encoders read English.
				englishPrompts: true,
			},
		}),
		endpoint: () => endpoint,
		input: (params) => ({
			prompt: params.prompt,
			num_images: params.count,
			output_format: "png",
			...(params.aspectRatio && { image_size: FLUX_SIZES[params.aspectRatio] }),
			...(params.seed != null && { seed: params.seed }),
			...params.extras,
		}),
	};
}

const MODELS: FalModel[] = [
	flux("fal-ai/flux/schnell", "FLUX.1 schnell"),
	flux("fal-ai/flux/dev", "FLUX.1 dev"),
	{
		spec: spec("fal-ai/nano-banana", "Nano Banana", {
			operations: ["generate", "edit"],
			capabilities: {
				aspectRatios: RATIOS,
				seed: true,
				maxCount: 4,
				maxReferenceImages: 4,
			},
		}),
		endpoint: (references) =>
			references.length > 0 ? "fal-ai/nano-banana/edit" : "fal-ai/nano-banana",
		input: (params, references) => ({
			prompt: params.prompt,
			num_images: params.count,
			output_format: "png",
			...(params.aspectRatio && { aspect_ratio: params.aspectRatio }),
			...(params.seed != null && { seed: params.seed }),
			...(references.length > 0 && {
				image_urls: references.map((r) => toDataUri(r.data, r.mime)),
			}),
			...params.extras,
		}),
	},
	{
		spec: spec("fal-ai/z-image/turbo", "Z-Image Turbo", {
			operations: ["generate"],
			capabilities: {
				aspectRatios: Object.keys(FLUX_SIZES),
				seed: true,
				maxCount: 4,
				maxReferenceImages: 0,
				// fal makes the map of every kind from any picture.
				guide: {
					kinds: [...GUIDE_KINDS],
					makesMaps: [...GUIDE_KINDS],
					strength: 0.75,
				},
			},
			// About a megapixel, at the guided endpoint's $0.0065 per megapixel
			// (the plain one is $0.005).
			pricing: { usdPerOutput: 0.0065 },
		}),
		endpoint: (_references, guide) =>
			guide ? "fal-ai/z-image/turbo/controlnet" : "fal-ai/z-image/turbo",
		input: (params, _references, guide) => ({
			prompt: params.prompt,
			num_images: params.count,
			output_format: "png",
			// Guided, the picture takes the guide's shape.
			...(params.aspectRatio &&
				!guide && { image_size: FLUX_SIZES[params.aspectRatio] }),
			...(params.seed != null && { seed: params.seed }),
			...(guide &&
				params.guide && {
					image_url: toDataUri(guide.data, guide.mime),
					preprocess: params.guide.ready
						? "none"
						: PREPROCESS[params.guide.kind],
					...(params.guide.strength != null && {
						control_scale: params.guide.strength,
					}),
				}),
			...params.extras,
		}),
	},
	{
		spec: spec("fal-ai/ideogram/character", "Ideogram Character", {
			operations: ["generate", "edit"],
			capabilities: {
				aspectRatios: Object.keys(FLUX_SIZES),
				seed: true,
				maxCount: 4,
				// It keeps one person, from one picture of them.
				maxReferenceImages: 1,
			},
			// At its default, balanced speed.
			pricing: { usdPerOutput: 0.15 },
		}),
		endpoint: () => "fal-ai/ideogram/character",
		input: (params, references) => {
			const [person] = references;
			if (!person) {
				throw new ValidationError(
					"Ideogram Character needs a picture of the person to keep",
					"needsPicture",
					{ model: "Ideogram Character" },
				);
			}
			return {
				prompt: params.prompt,
				num_images: params.count,
				reference_image_urls: [toDataUri(person.data, person.mime)],
				...(params.aspectRatio && {
					image_size: FLUX_SIZES[params.aspectRatio],
				}),
				...(params.seed != null && { seed: params.seed }),
				...params.extras,
			};
		},
	},
	video({
		name: "Veo 3.1 Fast",
		text: "fal-ai/veo3.1/fast",
		ratios: ["16:9", "9:16"],
		durations: [4, 6, 8],
		duration: (seconds) => `${seconds}s`,
		seed: true,
		usdPerSecond: 0.15,
	}),
	video({
		name: "Veo 3",
		text: "fal-ai/veo3",
		image: {
			endpoint: "fal-ai/veo3/image-to-video",
			field: "image_url",
			takesRatio: true,
		},
		ratios: ["16:9", "9:16"],
		durations: [4, 6, 8],
		duration: (seconds) => `${seconds}s`,
		seed: true,
		usdPerSecond: 0.4,
	}),
	video({
		name: "Kling 2.5 Turbo Pro",
		text: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
		image: {
			endpoint: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
			field: "image_url",
			takesRatio: false,
		},
		ratios: ["16:9", "9:16", "1:1"],
		durations: [5, 10],
		duration: String,
		seed: false,
		usdPerSecond: 0.07,
	}),
	video({
		name: "Kling 4",
		text: "kling/v4/text-to-video",
		image: {
			endpoint: "kling/v4/image-to-video",
			field: "start_image_url",
			takesRatio: false,
		},
		ratios: ["16:9", "9:16", "1:1", "21:9"],
		durations: [5, 10, 15],
		duration: Number,
		seed: false,
		usdPerSecond: 0.235,
	}),
	video({
		name: "Hailuo H3",
		text: "minimax/h3/text-to-video",
		ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
		durations: [5, 10, 15],
		duration: Number,
		seed: true,
		usdPerSecond: 0.13,
	}),
	video({
		name: "Wan 3.0",
		text: "alibaba/wan-3.0/text-to-video",
		ratios: [],
		durations: [5, 10, 15],
		duration: Number,
		seed: true,
		usdPerSecond: 0.2,
	}),
];

export interface FalHandle {
	statusUrl: string;
	responseUrl: string;
	cancelUrl: string;
}

/** We send the API key to these URLs, so they must point back at fal's queue. */
function queueUrl(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith(`${QUEUE}/`)) {
		throw new Error("fal returned an unexpected request URL");
	}
	return value;
}

export class FalProvider implements ProviderAdapter<FalHandle> {
	id = "fal";
	name = "fal";
	keyEnv = "FAL_KEY";
	requiresKey = true;
	resumable = true;

	constructor(
		private fetch: Fetch = globalThis.fetch,
		private pollMs = 1000,
	) {}

	listModels(): ModelSpec[] {
		return MODELS.map((model) => model.spec);
	}

	private headers(ctx: ProviderContext): Record<string, string> {
		return { authorization: `Key ${ctx.apiKey}` };
	}

	async submit(
		request: ProviderRequest,
		ctx: ProviderContext,
	): Promise<FalHandle> {
		const model = MODELS.find((m) => m.spec.id === request.model.id);
		if (!model) throw new Error(`Unknown fal model: ${request.model.id}`);
		const response = await send(
			this.fetch,
			`${QUEUE}/${model.endpoint(request.references, request.guide)}`,
			{
				method: "POST",
				headers: { ...this.headers(ctx), "content-type": "application/json" },
				body: JSON.stringify(
					model.input(request.params, request.references, request.guide),
				),
				signal: ctx.signal,
			},
			this.name,
		);
		if (!response.ok) throw await refusal(response, this.name);
		const body = (await response.json()) as Record<string, unknown>;
		return {
			statusUrl: queueUrl(body.status_url),
			responseUrl: queueUrl(body.response_url),
			cancelUrl: queueUrl(body.cancel_url),
		};
	}

	async *events(
		handle: FalHandle,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		const init = { headers: this.headers(ctx), signal: ctx.signal };
		const statusUrl = queueUrl(handle.statusUrl);
		let failures = 0;
		for (;;) {
			// fal keeps working (and billing) whatever happens to one poll, so a
			// network error or a 429/5xx is retried before giving up on the job.
			const response = await this.fetch(statusUrl, init).catch((error) => {
				if (ctx.signal.aborted) throw error;
				return null;
			});
			if (!response || response.status === 429 || response.status >= 500) {
				if (++failures > MAX_POLL_FAILURES) {
					yield {
						type: "failed",
						error: response
							? await errorMessage(response)
							: "Lost the connection to fal",
						// The job may still finish there: trying again follows it.
						code: "connectionLost",
						params: { provider: this.name },
					};
					return;
				}
				await sleep(this.pollMs * 2 ** failures, ctx.signal);
				continue;
			}
			failures = 0;
			if (!response.ok) {
				yield { type: "failed", error: await errorMessage(response) };
				return;
			}
			const status = (await response.json()) as {
				status: string;
				queue_position?: number;
				error?: string;
			};
			if (status.status === "COMPLETED") {
				// fal also reports failed and canceled requests as COMPLETED.
				if (status.error) {
					yield { type: "failed", error: status.error };
					return;
				}
				break;
			}
			yield {
				type: "progress",
				...(status.status === "IN_QUEUE"
					? {
							message: `In queue (position ${status.queue_position ?? 0})`,
							stage: "queued" as const,
							position: status.queue_position ?? 0,
						}
					: { message: "Generating", stage: "generating" as const }),
			};
			await sleep(this.pollMs, ctx.signal);
		}

		const response = await this.fetch(queueUrl(handle.responseUrl), init);
		if (!response.ok) {
			yield { type: "failed", error: await errorMessage(response) };
			return;
		}
		type File = { url: string; content_type?: string };
		const result = (await response.json()) as {
			images?: File[];
			video?: File;
		};
		const files = result.video ? [result.video] : (result.images ?? []);
		if (files.length === 0) {
			yield { type: "failed", error: "fal returned no result" };
			return;
		}
		yield {
			type: "completed",
			outputs: files.map((file) => ({
				url: file.url,
				// Video endpoints do not all report a type, and these all produce MP4.
				mime:
					result.video && !file.content_type?.startsWith("video/")
						? "video/mp4"
						: file.content_type,
			})),
		};
	}

	async cancel(handle: FalHandle, ctx: ProviderContext): Promise<void> {
		await this.fetch(queueUrl(handle.cancelUrl), {
			method: "PUT",
			headers: this.headers(ctx),
			signal: ctx.signal,
		});
	}
}
