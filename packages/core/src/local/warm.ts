import type { ProviderEvent } from "../provider";
import type { GpuHold, GpuLock } from "./gpu";
import type { Spawn } from "./provider";

/**
 * Keeps a local model loaded between pictures by running the engine as a
 * server (stable-diffusion.cpp's `sd-server`) instead of once per picture.
 * Loading a model takes seconds; with it loaded, SDXL Turbo makes a picture
 * in under half a second instead of about five.
 *
 * One model is loaded at a time, and its memory stays reserved on the GPU
 * lock while it is. The server stops after a while unused, or as soon as
 * another job waits for that memory, to give it back.
 */

/** How long a loaded model waits for another job before it is unloaded. */
export const IDLE_MS = 10 * 60_000;
/** How long a model may take to load before the server is given up on. */
const START_TIMEOUT_MS = 5 * 60_000;
/** How long a job waits for an unloaded model's engine to exit. */
const EXIT_WAIT_MS = 5_000;
const POLL_MS = 250;

/** A request the server understands: `/sdcpp/v1/img_gen` or `vid_gen`. */
export interface WarmRequest {
	video: boolean;
	prompt: string;
	negativePrompt?: string;
	width: number;
	height: number;
	seed: number;
	steps: number;
	cfgScale: number;
	sampler?: string;
	flowShift?: number;
	frames?: number;
	fps?: number;
	/** Steps between pictures shown while it forms; none when absent. */
	previewInterval?: number;
	/** The picture to redraw, base64. */
	initImage?: string;
	/** Pictures the model follows, base64. */
	refImages?: string[];
	/** What of the redrawn picture to change, base64: white is redrawn. */
	maskImage?: string;
	/** How much the redrawn picture changes, 0 to 1. */
	strength?: number;
}

interface Running {
	key: string;
	url: string;
	stop(): void;
	exited: Promise<number>;
}

interface JobStatus {
	status: "queued" | "generating" | "completed" | "failed" | "cancelled";
	progress?: {
		completed?: number | null;
		total?: number | null;
		unit?: string;
	};
	preview?: { step?: number; b64_json?: string } | null;
	result?: {
		images?: { b64_json: string }[];
		b64_json?: string;
		mime_type?: string;
	} | null;
	error?: { code?: string; message?: string } | null;
}

export interface WarmEnginesOptions {
	spawn: Spawn;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** A free loopback port for a new server. */
	freePort?: () => Promise<number>;
	idleMs?: number;
	/** Reserves the GPU's memory a loaded model takes. */
	gpu?: GpuLock;
	/** How long a job waits for an unloaded model's engine to exit. */
	exitWaitMs?: number;
}

async function freeLoopbackPort(): Promise<number> {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	probe.stop(true);
	return port as number;
}

export class WarmEngines {
	private running: Running | null = null;
	private starting: Promise<Running> | null = null;
	private idle: ReturnType<typeof setTimeout> | undefined;
	private spawn: Spawn;
	private fetch: (url: string, init?: RequestInit) => Promise<Response>;
	private freePort: () => Promise<number>;
	private idleMs: number;
	private gpu: GpuLock | undefined;
	private hold: GpuHold | null = null;
	/** The GPU memory the loaded model holds. */
	private held = 0;
	/** Jobs running or about to: a busy model is not given back. */
	private busy = 0;
	/** Engines told to stop and not yet exited, with the memory each held. */
	private exiting = new Map<Promise<number>, number>();
	/** Those of them that did not exit within the wait. */
	private overdue = new Set<Promise<number>>();
	private exitWaitMs: number;

	constructor(options: WarmEnginesOptions) {
		this.spawn = options.spawn;
		this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.freePort = options.freePort ?? freeLoopbackPort;
		this.idleMs = options.idleMs ?? IDLE_MS;
		this.gpu = options.gpu;
		this.exitWaitMs = options.exitWaitMs ?? EXIT_WAIT_MS;
	}

	/** Whether no job is running on the loaded model. */
	get unused(): boolean {
		return this.busy === 0;
	}

	/** The model loaded now, by the key it was started with. */
	get loaded(): string | null {
		return this.running?.key ?? null;
	}

	/**
	 * A server with `key`'s model loaded, started from `argv` (the server
	 * program and its model options) if it is not running already.
	 */
	private async server(
		key: string,
		argv: string[],
		signal: AbortSignal,
	): Promise<Running> {
		if (this.running?.key === key) return this.running;
		if (this.starting) await this.starting.catch(() => {});
		if (this.running?.key === key) return this.running;
		// Another model: unload it, keeping the memory reserved for this one.
		this.running?.stop();
		this.running = null;
		this.starting = this.start(key, argv, signal);
		try {
			this.running = await this.starting;
			return this.running;
		} finally {
			this.starting = null;
		}
	}

