import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { blindLetter, blindOrder, namesHidden } from "@hatchlight/core/blind";
import { promptKinds } from "@hatchlight/core/ranking";
import {
	CONSISTENT_SCORE,
	followsGuide,
	GUIDE_KINDS,
	type GuideKind,
	type JobView,
	MAX_CHARACTER_REFERENCES,
	type ModelSpec,
	PROMPT_KINDS,
	type PromptKind,
	RANKING_PERIODS,
	type Ranking,
	type TurnView,
} from "@hatchlight/core/types";
import { z } from "zod";
import type { Reel } from "./reel";
import { done, isLocal, money, type SpendGuard, TERMINAL } from "./spend";

/**
 * The tools an agent uses to make and find pictures and videos with
 * Hatchlight, whatever it talks through: an agent outside over MCP, or the
 * assistant inside the app. On this computer's models by default, on paid
 * ones only when the person allowed it, and never installing models.
 */

export interface ToolImage {
	/** Base64. */
	data: string;
	mimeType: string;
	/** Which picture it is, e.g. "ast_1 by FLUX.1 schnell". */
	label?: string;
}

/** A smaller copy of a picture to show an agent, or null if it cannot. */
export async function shrinkPicture(
	data: Uint8Array,
	side = PREVIEW_SIDE,
): Promise<{
	size: { width: number; height: number };
	image: ToolImage;
} | null> {
	try {
		const size = await new Bun.Image(data).metadata();
		const small = await new Bun.Image(data)
			.resize(side, side, {
				fit: "inside",
				withoutEnlargement: true,
			})
			// JPEG: every service reads it; llama.cpp reads no WebP.
			.jpeg({ quality: 85 })
			.bytes();
		return {
			size,
			image: {
				data: Buffer.from(small).toString("base64"),
				mimeType: "image/jpeg",
			},
		};
	} catch {
		return null;
	}
}

/** Says which picture each preview is, in the order they come. */
export function previewsLine(images: ToolImage[]): string[] {
	const labels = images.flatMap((image) => (image.label ? [image.label] : []));
	return labels.length > 0
		? [`Previews below, in order: ${labels.join("; ")}.`]
		: [];
}

export interface ToolResult {
	text: string;
	/** Small previews, for an agent that can look at pictures. */
	images: ToolImage[];
	/** The call could not do what was asked; `text` says why. */
	isError?: boolean;
	/** The turn the call made, when it made one. */
	turnId?: string;
}

export interface ToolContext {
	/** The agent gave up on the call. */
	signal: AbortSignal;
	/** Says the call is alive, for agents that give up on a silent one. */
	progress(message: string): Promise<void>;
	/** The call made a turn, before waiting for it. */
	started?(turnId: string): void;
}

export interface Tool<Shape extends z.ZodRawShape = z.ZodRawShape> {
	name: string;
	title: string;
	description: string;
	/** Its arguments, each a zod schema. */
	input: Shape;
	/** Only looks; changes nothing and spends nothing. */
	readOnly?: boolean;
	/** May replace something that exists, such as a file. */
	destructive?: boolean;
	run(
		args: z.infer<z.ZodObject<Shape>>,
		context: ToolContext,
	): Promise<ToolResult>;
}

export interface ToolsOptions {
	/**
	 * Whether models that cost money (cloud models, on the person's own
	 * keys) may be used. Off, only models on this computer are.
	 */
	allowPaid: boolean;
	/** Keeps paid use within the limit; shared by all calls it covers. */
	spend: SpendGuard;
	/**
	 * Whether the agent may name files on this computer: pictures to start
	 * from, and where to save results. Only for agents the person runs
	 * themselves; the assistant inside the app works with ids alone.
	 */
	files: boolean;
	/** How long a generation is waited for before it is left running. */
	waitMs?: number;
	pollMs?: number;
}

/** What an agent is told about Hatchlight before it calls anything. */
export const TOOLS_INSTRUCTIONS =
	"Hatchlight makes pictures and videos with the models its user installed (local, free) and, when allowed, with paid cloud models on the user's own keys. Call list_models first to see what can be used. Pass returned picture ids (ast_…) back as reference_images to iterate on a result. Models can only be installed by the user, in the Hatchlight app.";

