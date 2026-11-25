import type {
	ProviderAdapter,
	ProviderContext,
	ProviderEvent,
	ProviderRequest,
} from "../provider";
import type { ModelSpec } from "../types";

/** A small gradient image whose colors depend on `text`, as an uncompressed BMP. */
function swatch(text: string, ratio = "1:1"): Uint8Array {
	const [rw = 1, rh = 1] = ratio.split(":").map(Number);
	const scale = 96 / Math.max(rw, rh);
	const width = Math.max(1, Math.round(rw * scale));
	const height = Math.max(1, Math.round(rh * scale));
	const hash = new Bun.CryptoHasher("sha256").update(text).digest();
	const rowSize = Math.ceil((width * 3) / 4) * 4;
	const bytes = new Uint8Array(54 + rowSize * height);
	const view = new DataView(bytes.buffer);
	bytes.set([0x42, 0x4d]);
	view.setUint32(2, bytes.length, true);
	view.setUint32(10, 54, true);
	view.setUint32(14, 40, true);
	view.setInt32(18, width, true);
	view.setInt32(22, height, true);
	view.setUint16(26, 1, true);
	view.setUint16(28, 24, true);
	for (let y = 0; y < height; y++) {
		const t = y / Math.max(1, height - 1);
		for (let x = 0; x < width; x++) {
			for (let channel = 0; channel < 3; channel++) {
				const from = hash[channel] ?? 0;
				const to = hash[channel + 3] ?? 0;
				bytes[54 + y * rowSize + x * 3 + channel] = from + (to - from) * t;
			}
		}
	}
	return bytes;
}

export interface FakeHandle {
	model: string;
	prompt: string;
	count: number;
	aspectRatio?: string;
	/** The mask's bytes, when one was given. */
	mask?: Uint8Array;
	/** The guide picture's bytes, when one was given. */
	guide?: Uint8Array;
}

/**
 * An in-process provider for tests and for developing the UI without keys.
 * Its public fields steer what the next jobs do.
 */
export class FakeProvider implements ProviderAdapter<FakeHandle> {
	name: string;
	requiresKey = false;
	resumable = false;
	/** Jobs it runs at once; unset, as many as the engine allows. */
	maxConcurrency?: number;
	/** When set, jobs wait on this before finishing. */
	gate: Promise<void> | null = null;
	/** When set, jobs fail with this message. */
	failWith: string | null = null;
	/** How the next runs fail, one each, before `failWith` applies. */
	failures: Extract<ProviderEvent, { type: "failed" }>[] = [];
	delayMs = 0;
	/** When set, jobs answer with this URL instead of image bytes. */
	outputUrl: string | null = null;
	submitted: FakeHandle[] = [];
	canceled: FakeHandle[] = [];

	constructor(
		public id = "fake",
		private modelNames = ["alpha", "beta"],
	) {
		this.name = `Fake (${id})`;
	}

	listModels(): ModelSpec[] {
		return this.modelNames.map((name) => ({
			id: `${this.id}/${name}`,
			providerId: this.id,
			providerModelId: name,
			name: `Fake ${name}`,
			media: "image",
			operations: ["generate", "edit"],
			capabilities: {
				aspectRatios: ["1:1", "16:9"],
				seed: true,
				maxCount: 2,
				maxReferenceImages: name === "alpha" ? 2 : 0,
				...(name === "alpha" && {
					mask: 0.85,
					guide: {
						kinds: ["outlines", "pose", "depth"],
						makesMaps: ["outlines"],
						strength: 0.75,
					},
				}),
				// Like FLUX, it reads prompts in English.
				...(name === "beta" && { englishPrompts: true }),
			},
			pricing: { usdPerOutput: 0.01 },
		}));
	}

	/** The key each job was sent with. */
	keysUsed: (string | undefined)[] = [];

	async submit(
		request: ProviderRequest,
		ctx?: ProviderContext,
	): Promise<FakeHandle> {
		this.keysUsed.push(ctx?.apiKey);
		const handle = {
			model: request.model.id,
			prompt: request.params.prompt,
			count: request.params.count,
			aspectRatio: request.params.aspectRatio,
			...(request.mask && { mask: request.mask.data }),
			...(request.guide && { guide: request.guide.data }),
		};
		this.submitted.push(handle);
		return handle;
	}

	async *events(
		handle: FakeHandle,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		// Halfway, it shows the first picture as it stands, as local models do.
		yield {
			type: "progress",
			fraction: 0.5,
			preview: {
				data: swatch(`${handle.model} ${handle.prompt} 0`, handle.aspectRatio),
				mime: "image/bmp",
			},
		};
		const waits: Promise<void>[] = [];
		if (this.gate) waits.push(this.gate);
		if (this.delayMs > 0) waits.push(Bun.sleep(this.delayMs));
		await Promise.race([
			Promise.all(waits),
			new Promise<never>((_, reject) => {
				if (ctx.signal.aborted) reject(ctx.signal.reason);
				ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
			}),
		]);
		const failure = this.failures.shift();
		if (failure) {
			yield failure;
			return;
		}
		if (this.failWith) {
			yield { type: "failed", error: this.failWith };
			return;
		}
		if (this.outputUrl) {
			yield { type: "completed", outputs: [{ url: this.outputUrl }] };
			return;
		}
		yield {
			type: "completed",
			outputs: Array.from({ length: handle.count }, (_, index) => ({
				data: swatch(
					`${handle.model} ${handle.prompt} ${index}`,
					handle.aspectRatio,
				),
				mime: "image/bmp",
			})),
		};
	}

	async cancel(handle: FakeHandle): Promise<void> {
		this.canceled.push(handle);
	}
}
