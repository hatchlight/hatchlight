import {
	copyFile,
	link,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { freemem } from "node:os";
import { join } from "node:path";
import { CodedError, describeError, ValidationError } from "../errors";
import type {
	TrainerEvent,
	TrainerInstallStep,
	TrainerStatus,
	TrainingStage,
	TrainingView,
} from "../types";
import type { GpuLock } from "./gpu";
import type { LoraShelf } from "./loras";
import { extractZip } from "./zip";

/**
 * Trains LoRAs on this computer with kohya's sd-scripts (Apache-2.0), in a
 * Python environment of its own that `uv` sets up. Everything is pinned:
 * the scripts' commit, PyTorch and the Python version, so every install is
 * the one that was tried. Only SDXL LoRAs for now.
 */

/** Changes whenever what an install puts in place changes. */
const TRAINER_VERSION = "sd-scripts-cb70b96+torch-2.14.1-cu130+py3.11";

const SCRIPTS = {
	url: "https://github.com/kohya-ss/sd-scripts/archive/cb70b96858477e716a2096292ab8aab433277f38.zip",
	sha256: "13587ab358c5ecb878a991a391ca924cb37ff1d427805b1476f41bbf23fcc493",
	size: 6_689_584,
};

const UV: Record<
	"linux" | "win32",
	{ url: string; sha256: string; size: number }
> = {
	linux: {
		url: "https://github.com/astral-sh/uv/releases/download/0.9.30/uv-x86_64-unknown-linux-gnu.tar.gz",
		sha256: "8b3762374972daa7a74bbc6896cc73229ca69a07403dd9f9ea3805a51ffd7582",
		size: 22_237_571,
	},
	win32: {
		url: "https://github.com/astral-sh/uv/releases/download/0.9.30/uv-x86_64-pc-windows-msvc.zip",
		sha256: "875981be7908295937dee09532bb66d576986d4f223259e171b0c767c885897a",
		size: 21_763_186,
	},
};

const PYTHON = "3.11";
/** PyTorch built for CUDA 13.0, from PyTorch's own index. */
const TORCH = ["torch==2.14.1+cu130", "torchvision==0.29.1+cu130"];
const TORCH_INDEX = "https://download.pytorch.org/whl/cu130";

/** About what an install downloads: PyTorch with CUDA is most of it. */
export const TRAINER_DOWNLOAD_BYTES = 6 * 1024 ** 3;

/**
 * What training holds of the GPU: more than any card has, so it runs alone.
 * SDXL training peaks near 7.2 GB, and nothing else fits beside it.
 */
const TRAINING_GPU_BYTES = Number.MAX_SAFE_INTEGER;
/** Below this much free system memory, training stops before all freezes. */
export const MIN_FREE_MEMORY_BYTES = 1.5 * 1024 ** 3;
const MEMORY_CHECK_MS = 5000;
/** Progress is told at most this often; the trainer prints far more. */
const PROGRESS_MS = 1000;

export const MIN_TRAINING_PICTURES = 3;
export const MAX_TRAINING_PICTURES = 200;
export const MIN_TRAINING_STEPS = 100;
export const MAX_TRAINING_STEPS = 4000;
export const DEFAULT_TRAINING_STEPS = 800;

/** Starts a program; tests replace it with a fake one. */
export type RunProgram = (
	argv: string[],
	options: { cwd?: string; env?: Record<string, string> },
) => {
	output: AsyncIterable<string>;
	exited: Promise<number>;
	kill(): void;
};

export const runProgram: RunProgram = (argv, options) => {
	const child = Bun.spawn(argv, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	async function* lines() {
		const queue: string[] = [];
		const waiting: { wake: (() => void) | null } = { wake: null };
		let open = 2;
		for (const stream of [child.stdout, child.stderr]) {
			void (async () => {
				let rest = "";
				try {
					for await (const text of stream.pipeThrough(
						new TextDecoderStream(),
					)) {
						// Progress bars redraw with carriage returns.
						const parts = (rest + text).split(/[\r\n]/);
						rest = parts.pop() ?? "";
						queue.push(...parts);
						waiting.wake?.();
					}
				} catch {
					// A stream that broke has nothing more to say.
				}
				if (rest) queue.push(rest);
				open--;
				waiting.wake?.();
			})();
		}
		while (open > 0 || queue.length > 0) {
			const line = queue.shift();
			if (line != null) {
				yield line;
				continue;
			}
			await new Promise<void>((resolve) => {
				waiting.wake = resolve;
			});
			waiting.wake = null;
		}
	}
	return {
		output: lines(),
		exited: child.exited,
		kill: () => {
			// Never a process that has ended: Windows gives its number to others.
			if (child.exitCode != null || child.signalCode != null) return;
			// On Windows the scripts' own children go too.
			if (process.platform === "win32") {
				Bun.spawn(["taskkill", "/T", "/F", "/PID", String(child.pid)], {
					stdout: "ignore",
					stderr: "ignore",
				});
			} else child.kill();
		},
	};
};

/** System memory free to use: on Linux what the kernel can give back too. */
export async function freeMemory(): Promise<number> {
	if (process.platform === "linux") {
		const info = await readFile("/proc/meminfo", "utf8").catch(() => "");
		const kb = info.match(/MemAvailable:\s+(\d+)/)?.[1];
		if (kb) return Number(kb) * 1024;
	}
	return freemem();
}

/** The model a LoRA is trained on. */
export interface BaseModel {
	file: string;
	/** A folder on the same disk as `file`, where a link to it can go. */
	scratch: string;
}

/** What a training is asked to learn. */
export interface TrainingRequest {
	/** The LoRA's name, as people will see it. */
	name: string;
	/** A made-up word that calls the subject or style up in a prompt. */
	trigger: string;
	pictures: { data: Uint8Array; extension: string; caption: string }[];
	steps: number;
}

export interface TrainerOptions {
	/** Where the trainer is installed. */
	dir: string;
	platform?: NodeJS.Platform;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	run?: RunProgram;
	gpu: GpuLock;
	loras: LoraShelf;
	/**
	 * The SDXL file to train on, and a folder on its disk for a link to it;
	 * throws when it is not installed.
	 */
	baseModel: () => Promise<BaseModel>;
	/** System memory free now. */
	freeMemory?: () => Promise<number>;
	memoryCheckMs?: number;
}

/** A plain word: it goes in captions and prompts, and is read back as a tag. */
const TRIGGER = /^[\p{L}\p{N}_-]{2,40}$/u;

/** "01:23" or "1:02:03" in seconds. */
function seconds(text: string): number | null {
	const parts = text.split(":").map(Number);
	if (parts.some((n) => Number.isNaN(n))) return null;
	return parts.reduce((total, n) => total * 60 + n, 0);
}

/** The end of the run of `allowed` characters that starts at `from`. */
function runEnd(line: string, from: number, allowed: string): number {
	let end = from;
	while (end < line.length && allowed.includes(line[end] ?? "")) end++;
	return end;
}

const DIGITS = "0123456789";

/**
 * Reads " 80/800 [01:00<09:00" right after a "|": the step, the steps and the
 * time left. Scanned by hand, so a long line cannot make it slow.
 */
function countsAt(
	line: string,
	from: number,
): [step: string, steps: string, left: string] | null {
	let at = runEnd(line, from, " \t");
	const stepEnd = runEnd(line, at, DIGITS);
	if (stepEnd === at || line[stepEnd] !== "/") return null;
	const step = line.slice(at, stepEnd);
	at = stepEnd + 1;
	const stepsEnd = runEnd(line, at, DIGITS);
	if (stepsEnd === at) return null;
	const steps = line.slice(at, stepsEnd);
	at = runEnd(line, stepsEnd, " \t");
	if (line[at] !== "[") return null;
	const spentEnd = runEnd(line, at + 1, `${DIGITS}:`);
	if (spentEnd === at + 1 || line[spentEnd] !== "<") return null;
	const leftEnd = runEnd(line, spentEnd + 1, `${DIGITS}:?`);
	if (leftEnd === spentEnd + 1) return null;
	return [step, steps, line.slice(spentEnd + 1, leftEnd)];
}

/** The counts after the first "steps:", trying each "|" in turn. */
function stepsBar(line: string): [string, string, string] | null {
	const start = line.indexOf("steps:");
	if (start < 0) return null;
	for (
		let bar = line.indexOf("|", start);
		bar >= 0;
		bar = line.indexOf("|", bar + 1)
	) {
		const counts = countsAt(line, bar + 1);
		if (counts) return counts;
	}
	return null;
}

/** Reads "steps:  10%|█  | 80/800 [01:00<09:00, 1.33it/s, …]". */
export function trainingProgress(
	line: string,
): { step: number; steps: number; secondsLeft: number | null } | null {
	const bar = stepsBar(line);
	if (!bar) return null;
	const [step, total, left] = bar;
	const steps = Number(total);
	if (!(steps > 0)) return null;
	return {
		step: Math.min(Number(step), steps),
		steps,
		secondsLeft: left.includes("?") ? null : seconds(left),
	};
}

/** What the trainer is doing, from a line it printed, if the line says. */
export function trainingStage(line: string): TrainingStage | null {
	if (/caching (latents|text encoder)/i.test(line)) return "caching";
	if (/saving (model|checkpoint)|model saved/i.test(line)) return "saving";
	if (/loading|load (state dict|vae|unet|text encoder)|building/i.test(line)) {
		return "loading";
	}
	return null;
}

/** A TOML string: JSON's escapes are TOML's for the characters paths have. */
const toml = (text: string) => JSON.stringify(text);

export class Trainer {
	private options: Required<
		Omit<TrainerOptions, "platform" | "memoryCheckMs">
	> & { platform: NodeJS.Platform; memoryCheckMs: number };
	private listeners = new Set<(event: TrainerEvent) => void>();
	private installing: {
		step: TrainerInstallStep;
		receivedBytes: number | null;
		totalBytes: number | null;
		controller: AbortController;
	} | null = null;
	private installError: TrainerStatus["error"] = null;
	private ready: boolean | null = null;
	private training: TrainingView | null = null;
	private trainingController: AbortController | null = null;
	/** A training is being checked and set up: nothing else may start. */
	private starting = false;
	private lastEmit = 0;
	private pending: ReturnType<typeof setTimeout> | null = null;

	constructor(options: TrainerOptions) {
		this.options = {
			platform: process.platform,
			fetch: globalThis.fetch,
			run: runProgram,
			freeMemory,
			memoryCheckMs: MEMORY_CHECK_MS,
			...options,
		};
		// Pictures of a training that a closed app left behind.
		void rm(this.path("runs"), { recursive: true, force: true }).catch(
			() => {},
		);
	}

	subscribe(listener: (event: TrainerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private get windows(): boolean {
		return this.options.platform === "win32";
	}

	private path(...parts: string[]): string {
		return join(this.options.dir, ...parts);
	}

	private get python(): string {
		return this.windows
			? this.path("venv", "Scripts", "python.exe")
			: this.path("venv", "bin", "python");
	}

	private get scripts(): string {
		return this.path("sd-scripts");
	}

	/** Where uv keeps Python and its cache: inside the trainer, not the user's. */
	private get uvEnv(): Record<string, string> {
		return {
			UV_PYTHON_INSTALL_DIR: this.path("python"),
			UV_CACHE_DIR: this.path("cache"),
			UV_NO_CONFIG: "1",
			// Its own Python, never one of the system's that may change.
			UV_PYTHON_PREFERENCE: "only-managed",
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
		};
	}

	private async isReady(): Promise<boolean> {
		if (this.ready == null) {
			const marker = await Bun.file(this.path("ready.json"))
				.json()
				.catch(() => null);
			this.ready = marker?.version === TRAINER_VERSION;
		}
		return this.ready;
	}

	async status(): Promise<TrainerStatus> {
		return {
			state: this.installing
				? "installing"
				: (await this.isReady())
					? "ready"
					: "missing",
			install: this.installing && {
				step: this.installing.step,
				receivedBytes: this.installing.receivedBytes,
				totalBytes: this.installing.totalBytes,
			},
			error: this.installError,
			downloadBytes: TRAINER_DOWNLOAD_BYTES,
			training: this.training && { ...this.training },
		};
	}

	/** Tells listeners, at most once a second unless `now`. */
	private changed(now = false): void {
		const send = () => {
			this.pending = null;
			this.lastEmit = Date.now();
			void this.status().then((trainer) => {
				for (const listener of this.listeners) {
					try {
						listener({ type: "trainer.changed", trainer });
					} catch (error) {
						console.error("A trainer listener failed", error);
					}
				}
			});
		};
		if (now || Date.now() - this.lastEmit >= PROGRESS_MS) {
			if (this.pending) clearTimeout(this.pending);
			send();
		} else if (!this.pending) {
			this.pending = setTimeout(send, PROGRESS_MS);
		}
	}

	/** Downloads a pinned file and checks it, into `path`. */
	private async download(
		file: { url: string; sha256: string; size: number },
		path: string,
		signal: AbortSignal,
	): Promise<void> {
		const name = file.url.split("/").at(-1) ?? file.url;
		const response = await this.options
			.fetch(file.url, { signal })
			.catch((error) => {
				if (signal.aborted) throw error;
				// Offline, or the name did not resolve.
				throw new CodedError(
					`Could not download ${name}: ${error instanceof Error ? error.message : error}`,
					"noConnection",
				);
			});
		if (!response.ok || !response.body) {
			throw new CodedError(
				`Could not download the trainer (HTTP ${response.status})`,
				"downloadFailed",
				{
					file: file.url.split("/").at(-1) ?? file.url,
					status: response.status,
				},
			);
		}
		const part = `${path}.part`;
		const writer = Bun.file(part).writer();
		const hasher = new Bun.CryptoHasher("sha256");
		let received = 0;
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				received += chunk.byteLength;
				if (received > file.size) {
					throw new CodedError(
						"The download is larger than expected",
						"downloadTooLarge",
						{
							file: file.url.split("/").at(-1) ?? file.url,
						},
					);
				}
				hasher.update(chunk);
				writer.write(chunk);
				if (this.installing) {
					this.installing.receivedBytes = received;
					this.installing.totalBytes = file.size;
				}
				this.changed();
			}
		} finally {
			await writer.end();
		}
		if (hasher.digest("hex") !== file.sha256) {
			await rm(part, { force: true });
			throw new CodedError(
				"The trainer did not match its expected hash",
				"hashMismatch",
				{
					file: file.url.split("/").at(-1) ?? file.url,
				},
			);
		}
		await rename(part, path);
	}

	/** Runs a step of the install; its output is kept for when it fails. */
	private async step(
		argv: string[],
		signal: AbortSignal,
		cwd?: string,
	): Promise<void> {
		signal.throwIfAborted();
		const child = this.options.run(argv, { cwd, env: this.uvEnv });
		const stop = () => child.kill();
		signal.addEventListener("abort", stop, { once: true });
		const tail: string[] = [];
		try {
			for await (const line of child.output) {
				if (line.trim()) tail.push(line.trim());
				if (tail.length > 20) tail.shift();
			}
			const code = await child.exited;
			signal.throwIfAborted();
			if (code !== 0) {
				const reason =
					tail
						.filter((l) => /error|fail|not found|no matching/i.test(l))
						.at(-1) ??
					tail.at(-1) ??
					`it stopped with code ${code}`;
				throw new CodedError(
					`Installing the trainer failed: ${reason}`,
					"trainerInstallFailed",
					{ reason, exitCode: code },
				);
			}
		} finally {
			signal.removeEventListener("abort", stop);
		}
	}

	/** Finds a program by name below `dir`. */
	private async find(dir: string, name: string): Promise<string | null> {
		for (const entry of await readdir(dir, { recursive: true }).catch(
			() => [] as string[],
		)) {
			if (entry.split(/[\\/]/).at(-1) === name) return join(dir, entry);
		}
		return null;
	}

	/**
	 * Installs the trainer: uv, the training scripts, Python and PyTorch,
	 * then checks PyTorch can use the graphics card. Progress arrives as
	 * events; this resolves once it started.
	 */
	async install(): Promise<void> {
		if (
			this.installing ||
			this.starting ||
			this.training?.state === "running"
		) {
			throw new ValidationError("The trainer is busy", "trainerBusy");
		}
		if (process.arch !== "x64") {
			throw new ValidationError(
				"The trainer runs on 64-bit Intel and AMD processors only",
				"trainerNoCuda",
			);
		}
		const platform = this.windows
			? "win32"
			: this.options.platform === "linux"
				? "linux"
				: null;
		if (!platform) {
			throw new ValidationError(
				"The trainer runs on Windows and Linux only",
				"trainerNoCuda",
			);
		}
		const controller = new AbortController();
		this.installing = {
			step: "uv",
			receivedBytes: null,
			totalBytes: null,
			controller,
		};
		this.installError = null;
		this.ready = false;
		this.changed(true);
		void this.installNow(platform, controller.signal)
			.then(() => {
				this.ready = true;
			})
			.catch(async (error) => {
				if (!controller.signal.aborted) {
					this.installError = describeError(error);
				}
				// Gigabytes a failed install would leave behind.
				for (const dir of ["cache", "downloads"]) {
					await rm(this.path(dir), { recursive: true, force: true }).catch(
						() => {},
					);
				}
			})
			.finally(() => {
				this.installing = null;
				this.changed(true);
			});
	}

	private setStep(step: TrainerInstallStep): void {
		if (!this.installing) return;
		this.installing.step = step;
		this.installing.receivedBytes = null;
		this.installing.totalBytes = null;
		this.changed(true);
	}

	private async installNow(
		platform: "linux" | "win32",
		signal: AbortSignal,
	): Promise<void> {
		const dir = this.options.dir;
		await rm(this.path("ready.json"), { force: true });
		await Bun.write(this.path("downloads", ".keep"), "");

		// uv, which sets up Python and installs the packages.
		const uvArchive = this.path(
			"downloads",
			platform === "win32" ? "uv.zip" : "uv.tar.gz",
		);
		await this.download(UV[platform], uvArchive, signal);
		await rm(this.path("uv"), { recursive: true, force: true });
		if (platform === "win32") await extractZip(uvArchive, this.path("uv"));
		else {
			await Bun.write(this.path("uv", ".keep"), "");
			await this.step(
				["tar", "-xzf", uvArchive, "-C", this.path("uv")],
				signal,
			);
		}
		const uv = await this.find(
			this.path("uv"),
			platform === "win32" ? "uv.exe" : "uv",
		);
		if (!uv) {
			throw new CodedError(
				"uv was not in its archive",
				"trainerInstallFailed",
				{
					reason: "uv was not in its archive",
				},
			);
		}

		// The training scripts, at the commit that was tried.
		this.setStep("scripts");
		const scriptsArchive = this.path("downloads", "sd-scripts.zip");
		await this.download(SCRIPTS, scriptsArchive, signal);
		const unpacked = this.path("sd-scripts.tmp");
		await rm(unpacked, { recursive: true, force: true });
		await extractZip(scriptsArchive, unpacked);
		const [top] = await readdir(unpacked);
		if (!top) {
			throw new CodedError(
				"The training scripts' archive was empty",
				"trainerInstallFailed",
				{
					reason: "empty archive",
				},
			);
		}
		await rm(this.scripts, { recursive: true, force: true });
		await rename(join(unpacked, top), this.scripts);
		await rm(unpacked, { recursive: true, force: true });

		// Python, in an environment of the trainer's own.
		this.setStep("python");
		await rm(this.path("venv"), { recursive: true, force: true });
		await this.step(
			[uv, "venv", "--python", PYTHON, this.path("venv")],
			signal,
			dir,
		);

		// PyTorch for the graphics card, and what the scripts need.
		this.setStep("packages");
		await this.step(
			[
				uv,
				"pip",
				"install",
				"--python",
				this.python,
				"-r",
				"requirements.txt",
				...TORCH,
				"--extra-index-url",
				TORCH_INDEX,
				"--index-strategy",
				"unsafe-best-match",
			],
			signal,
			this.scripts,
		);
		// The downloads are installed now; gigabytes not worth keeping.
		await rm(this.path("cache"), { recursive: true, force: true });
		await rm(this.path("downloads"), { recursive: true, force: true });

		// Training on the processor would take days: refuse it.
		this.setStep("checking");
		try {
			await this.step(
				[
					this.python,
					"-c",
					"import sys, torch; sys.exit(0 if torch.cuda.is_available() else 3)",
				],
				signal,
			);
		} catch (error) {
			// Only its own answer means no card; anything else is a broken install.
			if (
				signal.aborted ||
				!(error instanceof CodedError) ||
				error.params.exitCode !== 3
			) {
				throw error;
			}
			throw new CodedError(
				"PyTorch cannot use a graphics card here",
				"trainerNoCuda",
			);
		}
		await Bun.write(
			this.path("ready.json"),
			JSON.stringify({ version: TRAINER_VERSION, installedAt: Date.now() }),
		);
	}

	/** Stops an install in progress; what it put in place is removed on the next one. */
	cancelInstall(): void {
		this.installing?.controller.abort();
	}

	/** Deletes the trainer. */
	async remove(): Promise<void> {
		if (this.installing || this.training?.state === "running") {
			throw new ValidationError("The trainer is busy", "trainerBusy");
		}
		await rm(this.options.dir, { recursive: true, force: true });
		this.ready = false;
		this.installError = null;
		this.changed(true);
	}

	/** Starts training a LoRA; progress arrives as events. */
	/** Throws unless a training could start now; cheap, before reading pictures. */
	async assertCanTrain(): Promise<void> {
		if (!(await this.isReady())) {
			throw new ValidationError("Install the trainer first", "trainerMissing");
		}
		if (
			this.starting ||
			this.training?.state === "running" ||
			this.installing
		) {
			throw new ValidationError("The trainer is busy", "trainerBusy");
		}
	}

	/** Starts training a LoRA; progress arrives as events. */
	async train(request: TrainingRequest): Promise<TrainingView> {
		await this.assertCanTrain();
		// Taken before anything is awaited, so two requests cannot both start.
		this.starting = true;
		try {
			return await this.start(request);
		} finally {
			this.starting = false;
		}
	}

	private async start(request: TrainingRequest): Promise<TrainingView> {
		const name = request.name.trim();
		const trigger = request.trigger.trim();
		if (!name || name.length > 80) {
			throw new ValidationError(
				"Give the LoRA a name of at most 80 characters",
				"trainingBadName",
				{ max: 80 },
			);
		}
		if (!TRIGGER.test(trigger)) {
			throw new ValidationError(
				"The trigger must be one word of 2 to 40 letters or digits",
				"trainingBadTrigger",
				{ min: 2, max: 40 },
			);
		}
		if (
			request.pictures.length < MIN_TRAINING_PICTURES ||
			request.pictures.length > MAX_TRAINING_PICTURES
		) {
			throw new ValidationError(
				`Training needs ${MIN_TRAINING_PICTURES} to ${MAX_TRAINING_PICTURES} pictures`,
				"trainingNeedsPictures",
				{ min: MIN_TRAINING_PICTURES, max: MAX_TRAINING_PICTURES },
			);
		}
		const steps = Math.round(request.steps);
		if (!(steps >= MIN_TRAINING_STEPS && steps <= MAX_TRAINING_STEPS)) {
			throw new ValidationError(
				`Steps must be between ${MIN_TRAINING_STEPS} and ${MAX_TRAINING_STEPS}`,
				"trainingBadSteps",
				{ min: MIN_TRAINING_STEPS, max: MAX_TRAINING_STEPS },
			);
		}
		const base = await this.options.baseModel();

		const id = crypto.randomUUID();
		const controller = new AbortController();
		this.trainingController = controller;
		this.training = {
			id,
			name,
			trigger,
			state: "running",
			stage: "waitingGpu",
			step: 0,
			steps,
			secondsLeft: null,
			startedAt: Date.now(),
			finishedAt: null,
			freeMemoryBytes: null,
			loraId: null,
			error: null,
		};
		this.changed(true);
		const view = this.training;
		void this.trainNow(
			view,
			{ ...request, name, trigger, steps },
			base,
			controller.signal,
		)
			.then((loraId) => {
				view.state = "done";
				view.loraId = loraId;
			})
			.catch((error) => {
				if (controller.signal.aborted) view.state = "canceled";
				else {
					view.state = "failed";
					view.error = describeError(error);
				}
			})
			.finally(() => {
				view.finishedAt = Date.now();
				view.secondsLeft = null;
				if (this.trainingController === controller)
					this.trainingController = null;
				this.changed(true);
			});
		return { ...view };
	}

	cancelTraining(): void {
		this.trainingController?.abort();
	}

	private async trainNow(
		view: TrainingView,
		request: TrainingRequest,
		base: BaseModel,
		signal: AbortSignal,
	): Promise<string> {
		const run = this.path("runs", view.id);
		try {
			// The pictures and their captions, the trigger first in each.
			const pictures = join(run, "dataset", "10_subject");
			for (const [i, picture] of request.pictures.entries()) {
				const file = join(pictures, String(i).padStart(3, "0"));
				await Bun.write(`${file}.${picture.extension}`, picture.data);
				const caption = picture.caption.replace(/\s+/g, " ").trim();
				await Bun.write(
					`${file}.txt`,
					caption ? `${request.trigger}, ${caption}` : request.trigger,
				);
			}
			await Bun.write(
				join(run, "dataset.toml"),
				[
					"[general]",
					'caption_extension = ".txt"',
					"shuffle_caption = false",
					"keep_tokens = 1",
					"",
					"[[datasets]]",
					"resolution = 1024",
					"batch_size = 1",
					"enable_bucket = true",
					"",
					"  [[datasets.subsets]]",
					`  image_dir = ${toml(pictures)}`,
					"  num_repeats = 10",
					"",
				].join("\n"),
			);

			// The whole graphics card: it runs only once nothing else does.
			const acquiring = this.options.gpu.acquire(TRAINING_GPU_BYTES, signal);
			let next = await acquiring.next();
			while (!next.done) next = await acquiring.next();
			const hold = next.value;
			try {
				// Found again: the models may have moved while it waited.
				const model = await this.named(
					await this.options.baseModel().catch(() => base),
					view.id,
					run,
				);
				try {
					return await this.runTraining(view, request, model.file, run, signal);
				} finally {
					if (model.made) await rm(model.file, { force: true }).catch(() => {});
				}
			} finally {
				hold.release();
			}
		} finally {
			await rm(run, { recursive: true, force: true }).catch(() => {});
		}
	}

	/**
	 * The model under a name ending in .safetensors: the scripts tell a
	 * file's format by its name, and the models are kept by their hash.
	 */
	private async named(
		base: BaseModel,
		id: string,
		run: string,
	): Promise<{ file: string; made: boolean }> {
		if (base.file.toLowerCase().endsWith(".safetensors")) {
			return { file: base.file, made: false };
		}
		// A hard link, on the model's own disk: the scripts follow a symbolic
		// link to the file's real name and would read it wrong.
		const linked = join(base.scratch, `train-${id}.safetensors`);
		try {
			await mkdir(base.scratch, { recursive: true });
			await link(base.file, linked);
			return { file: linked, made: true };
		} catch {
			// A disk without hard links: a copy, removed with the run.
			const copy = join(run, "base.safetensors");
			await copyFile(base.file, copy);
			return { file: copy, made: false };
		}
	}

	private async runTraining(
		view: TrainingView,
		request: TrainingRequest,
		base: string,
		run: string,
		signal: AbortSignal,
	): Promise<string> {
		view.stage = "loading";
		this.changed(true);
		const out = join(run, "out");
		const child = this.options.run(
			[
				this.python,
				"sdxl_train_network.py",
				"--pretrained_model_name_or_path",
				base,
				"--dataset_config",
				join(run, "dataset.toml"),
				"--output_dir",
				out,
				"--output_name",
				"lora",
				"--save_model_as",
				"safetensors",
				"--metadata_title",
				request.name,
				"--network_module",
				"networks.lora",
				"--network_dim",
				"16",
				"--network_alpha",
				"8",
				"--network_train_unet_only",
				"--learning_rate",
				"1e-4",
				"--optimizer_type",
				"AdamW8bit",
				"--lr_scheduler",
				"constant",
				"--max_train_steps",
				String(request.steps),
				"--mixed_precision",
				"bf16",
				// SDXL kept in 16 bits, and loaded straight into the GPU: in
				// 32 bits in system memory it filled 15 GB and froze WSL.
				"--full_bf16",
				"--lowram",
				"--save_precision",
				"fp16",
				"--no_half_vae",
				"--cache_latents",
				"--cache_text_encoder_outputs",
				"--gradient_checkpointing",
				"--sdpa",
				"--seed",
				"42",
				"--max_data_loader_n_workers",
				"0",
			],
			{ cwd: this.scripts, env: this.uvEnv },
		);
		let outOfMemory = false;
		const stop = () => child.kill();
		signal.addEventListener("abort", stop, { once: true });
		const watch = setInterval(async () => {
			const free = await this.options.freeMemory().catch(() => null);
			view.freeMemoryBytes = free;
			if (free != null && free < MIN_FREE_MEMORY_BYTES && !outOfMemory) {
				outOfMemory = true;
				child.kill();
			}
			this.changed();
		}, this.options.memoryCheckMs);
		const tail: string[] = [];
		try {
			for await (const line of child.output) {
				if (line.trim()) tail.push(line.trim());
				if (tail.length > 30) tail.shift();
				const progress = trainingProgress(line);
				if (progress) {
					view.stage = progress.step >= progress.steps ? "saving" : "training";
					view.step = progress.step;
					view.secondsLeft = progress.secondsLeft;
					this.changed();
					continue;
				}
				const stage = trainingStage(line);
				if (stage && !(view.stage === "training" && stage === "loading")) {
					view.stage = stage;
					this.changed();
				}
			}
			const code = await child.exited;
			signal.throwIfAborted();
			if (outOfMemory) {
				throw new CodedError(
					"Training stopped before the computer ran out of memory",
					"trainingOutOfMemory",
				);
			}
			if (code !== 0) {
				const reason =
					tail.filter((l) => /error|exception|out of memory/i.test(l)).at(-1) ??
					tail.at(-1) ??
					`it stopped with code ${code}`;
				throw new CodedError(`Training failed: ${reason}`, "trainingFailed", {
					reason,
				});
			}
		} finally {
			clearInterval(watch);
			signal.removeEventListener("abort", stop);
			child.kill();
		}
		view.stage = "saving";
		this.changed(true);
		const file = join(out, "lora.safetensors");
		if (!(await stat(file).catch(() => null))) {
			throw new CodedError("Training made no LoRA", "trainingFailed", {
				reason: "no file was written",
			});
		}
		const lora = await this.options.loras.add(
			Bun.file(file),
			`${request.name}.safetensors`,
		);
		return lora.id;
	}
}