/** Pictures shown to the agent are made this small: enough to judge them. */
const PREVIEW_SIDE = 1024;
/** At most this many pictures are shown in one answer. */
const MAX_PREVIEWS = 8;
/** What Hatchlight's ids look like; anything else is not sent to it. */
export const ID = /^[a-z]+_[A-Za-z0-9]+$/;
export const ASSET_ID = /^ast_[A-Za-z0-9]+$/;

const text = (value: string): ToolResult => ({ text: value, images: [] });
const failure = (value: string): ToolResult => ({
	...text(value),
	isError: true,
});

/**
 * Keeps the arguments' types while the list holds tools of any shape, and
 * checks the arguments: a language model's call may not match the schema.
 */
const tool = <Shape extends z.ZodRawShape>(definition: Tool<Shape>): Tool => {
	const schema = z.object(definition.input);
	return {
		...(definition as unknown as Tool),
		async run(args, context) {
			const checked = schema.safeParse(args ?? {});
			if (!checked.success) {
				return failure(
					`The arguments do not fit ${definition.name}: ${z.prettifyError(checked.error)}`,
				);
			}
			return definition.run(checked.data, context);
		},
	};
};

/** What a model can do, in a few words an agent can choose by. */
function describe(model: ModelSpec): string {
	const caps = model.capabilities;
	const can = [
		model.operations.includes("generate") && "makes from words",
		caps.maxReferenceImages > 0 &&
			caps.upscale == null &&
			(caps.strength != null
				? "redraws a given picture (strength)"
				: `follows up to ${caps.maxReferenceImages} given picture(s)`),
		caps.mask != null && "redraws only a masked part",
		caps.upscale != null && `upscales a picture ${caps.upscale}x`,
		caps.guide && guideText(caps.guide),
		caps.needsReference && "needs a given picture",
	].filter(Boolean);
	const cost = isLocal(model)
		? "free, runs on this computer"
		: model.pricing?.usdPerOutput != null
			? `about $${model.pricing.usdPerOutput} per ${model.media}`
			: model.pricing?.usdPerSecond != null
				? `about $${model.pricing.usdPerSecond} per second`
				: "paid, price unknown";
	const shapes = caps.aspectRatios.length
		? `; ratios ${caps.aspectRatios.join(", ")}`
		: "";
	const lengths = caps.durations?.length
		? `; lengths ${caps.durations.join(", ")} s`
		: "";
	return `- ${model.id} — ${model.name} (${model.media}): ${can.join(", ")}; ${cost}${shapes}${lengths}`;
}

/** How a model follows a guide picture, for an agent to choose by. */
function guideText(guide: NonNullable<ModelSpec["capabilities"]["guide"]>) {
	const fromMap = guide.kinds.filter((k) => !guide.makesMaps.includes(k));
	return `follows a guide picture (${[
		guide.makesMaps.length > 0 &&
			`${guide.makesMaps.join(", ")} from any picture`,
		fromMap.length > 0 && `${fromMap.join(", ")} only from a ready map`,
	]
		.filter(Boolean)
		.join("; ")})`;
}

/** A guide as asked for: its kind, and whether the picture is the map. */
export interface GuideAsk {
	kind: GuideKind;
	ready: boolean;
}

/**
 * The model used when the agent names none: the best free picture model on
 * this computer that can take `references` pictures, the faster of equals.
 * The first listed is not the best.
 */
export function bestLocalModel(
	models: ModelSpec[],
	references: number,
	/** A guide picture it must follow. */
	guide?: GuideAsk,
): ModelSpec | undefined {
	return models
		.filter((m) => fitsByDefault(m, references, guide))
		.toSorted(
			(a, b) =>
				(b.profile?.quality ?? 0) - (a.profile?.quality ?? 0) ||
				(b.profile?.speed ?? 0) - (a.profile?.speed ?? 0),
		)[0];
}