	private async start(
		key: string,
		argv: string[],
		signal: AbortSignal,
	): Promise<Running> {
		const port = await this.freePort();
		const child = this.spawn([
			...argv,
			"--listen-ip",
			"127.0.0.1",
			"--listen-port",
			String(port),
		]);
		const url = `http://127.0.0.1:${port}`;
		const tail: string[] = [];
		let up = false;
		// Reads the output so the pipe never fills, and learns when it listens.
		const reading = (async () => {
			for await (const line of child.output) {
				if (line.trim()) tail.push(line.trim());
				if (tail.length > 20) tail.shift();
				if (/listening on/i.test(line)) up = true;
			}
		})();
		reading.catch(() => {});
		let exited = false;
		void child.exited.then(() => {
			exited = true;
			// This server, not a newer one for the same model.
			if (this.running?.exited === child.exited) this.stop();
		});
		const started = Date.now();
		while (!up) {
			if (exited || signal.aborted || Date.now() - started > START_TIMEOUT_MS) {
				child.kill();
				const reason =
					tail.filter((l) => /error|fail/i.test(l)).at(-1) ??
					(signal.aborted ? "canceled" : "the engine server did not start");
				throw new Error(reason.replace(/^\[\w\]\s*/, ""));
			}
			await Bun.sleep(POLL_MS);
		}
		return { key, url, stop: () => child.kill(), exited: child.exited };
	}

	/** Unloads the model, freeing the GPU's memory. */
	stop(): void {
		clearTimeout(this.idle);
		if (this.running) {
			const { exited } = this.running;
			this.exiting.set(exited, this.held);
			void exited.then(() => {
				this.exiting.delete(exited);
				this.overdue.delete(exited);
			});
			this.running.stop();
		}
		this.running = null;
		this.hold?.release();
		this.hold = null;
		this.held = 0;
	}