/** A free picture model on this computer that can take `references` pictures. */
function fitsByDefault(
	model: ModelSpec,
	references: number,
	/** A guide picture it must follow. */
	guide?: GuideAsk,
): boolean {
	return (
		isLocal(model) &&
		model.media === "image" &&
		model.capabilities.upscale == null &&
		(references > 0
			? model.capabilities.maxReferenceImages >= references
			: model.operations.includes("generate")) &&
		(!guide || followsGuide(model.capabilities.guide, guide))
	);
}

/**
 * The model the person picked most often in comparisons, among `fits`,
 * for prompts of the kind given; null while no model is clearly preferred.
 */
export async function preferredModel(
	reel: Pick<Reel, "ranking">,
	fits: ModelSpec[],
	prompt: string,
	references: number,
): Promise<ModelSpec | null> {
	if (!reel.ranking || fits.length === 0) return null;
	const byId = new Map(fits.map((m) => [m.id, m]));
	const kind = promptKinds(prompt, references)[0];
	for (const query of kind ? [{ kind }, {}] : [{}]) {
		const ranking = await reel.ranking(query).catch(() => null);
		// A real preference: enough comparisons, and won at least half of
		// them. Merely ranking first among models that all lose is none.
		const top = ranking?.models.find(
			(m) => !m.few && m.winRate >= 0.5 && byId.has(m.modelId),
		);
		if (top) return byId.get(top.modelId) ?? null;
	}
	return null;
}

/** A ranking in lines an agent can read. */
function rankingLines(ranking: Ranking, kind?: PromptKind): string[] {
	const what = kind ? ` for ${kind} prompts` : "";
	if (ranking.models.length === 0) {
		return [
			`The user has not picked a best result in any comparison${what} yet. In the Hatchlight app they can compare models on one prompt and mark the best result.`,
		];
	}
	return [
		`From ${ranking.comparisons} comparison(s)${what} where the user picked the best result, best first:`,
		...ranking.models.map((m, i) => {
			const time =
				m.msPerOutput != null ? `${(m.msPerOutput / 1000).toFixed(1)} s` : null;
			const cost =
				m.usdPerOutput == null
					? null
					: m.usdPerOutput === 0
						? "free"
						: `$${m.usdPerOutput.toFixed(3)}`;
			const per = [time, cost].filter(Boolean).join(", ");
			return `${i + 1}. ${m.name} (${m.modelId}): won ${m.wins} of ${m.comparisons} (${Math.round(m.winRate * 100)}%)${per ? `; median ${per} per ${m.media}` : ""}${m.few ? "; few comparisons, not reliable yet" : ""}`;
		}),
	];
}

/** Models that can be used now: ready, and paid only when allowed. */
export async function usableModels(
	reel: Pick<Reel, "models" | "providers">,
	allowPaid: boolean,
): Promise<ModelSpec[]> {
	const [models, providers] = await Promise.all([
		reel.models(),
		reel.providers(),
	]);
	const ready = new Set(
		providers.filter((p) => p.hasKey || !p.requiresKey).map((p) => p.id),
	);
	return models.filter(
		(m) => ready.has(m.providerId) && (allowPaid || isLocal(m)),
	);
}