	/**
	 * Waits a moment for the engines of unloaded models to exit, and resolves
	 * to the GPU memory those still running hold: until an engine exits, the
	 * memory it held is not free, though it is no longer reserved.
	 */
	async unloading(signal?: AbortSignal): Promise<number> {
		signal?.throwIfAborted();
		// An engine already waited for in vain is not waited for again.
		const exits = [...this.exiting.keys()].filter((e) => !this.overdue.has(e));
		if (exits.length > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let abort = () => {};
			await Promise.race([
				Promise.allSettled(exits),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, this.exitWaitMs);
					abort = resolve;
					signal?.addEventListener("abort", abort, { once: true });
				}),
			]);
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			signal?.throwIfAborted();
			for (const exit of exits) {
				if (this.exiting.has(exit)) this.overdue.add(exit);
			}
		}
		return this.unloadedBytes;
	}

	/** The GPU memory engines of unloaded models hold until they exit. */
	private get unloadedBytes(): number {
		let bytes = 0;
		for (const held of this.exiting.values()) bytes += held;
		return bytes;
	}

	/** Unloads the model and resolves once its engine has exited. */
	async stopAndWait(): Promise<void> {
		const running = this.running;
		this.stop();
		await running?.exited;
	}

	/**
	 * Runs one job on the server for `key`, starting it with `argv` if needed;
	 * the model takes `bytes` of the GPU's memory. Throws if the server cannot
	 * be started, so the caller can fall back to running the engine once.
	 */
	async *run(
		key: string,
		argv: string[],
		request: WarmRequest,
		signal: AbortSignal,
		bytes = 0,
		/**
		 * Runs once this job holds the GPU's memory and is about to load its
		 * model, given the bytes the model unloaded for it was holding.
		 */
		acquired?: (released: number) => AsyncIterable<ProviderEvent>,
	): AsyncIterable<ProviderEvent> {
		clearTimeout(this.idle);
		this.busy++;
		try {
			// A job waiting for the GPU that would fit without this model goes
			// first, even if this job could run on it: it would wait forever
			// behind a stream of pictures otherwise.
			if (this.running?.key !== key || this.gpu?.wanted(this.held)) {
				// The loaded model's memory goes back before this one's is asked,
				// and its engine has exited before this one's model loads.
				this.stop();
				await this.unloading(signal);
				if (this.gpu) {
					this.hold = yield* this.gpu.acquire(bytes, signal, {
						onWanted: () => {
							if (this.busy === 0) this.stop();
						},
					});
					this.held = bytes;
				}
				// Counted again: an engine may have exited while this job waited.
				if (acquired) yield* acquired(this.unloadedBytes);
				yield {
					type: "progress",
					message: "Loading the model",
					stage: "loading",
				};
			}
			let server: Running;
			try {
				server = await this.server(key, argv, signal);
			} catch (error) {
				// The caller runs the engine once instead, reserving for itself.
				this.stop();
				throw error;
			}
			yield* this.job(server, request, signal);
		} finally {
			this.busy--;
			clearTimeout(this.idle);
			if (this.running) {
				this.idle = setTimeout(() => this.stop(), this.idleMs);
			} else if (this.busy === 0) {
				// Ended before its server ran: nothing holds the memory for.
				this.stop();
			}
		}
	}

	private async *job(
		server: Running,
		request: WarmRequest,
		signal: AbortSignal,
	): AsyncIterable<ProviderEvent> {
		const body = {
			prompt: request.prompt,
			negative_prompt: request.negativePrompt ?? "",
			width: request.width,
			height: request.height,
			seed: request.seed,
			sample_params: {
				sample_steps: request.steps,
				guidance: { txt_cfg: request.cfgScale },
				...(request.sampler && { sample_method: request.sampler }),
				...(request.flowShift != null && { flow_shift: request.flowShift }),
			},
			...(request.video
				? {
						video_frames: request.frames,
						fps: request.fps,
						output_format: "webm",
					}
				: { batch_count: 1, output_format: "png" }),
			...(request.initImage != null && { init_image: request.initImage }),
			...(request.refImages?.length && { ref_images: request.refImages }),
			...(request.maskImage != null && { mask_image: request.maskImage }),
			...(request.strength != null && { strength: request.strength }),
			// Only these two forms are known to work: an object here stops the
			// server altogether.
			...(request.previewInterval != null && {
				preview: "vae",
				preview_interval: request.previewInterval,
			}),
		};
		const submitted = await this.fetch(
			`${server.url}/sdcpp/v1/${request.video ? "vid_gen" : "img_gen"}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		if (!submitted.ok) {
			throw new Error(`The engine refused the job (HTTP ${submitted.status})`);
		}
		const { id } = (await submitted.json()) as { id: string };
		const cancel = () =>
			void this.fetch(`${server.url}/sdcpp/v1/jobs/${id}/cancel`, {
				method: "POST",
			}).catch(() => {});
		signal.addEventListener("abort", cancel, { once: true });
		try {
			let last = -1;
			let lastPreview = -1;
			for (;;) {
				if (signal.aborted) return;
				const response = await this.fetch(`${server.url}/sdcpp/v1/jobs/${id}`);
				const job = (await response.json()) as JobStatus;
				const { completed, total, unit } = job.progress ?? {};
				const shown = job.preview?.b64_json && job.preview.step !== lastPreview;
				if (
					job.status === "generating" &&
					unit === "steps" &&
					total &&
					completed != null &&
					(completed !== last || shown)
				) {
					last = completed;
					if (shown) lastPreview = job.preview?.step ?? lastPreview;
					yield {
						type: "progress",
						fraction: Math.min(1, completed / total),
						message: "Generating",
						stage: "generating",
						step: Math.min(completed, total),
						steps: total,
						...(shown && {
							preview: {
								data: Uint8Array.from(
									Buffer.from(job.preview?.b64_json ?? "", "base64"),
								),
								mime: "image/png",
							},
						}),
					};
				}
				if (job.status === "completed") {
					const encoded = request.video
						? job.result?.b64_json
						: job.result?.images?.[0]?.b64_json;
					if (!encoded) {
						yield {
							type: "failed",
							error: "The engine produced no result",
							code: "engineNoResult",
						};
						return;
					}
					yield {
						type: "completed",
						outputs: [
							{
								data: Uint8Array.from(Buffer.from(encoded, "base64")),
								mime: request.video
									? (job.result?.mime_type ?? "video/webm")
									: "image/png",
							},
						],
						costUsd: 0,
					};
					return;
				}
				if (job.status === "failed") {
					const reason = job.error?.message ?? "unknown error";
					yield {
						type: "failed",
						error: `The engine stopped: ${reason}`,
						code: "engineStopped",
						params: { reason },
						// As when the engine runs once: worth one more try.
						retry: { attempts: 2 },
					};
					return;
				}
				if (job.status === "cancelled") return;
				await Bun.sleep(POLL_MS);
			}
		} finally {
			signal.removeEventListener("abort", cancel);
		}
	}
}