export function createTools(reel: Reel, options: ToolsOptions): Tool[] {
	const waitMs = options.waitMs ?? 15 * 60_000;
	const pollMs = options.pollMs ?? 1000;
	const { spend } = options;
	const pictures = options.files
		? "Picture ids (ast_…) or image file paths"
		: "Picture ids (ast_…)";

	const usable = () => usableModels(reel, options.allowPaid);

	/** Why some references cannot be used here: paths where only ids are. */
	function notIds(given: string[]): ToolResult | null {
		if (options.files) return null;
		const named = given.filter((r) => !ASSET_ID.test(r));
		return named.length > 0
			? failure(`Pictures are given by id (ast_…), not ${named.join(", ")}.`)
			: null;
	}

	/** Picture ids as they are, files read and uploaded where allowed. */
	async function references(given: string[]): Promise<string[]> {
		const ids: string[] = [];
		for (const item of given) {
			if (ASSET_ID.test(item)) {
				ids.push(item);
				continue;
			}
			// The one place files are read: refused here, whatever calls it.
			if (!options.files) throw new Error(`Not a picture id: ${item}`);
			const data = new Uint8Array(await readFile(resolve(item)));
			ids.push((await reel.upload(data)).id);
		}
		return ids;
	}

	/** Whether the person hides model names until they pick the best. */
	const blindPicks = async () =>
		(await reel.settings?.().catch(() => null))?.blindPicks === true;

	/**
	 * Says how a turn's jobs stand, with previews of what they made. In a
	 * blind comparison not picked yet, the models go by the letters the app
	 * shows, in its order, with nothing that would tell them apart.
	 */
	async function report(
		turn: Pick<TurnView, "id" | "jobs" | "pickedAssetId">,
		models: ModelSpec[],
		images: ToolImage[],
		blind: boolean,
	): Promise<string[]> {
		const lines: string[] = [];
		const hidden = namesHidden(turn, blind);
		const jobs = hidden ? blindOrder(turn.jobs, turn.id) : turn.jobs;
		if (hidden) {
			lines.push(
				"The user hides model names until they pick the best result: call the results by these letters, and do not name or guess the models.",
			);
		}
		for (const [index, job] of jobs.entries()) {
			const name = hidden
				? `Model ${blindLetter(index)}`
				: (models.find((m) => m.id === job.modelId)?.name ?? job.modelId);
			const seconds =
				!hidden && job.startedAt && job.finishedAt
					? ` in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)} s`
					: "";
			const paid = !hidden && job.costUsd ? `, $${job.costUsd.toFixed(3)}` : "";
			if (job.status !== "succeeded") {
				// An error may name its model: not while the names are hidden.
				const error = job.error && !hidden ? `: ${job.error}` : "";
				lines.push(`- ${name}: ${job.status}${error}`);
				continue;
			}
			const made: string[] = [];
			for (const asset of job.assets) {
				const shown =
					asset.mime.startsWith("image/") && images.length < MAX_PREVIEWS
						? await shrinkPicture((await reel.asset(asset.id)).data)
						: null;
				if (shown) {
					images.push({ ...shown.image, label: `${asset.id} by ${name}` });
					made.push(`${asset.id} (${shown.size.width}x${shown.size.height})`);
				} else {
					made.push(`${asset.id} (${asset.mime})`);
				}
			}
			lines.push(`- ${name}: done${seconds}${paid}. ${made.join(", ")}`);
		}
		return lines;
	}

	/** Makes a turn, waits for it, and says what came of it. */
	async function run(
		input: {
			prompt: string;
			modelIds: string[];
			references: string[];
			sessionId?: string;
			aspectRatio?: string;
			count?: number;
			seed?: number;
			durationSeconds?: number;
			strength?: number;
			guide?: GuideAsk & { image: string; strength?: number };
			wait: boolean;
		},
		models: ModelSpec[],
		context: ToolContext,
	): Promise<ToolResult> {
		const named = notIds([
			...input.references,
			...(input.guide ? [input.guide.image] : []),
		]);
		if (named) return named;
		const chosen = input.modelIds.map(
			(id) => models.find((m) => m.id === id) as ModelSpec,
		);
		// Held from now, before anything can wait: a call made meanwhile sees it.
		const pending = `pending-${crypto.randomUUID()}`;
		const held = spend.hold(
			pending,
			chosen,
			input.count ?? 1,
			input.durationSeconds,
		);
		if (!held.ok) return failure(held.reason);
		if (context.signal.aborted) {
			spend.release(pending);
			return failure("Stopped before it started; nothing was made.");
		}

		let session: { id: string };
		let turn: Awaited<ReturnType<Reel["createTurn"]>>["turn"];
		try {
			const ids = await references(input.references);
			const [guideId] = input.guide
				? await references([input.guide.image])
				: [];
			({ session, turn } = await reel.createTurn({
				prompt: input.prompt,
				modelIds: input.modelIds,
				referenceAssetIds: ids,
				...(input.sessionId && { sessionId: input.sessionId }),
				...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
				...(input.count != null && { count: input.count }),
				...(input.seed != null && { seed: input.seed }),
				...(input.durationSeconds != null && {
					durationSeconds: input.durationSeconds,
				}),
				...(input.strength != null && { strength: input.strength }),
				...(input.guide &&
					guideId && {
						guide: {
							assetId: guideId,
							kind: input.guide.kind,
							ready: input.guide.ready,
							...(input.guide.strength != null && {
								strength: input.guide.strength,
							}),
						},
					}),
			}));
		} catch (error) {
			spend.release(pending);
			throw error;
		}
		spend.rename(pending, turn.id);
		context.started?.(turn.id);

		let jobs: JobView[] = turn.jobs;
		let pickedAssetId: string | null = null;
		const started = Date.now();
		let stopped = false;
		try {
			while (input.wait && !done(jobs)) {
				if (Date.now() - started > waitMs || context.signal.aborted) {
					stopped = true;
					break;
				}
				await Bun.sleep(pollMs);
				const detail = await reel.session(session.id);
				const current = detail.turns.find((t) => t.id === turn.id);
				if (current) {
					jobs = current.jobs;
					pickedAssetId = current.pickedAssetId ?? null;
					spend.settle(current);
				}
				const finished = jobs.filter((j) => TERMINAL.includes(j.status));
				await context.progress(`${finished.length} of ${jobs.length} done`);
			}
		} catch (error) {
			if (!context.signal.aborted) throw error;
			stopped = true;
		}
		spend.settle({ ...turn, jobs });

		const images: ToolImage[] = [];
		const lines = [
			`Session ${session.id}, turn ${turn.id} (the user can open it at ${reel.sessionUrl(session.id)}).`,
			...(await report(
				{ id: turn.id, jobs, pickedAssetId },
				models,
				images,
				await blindPicks(),
			)),
		];
		lines.push(...previewsLine(images));
		if (!done(jobs)) {
			lines.push(
				stopped
					? `Stopped waiting; it goes on. Call job_status with session ${session.id} later.`
					: `Started. Call job_status with session ${session.id} for the results.`,
			);
		}
		const limit = spend.limitUsd;
		if (limit != null && spend.committed() > 0) {
			lines.push(
				`Spent or held so far: ${money(spend.committed())} of ${money(limit)}.`,
			);
		}
		return { text: lines.join("\n"), images, turnId: turn.id };
	}

	const tools: Tool[] = [
		tool({
			name: "list_models",
			title: "List models",
			description:
				"Lists the models that can be used now, with what each can do (make from words, redraw or follow given pictures, redraw a masked part, follow a guide picture, upscale), its cost, and the ratios and video lengths it accepts. Local models are free and run on the user's computer. Only installed models are listed; the user installs more in the Hatchlight app.",
			input: {
				media: z
					.enum(["image", "video"])
					.optional()
					.describe("Only models that make this."),
			},
			readOnly: true,
			async run({ media }) {
				const models = (await usable()).filter(
					(m) => media == null || m.media === media,
				);
				if (models.length === 0) {
					return text(
						options.allowPaid
							? "No model can be used now. The user can install local models, or add an API key, in the Hatchlight app."
							: "No local model is installed. The user can install one from Local models in the Hatchlight app. (Paid models are off for this connection.)",
					);
				}
				const limit = spend.limitUsd;
				const note = options.allowPaid
					? limit != null
						? `Paid models are allowed, up to ${money(limit)} in all (${money(spend.left() ?? 0)} left).`
						: "Paid models are allowed, without a limit."
					: "Only local models are allowed for this connection.";
				return text([...models.map(describe), "", note].join("\n"));
			},
		}),
		tool({
			name: "generate",
			title: "Make pictures or videos",
			description: `Makes pictures or videos from a prompt, waits for them, and returns small previews with their ids. Give several models to compare them on the same prompt. Give reference_images to redraw, edit or animate a picture: ${options.files ? "ids from earlier results (ast_…) or paths of image files" : "ids from earlier results (ast_…)"}. Give guide_image to make a new picture follow another's outlines, pose or depth, with a model that follows a guide picture. Pass session_id to keep iterating in the same session. Without models, the best free local model that fits is used.`,
			input: {
				prompt: z.string().min(1).describe("What to make, or what to change."),
				models: z
					.array(z.string())
					.optional()
					.describe("Model ids from list_models; several compare them."),
				reference_images: z
					.array(z.string())
					.optional()
					.describe(`${pictures} to start from.`),
				strength: z
					.number()
					.min(0.05)
					.max(1)
					.optional()
					.describe(
						"For models that redraw a picture: how much it changes, 0.05 to 1.",
					),
				guide_image: z
					.string()
					.optional()
					.describe(
						`${options.files ? "A picture id (ast_…) or image file path" : "A picture id (ast_…)"} whose layout the new picture follows, for models that follow a guide picture.`,
					),
				guide_kind: z
					.enum(GUIDE_KINDS)
					.optional()
					.describe(
						"What of guide_image to follow: outlines (default), pose (a person's pose) or depth.",
					),
				guide_is_map: z
					.boolean()
					.optional()
					.describe(
						"True when guide_image already is the map (an edge drawing, a pose skeleton, a depth map). Some models make pose and depth maps only in the cloud.",
					),
				guide_strength: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.describe("How closely the guide is followed, 0 to 1."),
				aspect_ratio: z.string().optional().describe('Such as "16:9".'),
				count: z
					.number()
					.int()
					.min(1)
					.max(8)
					.optional()
					.describe("How many to make with each model, 1 to 8 (default 1)."),
				seed: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe("The same seed and settings make the same picture again."),
				duration_seconds: z
					.number()
					.int()
					.optional()
					.describe("Video length, for video models."),
				session_id: z
					.string()
					.regex(ID)
					.optional()
					.describe(
						"A session id (ses_…) from an earlier result, to add to it. Without one, a new session starts.",
					),
				wait: z
					.boolean()
					.optional()
					.describe(
						"Wait for the results (default). False returns at once; use job_status later.",
					),
			},
			async run(args, context) {
				const models = await usable();
				const given = args.reference_images ?? [];
				const named = notIds(given);
				if (named) return named;
				const guide = args.guide_image
					? {
							image: args.guide_image,
							kind: args.guide_kind ?? "outlines",
							ready: args.guide_is_map ?? false,
							strength: args.guide_strength,
						}
					: undefined;
				let ids = args.models ?? [];
				if (ids.length === 0) {
					// What the person picked most in comparisons, else the best on paper.
					const fit =
						(await preferredModel(
							reel,
							models.filter((m) => fitsByDefault(m, given.length, guide)),
							args.prompt,
							given.length,
						)) ?? bestLocalModel(models, given.length, guide);
					if (!fit) {
						return failure(
							guide
								? `No installed local model can follow a ${guide.kind} guide${guide.ready ? "" : " made from this picture"}. Name one with models (a cloud model may make the map), or the user can install Z-Image Turbo, guided in the Hatchlight app.`
								: given.length > 0
									? "No installed local model can start from a picture. Name one with models, or the user can install one in the Hatchlight app."
									: "No local model is installed. The user can install one from Local models in the Hatchlight app.",
						);
					}
					ids = [fit.id];
				}
				// Checked before any file is read or uploaded.
				const unknown = ids.filter((id) => !models.some((m) => m.id === id));
				if (unknown.length > 0) {
					return failure(
						`Cannot use ${unknown.join(", ")}: not installed, without a key, or paid while paid models are off. Call list_models for what can be used.`,
					);
				}
				return run(
					{
						prompt: args.prompt,
						modelIds: ids,
						references: given,
						sessionId: args.session_id,
						aspectRatio: args.aspect_ratio,
						count: args.count,
						seed: args.seed,
						durationSeconds: args.duration_seconds,
						strength: args.strength,
						guide,
						wait: args.wait ?? true,
					},
					models,
					context,
				);
			},
		}),
		tool({
			name: "upscale",
			title: "Upscale a picture",
			description: `Makes a picture larger and sharper (usually 4 times wider and taller) with an installed upscaler, and returns a preview and the new picture's id. The original is kept. A local upscaler is used first, which is free; paid ones only when paid models are allowed. Fails, saying so, when no upscaler is installed. To change what a picture shows, use generate with reference_images instead.`,
			input: {
				image: z
					.string()
					.describe(
						options.files
							? "A picture id (ast_…) or an image file path."
							: "A picture id (ast_…).",
					),
				session_id: z
					.string()
					.regex(ID)
					.optional()
					.describe(
						"A session id (ses_…) to add the result to. Without one, a new session starts.",
					),
			},
			async run(args, context) {
				const models = await usable();
				const upscalers = models.filter((m) => m.capabilities.upscale != null);
				// A free one on this computer first.
				const upscaler = upscalers.find(isLocal) ?? upscalers[0];
				if (!upscaler) {
					return failure(
						"No upscaler is installed. The user can install Real-ESRGAN from Local models in the Hatchlight app.",
					);
				}
				return run(
					{
						prompt: `Upscale ×${upscaler.capabilities.upscale}`,
						modelIds: [upscaler.id],
						references: [args.image],
						sessionId: args.session_id,
						wait: true,
					},
					models,
					context,
				);
			},
		}),
		tool({
			name: "job_status",
			title: "Check a session",
			description:
				"Says how a session's latest turn, and any turn still running, stand: each job's model and state (with the error when one failed), and for what is done its time, cost, ids and previews. Use it after generate returned before its jobs finished, because wait was false or they took long. Changes nothing.",
			input: {
				session_id: z
					.string()
					.regex(ID)
					.describe(
						"The session id (ses_…) that generate or upscale returned.",
					),
			},
			readOnly: true,
			async run({ session_id }) {
				const [detail, models] = await Promise.all([
					reel.session(session_id),
					reel.models(),
				]);
				const latest = detail.turns.at(-1);
				if (!latest) return text("The session has nothing in it yet.");
				const shown = detail.turns.filter((t) => t === latest || !done(t.jobs));
				const blind = await blindPicks();
				const images: ToolImage[] = [];
				const lines: string[] = [];
				for (const turn of shown) {
					spend.settle(turn);
					lines.push(`Turn ${turn.id}: "${turn.prompt}"`);
					lines.push(...(await report(turn, models, images, blind)));
				}
				lines.push(...previewsLine(images));
				return { text: lines.join("\n"), images };
			},
		}),
		tool({
			name: "search_gallery",
			title: "Search the gallery",
			description: `Finds pictures and videos made before, newest first, by words in their prompts. Returns ids to use with get_image${options.files ? ", save_image," : ""} or as reference_images.`,
			input: {
				query: z
					.string()
					.optional()
					.describe(
						"Words to find in prompts. Without it, the newest are listed.",
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.describe("How many to list, 1 to 50 (default 20)."),
			},
			readOnly: true,
			async run({ query, limit }) {
				const items = await reel.gallery({ query, limit: limit ?? 20 });
				if (items.length === 0) return text("Nothing found.");
				const blind = await blindPicks();
				return text(
					items
						.map(
							(item) =>
								`- ${item.id} — ${item.mime} — ${blind && item.unpicked ? "model hidden until the user picks" : (item.modelId ?? "uploaded")} — ${new Date(item.createdAt).toISOString()} — "${item.prompt ?? ""}"`,
						)
						.join("\n"),
				);
			},
		}),
		tool({
			name: "model_ranking",
			title: "Rank the user's models",
			description:
				"Says which models the user prefers, from the comparisons where they picked the best result: wins out of comparisons, and the median time and cost per picture on their computer. Narrow it by kind of prompt to answer questions such as which model they prefer for portraits. Changes nothing.",
			input: {
				kind: z
					.enum(PROMPT_KINDS)
					.optional()
					.describe(
						"Only prompts of this kind (pictures given count as editing).",
					),
				media: z.enum(["image", "video"]).optional(),
				period: z
					.enum(RANKING_PERIODS)
					.optional()
					.describe("30d for the last 30 days; all time by default."),
			},
			readOnly: true,
			async run(args) {
				if (!reel.ranking) return failure("No ranking is kept here.");
				return text(
					rankingLines(await reel.ranking(args), args.kind).join("\n"),
				);
			},
		}),
		tool({
			name: "check_consistency",
			title: "Check a character",
			description: `Says whether a picture shows the same character as 1 to ${MAX_CHARACTER_REFERENCES} pictures of it: a score from 0 to 100 and what differs, such as "coat is blue, should be green". Use it when making a series with one character (a comic, a storyboard, a mascot), after each new picture, against the first or approved one. From ${CONSISTENT_SCORE} up the character holds. A model that sees compares them; on a computer without a graphics card it takes about a minute. Changes nothing.`,
			input: {
				image: z
					.string()
					.regex(ASSET_ID)
					.describe("The id (ast_…) of the picture to check."),
				like: z
					.array(z.string().regex(ASSET_ID))
					.min(1)
					.max(MAX_CHARACTER_REFERENCES)
					.describe(
						"Ids (ast_…) of pictures showing the character as it must look.",
					),
				traits: z
					.string()
					.max(500)
					.optional()
					.describe(
						'What must stay the same, in English, such as "green coat, red scarf, short black hair".',
					),
			},
			readOnly: true,
			async run({ image, like, traits }, context) {
				if (!reel.checkConsistency) {
					return failure("Characters cannot be compared here.");
				}
				if (like.includes(image)) {
					return failure(
						"Compare the picture with other pictures, not itself.",
					);
				}
				const result = await reel.checkConsistency(
					{
						assetId: image,
						referenceAssetIds: like,
						...(traits && { traits }),
					},
					context.signal,
				);
				const lines = [
					`${image} scores ${result.score}/100 against ${like.join(", ")}: ${result.verdict === "same" ? "the same character" : result.verdict === "close" ? "the same character, with small changes" : "not the same character"}.`,
				];
				if (result.differences.length > 0) {
					lines.push(
						"Differences:",
						...result.differences.map((d) => `- ${d}`),
					);
				}
				return text(lines.join("\n"));
			},
		}),
		tool({
			name: "get_image",
			title: "Look at a picture",
			description: `Shows a picture by its id, made small enough to look at, with its full size and type. Use it to check a result before iterating on it. Videos cannot be shown${options.files ? "; save_image writes any picture or video at full size" : ""}. Changes nothing.`,
			input: {
				asset_id: z
					.string()
					.regex(ASSET_ID)
					.describe(
						"A picture id (ast_…) from generate, upscale, job_status or search_gallery.",
					),
			},
			readOnly: true,
			async run({ asset_id }) {
				const { data, mime } = await reel.asset(asset_id);
				const shown = mime.startsWith("image/")
					? await shrinkPicture(data)
					: null;
				if (!shown) {
					return text(
						`${asset_id} is a ${mime} that cannot be shown${options.files ? "; save_image saves it" : ""}.`,
					);
				}
				return {
					text: `${asset_id}: ${shown.size.width}x${shown.size.height} ${mime}`,
					images: [shown.image],
				};
			},
		}),
	];

	if (options.files) {
		tools.push(
			tool({
				name: "save_image",
				title: "Save a picture or video",
				description:
					"Writes a picture or video, at full size, to a file. The path must be absolute; an existing file is kept unless overwrite is true.",
				input: {
					asset_id: z
						.string()
						.regex(ASSET_ID)
						.describe("The id (ast_…) of the picture or video to save."),
					path: z.string().describe("Absolute path of the file to write."),
					overwrite: z
						.boolean()
						.optional()
						.describe("Replace a file that is already there (default false)."),
				},
				destructive: true,
				async run({ asset_id, path, overwrite }) {
					if (!isAbsolute(path)) return failure("The path must be absolute.");
					const { data, mime } = await reel.asset(asset_id);
					await mkdir(dirname(path), { recursive: true });
					try {
						// Created only if nothing is there, a link included, unless asked.
						await writeFile(path, data, { flag: overwrite ? "w" : "wx" });
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						return failure(
							`${path} exists; pass overwrite true to replace it.`,
						);
					}
					return text(
						`Saved ${asset_id} (${mime}, ${data.byteLength} bytes) to ${path}`,
					);
				},
			}),
		);
	}
	return tools;
}
