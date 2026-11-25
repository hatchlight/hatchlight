import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CheckpointShelf,
	DEFAULT_MASK_STRENGTH,
	DEFAULT_STRENGTH,
	dimensions,
	engineArguments,
	type GpuMemory,
	LinkedFolders,
	type LocalModelSpec,
	LocalProvider,
	type LocalRuntime,
	LoraShelf,
	loraPrompt,
	MAX_UPSCALE_INPUT,
	type ProviderEvent,
	previewInterval,
	redrawSteps,
	roleOption,
	type Spawn,
	samplingProgress,
	vramBudget,
} from "../index";

import { GpuLock } from "./gpu";
import { picture, safetensors } from "./testing";
import type { WarmRequest } from "./warm";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const params = (over: object = {}) => ({
	prompt: "a red fox",
	count: 1,
	referenceAssetIds: [],
	extras: {},
	...over,
});

const FLUX: LocalModelSpec = {
	id: "flux",
	name: "FLUX",
	author: "Example",
	media: "image",
	tasks: ["text-to-image"],
	summary: "",
	license: "MIT",
	licenseUrl: "https://license.example",
	commercial: { kind: "allowed" },
	homepage: "https://models.example",
	variants: [],
	demos: [],
	defaults: {
		size: 1024,
		aspectRatios: ["1:1", "16:9"],
		steps: 4,
		cfgScale: 1,
		sampler: "euler",
	},
};
const WAN: LocalModelSpec = {
	...FLUX,
	id: "wan",
	media: "video",
	tasks: ["text-to-video"],
	defaults: {
		size: 832,
		aspectRatios: ["16:9"],
		steps: 30,
		cfgScale: 6,
		flowShift: 3,
		fps: 16,
		durations: [2, 5],
		negativePrompt: "static",
	},
};

/** A model that only makes pictures larger. */
const UPSCALER: LocalModelSpec = {
	...FLUX,
	id: "upscaler",
	tasks: ["upscale"],
	defaults: {
		...FLUX.defaults,
		aspectRatios: [],
		steps: 1,
		references: { as: "init", max: 1 },
		upscale: 4,
	},
};

/** A picture model that can also redraw a picture. */
const REDRAW: LocalModelSpec = {
	...FLUX,
	tasks: ["text-to-image", "image-to-image"],
	defaults: { ...FLUX.defaults, references: { as: "init", max: 1 } },
};

const runtime = (
	model: LocalModelSpec,
	scratch = "/scratch",
	fit: LocalRuntime["fit"] = "gpu",
): LocalRuntime => ({
	model,
	variant: { id: "v", label: "v", engine: "sd", memoryBytes: 1, files: [] },
	build: {
		id: "b",
		engine: "sd",
		version: "1",
		backend: "cuda",
		os: "win32",
		arch: "x64",
		files: [],
		executable: "sd-cli.exe",
	},
	executable: "/engines/b/sd-cli.exe",
	throughWindows: true,
	fit,
	files:
		model.media === "video"
			? { diffusion_model: "/m/wan", t5xxl: "/m/t5", vae: "/m/vae" }
			: {
					diffusion_model: "/m/flux",
					t5xxl: "/m/t5",
					clip_l: "/m/clip",
					vae: "/m/ae",
				},
	scratch,
});
const windows = async (path: string) => `C:${path.replaceAll("/", "\\")}`;

describe("engine arguments", () => {
	test("sizes follow the ratio, in steps the model accepts", () => {
		expect(dimensions(1024, "1:1")).toEqual({ width: 1024, height: 1024 });
		expect(dimensions(1024, "16:9")).toEqual({ width: 1024, height: 576 });
		expect(dimensions(1024, "9:16")).toEqual({ width: 576, height: 1024 });
		expect(dimensions(832, "16:9", 16)).toEqual({ width: 832, height: 464 });
		expect(dimensions(512, undefined)).toEqual({ width: 512, height: 512 });
	});

	test("an image job names each file by its role, as Windows paths", async () => {
		const args = await engineArguments(
			runtime(FLUX),
			FLUX.defaults,
			params({ aspectRatio: "16:9", seed: 7 }),
			"/scratch/out.png",
			windows,
		);
		expect(args).toEqual([
			"-M",
			"img_gen",
			"--diffusion-model",
			"C:\\m\\flux",
			"--t5xxl",
			"C:\\m\\t5",
			"--clip_l",
			"C:\\m\\clip",
			"--vae",
			"C:\\m\\ae",
			"-p",
			"a red fox",
			"--steps",
			"4",
			"--cfg-scale",
			"1",
			"-W",
			"1024",
			"-H",
			"576",
			"-s",
			"7",
			"-o",
			"C:\\scratch\\out.png",
			"--sampling-method",
			"euler",
		]);
	});

	test("a video job asks for the frames its length needs", async () => {
		const args = await engineArguments(
			runtime(WAN),
			WAN.defaults,
			params({ durationSeconds: 5 }),
			"/scratch/out.webm",
			async (p) => p,
		);
		expect(args.slice(0, 2)).toEqual(["-M", "vid_gen"]);
		const after = (flag: string) => args[args.indexOf(flag) + 1];
		expect(after("--video-frames")).toBe("81");
		expect(after("--fps")).toBe("16");
		expect(after("--flow-shift")).toBe("3");
		expect(after("-n")).toBe("static");
		expect(after("-W")).toBe("832");
		// Without a ratio asked, the model's own first one, not a square.
		expect(after("-H")).toBe("464");
	});

	test("an editing model is given the pictures to follow, up to its limit", async () => {
		const edit: LocalModelSpec = {
			...FLUX,
			tasks: ["text-to-image", "image-edit"],
			defaults: {
				...FLUX.defaults,
				references: { as: "ref", max: 2 },
				engineArgs: ["--scheduler", "simple"],
			},
		};
		const args = await engineArguments(
			runtime(edit),
			edit.defaults,
			params(),
			"/o.png",
			async (p) => p,
			["/s/a.png", "/s/b.png", "/s/c.png"],
		);
		expect(args.slice(-6)).toEqual([
			"-r",
			"/s/a.png",
			"-r",
			"/s/b.png",
			"--scheduler",
			"simple",
		]);
	});

	test("an image-to-video model starts from the picture", async () => {
		const animate: LocalModelSpec = {
			...WAN,
			tasks: ["text-to-video", "image-to-video"],
			defaults: { ...WAN.defaults, references: { as: "init", max: 1 } },
		};
		const args = await engineArguments(
			runtime(animate),
			animate.defaults,
			params(),
			"/o.webm",
			async (p) => p,
			["/s/first.png"],
		);
		expect(args[args.indexOf("-i") + 1]).toBe("/s/first.png");
		expect(args).not.toContain("-r");
	});

	test("a picture model redraws its picture, as much as asked, at its size", async () => {
		const after = (args: string[], flag: string) =>
			args[args.indexOf(flag) + 1];
		const redraw = async (steps: number, strength?: number) =>
			engineArguments(
				runtime(REDRAW),
				{ ...REDRAW.defaults, steps },
				params({ aspectRatio: "1:1", ...(strength && { strength }) }),
				"/o.png",
				async (p) => p,
				["/s/old.png"],
				{ width: 1024, height: 768 },
			);
		const turbo = await redraw(4, 0.5);
		expect(after(turbo, "-i")).toBe("/s/old.png");
		expect(after(turbo, "--strength")).toBe("0.5");
		// The engine runs steps × strength: four, as the model was made for.
		expect(after(turbo, "--steps")).toBe("8");
		// The redrawn picture's shape, not the ratio asked.
		expect(after(turbo, "-W")).toBe("1024");
		expect(after(turbo, "-H")).toBe("768");
		// One step at most strengths would make them all alike: about four.
		expect(after(await redraw(1, 0.6), "--steps")).toBe("7");
		expect(after(await redraw(1, 0.85), "--steps")).toBe("5");
		expect(after(await redraw(30, 0.6), "--steps")).toBe("30");
		const unsaid = await redraw(4);
		expect(after(unsaid, "--strength")).toBe(String(DEFAULT_STRENGTH));
		// Without a picture it makes one from words, as before.
		const words = await engineArguments(
			runtime(REDRAW),
			REDRAW.defaults,
			params({ strength: 0.3 }),
			"/o.png",
			async (p) => p,
		);
		expect(words).not.toContain("--strength");
		expect(words).not.toContain("-i");
		expect(after(words, "--steps")).toBe("4");
		expect(redrawSteps(4, 1)).toBe(4);
	});

	test("a model that does not fit the graphics card keeps part in memory", async () => {
		const fits = await engineArguments(
			runtime(FLUX),
			FLUX.defaults,
			params(),
			"/o.png",
			async (p) => p,
		);
		const short = await engineArguments(
			runtime(FLUX, "/scratch", "offload"),
			FLUX.defaults,
			params(),
			"/o.png",
			async (p) => p,
		);
		expect(fits).not.toContain("--offload-to-cpu");
		expect(short.at(-1)).toBe("--offload-to-cpu");
	});

	test("a model run in pieces gets a share of the card's memory", async () => {
		const pieces = {
			...FLUX,
			defaults: { ...FLUX.defaults, vramBudget: true },
		};
		const card = { ...runtime(pieces), gpuMemoryBytes: 12_282 * 2 ** 20 };
		const args = await engineArguments(
			card,
			pieces.defaults,
			params(),
			"/o.png",
			async (p) => p,
		);
		expect(args[args.indexOf("--max-vram") + 1]).toBe("8");
		expect(vramBudget(24 * 2 ** 30)).toBe(20);
		expect(vramBudget(4 * 2 ** 30)).toBe(1);
		// Not on the CPU, nor for a model that does not ask for it.
		const cpu = await engineArguments(
			runtime(pieces),
			pieces.defaults,
			params(),
			"/o.png",
			async (p) => p,
		);
		expect(cpu).not.toContain("--max-vram");
		const whole = await engineArguments(
			{ ...runtime(FLUX), gpuMemoryBytes: 12_282 * 2 ** 20 },
			FLUX.defaults,
			params(),
			"/o.png",
			async (p) => p,
		);
		expect(whole).not.toContain("--max-vram");
	});

	test("LoRAs are named in the prompt, with their trigger, and their folder given", async () => {
		const args = await engineArguments(
			runtime(FLUX),
			FLUX.defaults,
			params({ seed: 1 }),
			"/scratch/out.png",
			windows,
			[],
			undefined,
			undefined,
			[
				{
					id: "porcelain",
					weight: 0.8,
					trigger: "qzporcelain",
					path: "/m/loras/porcelain.safetensors",
				},
				{
					id: "ink",
					weight: 1,
					trigger: null,
					path: "/m/loras/ink.safetensors",
				},
			],
		);
		expect(args[args.indexOf("-p") + 1]).toBe(
			"qzporcelain, a red fox <lora:porcelain:0.8> <lora:ink:1>",
		);
		expect(args[args.indexOf("--lora-model-dir") + 1]).toBe("C:\\m\\loras");
	});

	test("a trigger already in the prompt is not added twice; a LoRA at 0 is left out", () => {
		const lora = { id: "p", weight: 1, trigger: "QZ" };
		expect(loraPrompt("a qz fox", [lora])).toBe("a qz fox <lora:p:1>");
		expect(loraPrompt("a fox", [{ ...lora, weight: 0 }])).toBe("a fox");
		expect(loraPrompt("a fox", [lora, { ...lora, id: "q" }])).toBe(
			"QZ, a fox <lora:p:1> <lora:q:1>",
		);
		expect(loraPrompt("a fox", [{ ...lora, weight: 0.333333 }])).toBe(
			"QZ, a fox <lora:p:0.33>",
		);
		// Inside another word it is not there.
		expect(loraPrompt("qzfox art", [lora])).toBe("QZ, qzfox art <lora:p:1>");
	});

	test("LoRA tags written in a prompt are taken out: only checked LoRAs load", () => {
		expect(loraPrompt("a fox <lora:add_detail:0.6>, snow", [])).toBe(
			"a fox , snow",
		);
		expect(
			loraPrompt("<LyCO:x:1> a fox", [{ id: "p", weight: 1, trigger: null }]),
		).toBe("a fox <lora:p:1>");
		expect(loraPrompt("a <lora:x a <lora:y:1> fox", [])).toBe("a fox");
		expect(loraPrompt("a fox <lora:unclosed", [])).toBe("a fox <lora:unclosed");
	});

	test("a prompt full of unclosed LoRA tags is read in linear time", () => {
		const prompt = "<lora:".repeat(50_000);
		const started = performance.now();
		expect(loraPrompt(prompt, [])).toBe(prompt);
		expect(performance.now() - started).toBeLessThan(500);
	});

	test("a file with an unknown role is refused rather than guessed", async () => {
		const odd = { ...runtime(FLUX), files: { lora: "/m/lora" } };
		expect(
			engineArguments(odd, FLUX.defaults, params(), "/o.png", windows),
		).rejects.toThrow("No engine option for a lora file");
	});

	test("a forming picture is shown about four times, never for one step", () => {
		expect(previewInterval(1)).toBeNull();
		expect(previewInterval(4)).toBe(1);
		expect(previewInterval(8)).toBe(2);
		expect(previewInterval(30)).toBe(8);
	});

	test("progress is read from the sampling bar only", () => {
		expect(
			samplingProgress(
				"  |============>          | 1/4 -   5.02s/it - ETA 00:15",
			),
		).toEqual({ step: 1, steps: 4 });
		expect(samplingProgress("  |=====>| 30/30 - 2.10it/s")).toEqual({
			step: 30,
			steps: 30,
		});
		// Loading bars count tensors, not steps.
		expect(samplingProgress("  |######   | 18/219 - 615.45MB/s")).toBeNull();
		expect(samplingProgress("[I] generating image: 1/1 - seed 42")).toBeNull();
	});
});

describe("running", () => {
	/** A store that has one installed model, with its scratch in `dir`. */
	async function setup(model = FLUX) {
		const dir = await mkdtemp(join(tmpdir(), "hatchlight-local-"));
		const gpuRoot = await mkdtemp(join(tmpdir(), "hatchlight-gpu-"));
		dirs.push(dir, gpuRoot);
		const listeners: ((event: { type: string }) => void)[] = [];
		const store = {
			list: async () => ({
				models: [{ id: model.id, installed: true, ready: true }],
			}),
			runtime: async () => ({ ...runtime(model, dir), throughWindows: false }),
			checkpointRuntime: async (id: string, spec: LocalModelSpec) => ({
				...runtime(spec, dir),
				throughWindows: false,
				files: { model: `/checkpoints/${id}.safetensors` },
			}),
			subscribe: (listener: (event: { type: string }) => void) => {
				listeners.push(listener);
				return () => {};
			},
			gpu: new GpuLock({ root: gpuRoot, capacity: async () => 12 * 2 ** 30 }),
			loras: new LoraShelf({ root: () => gpuRoot }),
			checkpoints: new CheckpointShelf({ root: () => gpuRoot }),
		};
		const calls: string[][] = [];
		let killed = 0;
		/** Prints `lines`, then writes `result` where the job asked for it. */
		const fake =
			(lines: string[], code = 0, result: Uint8Array | null = PNG): Spawn =>
			(argv) => {
				calls.push(argv);
				const output = argv[argv.indexOf("-o") + 1] as string;
				let finish!: (code: number) => void;
				const exited = new Promise<number>((resolve) => {
					finish = resolve;
				});
				return {
					output: (async function* () {
						for (const line of lines) {
							if (line === "HANG") await new Promise(() => {});
							yield line;
						}
						if (result) await Bun.write(output, result);
						finish(code);
					})(),
					exited,
					kill: () => {
						killed++;
						finish(137);
					},
				};
			};
		const provider = (
			spawn: Spawn,
			freeMemory: () => Promise<GpuMemory | null> = async () => null,
		) =>
			new LocalProvider({
				store: store as never,
				catalog: [model],
				spawn,
				freeMemory,
			});
		return {
			dir,
			gpuRoot,
			store,
			calls,
			fake,
			provider,
			killed: () => killed,
			listeners,
		};
	}

	async function run(
		provider: LocalProvider,
		signal = new AbortController().signal,
		references: { data: Uint8Array; mime: string }[] = [],
	) {
		await provider.load();
		const [model] = provider.listModels();
		const handle = await provider.submit({
			model: model as never,
			params: params(),
			references,
		});
		const events: ProviderEvent[] = [];
		for await (const event of provider.events(handle, {
			apiKey: undefined,
			signal,
		})) {
			events.push(event);
		}
		return events;
	}

	test("installed models are offered, free and without references", async () => {
		const { provider, fake } = await setup();
		const local = provider(fake([]));
		let changed = 0;
		local.onChange = () => changed++;
		expect(local.listModels()).toEqual([]);
		await local.load();
		expect(changed).toBe(1);
		expect(local.listModels()).toEqual([
			{
				id: "local/flux",
				providerId: "local",
				providerModelId: "flux",
				name: "FLUX",
				media: "image",
				operations: ["generate"],
				capabilities: {
					aspectRatios: ["1:1", "16:9"],
					seed: true,
					maxCount: 1,
					maxReferenceImages: 0,
				},
				pricing: { usdPerOutput: 0 },
			},
		]);
		await local.load();
		expect(changed).toBe(1); // nothing changed
	});

	test("a job says when other programs leave too little graphics memory, and still runs", async () => {
		const { provider, fake } = await setup();
		const GB = 2 ** 30;
		const events = await run(
			provider(fake([]), async () => ({
				freeBytes: 0,
				totalBytes: 12 * GB,
			})),
		);
		expect(events[0]).toEqual({
			type: "progress",
			message: "Other programs are using graphics memory, so this may be slow",
			stage: "lowMemory",
			busyBytes: 12 * GB,
		});
		expect(events.some((e) => e.type === "completed")).toBe(true);
	});

	test("memory held by this process's other jobs is not counted as free", async () => {
		const { provider, fake, store } = await setup();
		const signal = new AbortController().signal;
		const other = store.gpu.acquire(2 ** 30, signal);
		let step = await other.next();
		while (!step.done) step = await other.next();
		const events = await run(
			provider(fake([]), async () => ({ freeBytes: 0, totalBytes: 2 ** 34 })),
		);
		expect(events.some((e) => "busyBytes" in e)).toBe(true);
		step.value.release();
	});

	test("memory another Hatchlight reserves is not other programs'", async () => {
		const { provider, fake, gpuRoot } = await setup();
		await mkdir(join(gpuRoot, "gpu"), { recursive: true });
		await Bun.write(join(gpuRoot, "gpu", "another"), String(2 ** 30));
		const events = await run(
			provider(fake([]), async () => ({ freeBytes: 0, totalBytes: 2 ** 34 })),
		);
		expect(events.some((e) => "busyBytes" in e)).toBe(false);
	});

	test("memory of a model kept loaded, unloaded for this job and still exiting, is not other programs'", async () => {
		const { store, fake } = await setup();
		const GB = 2 ** 30;
		// No server beside the engine: the job runs it once.
		const warm = {
			loaded: null,
			unused: true,
			stop() {},
			async stopAndWait() {},
			async unloading() {
				return 12 * GB;
			},
			unloadedBytes: 12 * GB,
		};
		const events = await run(
			new LocalProvider({
				store: store as never,
				catalog: [FLUX],
				spawn: fake([]),
				warm: warm as never,
				freeMemory: async () => ({ freeBytes: 0, totalBytes: 12 * GB }),
			}),
		);
		expect(events.some((e) => "busyBytes" in e)).toBe(false);
		expect(events.some((e) => e.type === "completed")).toBe(true);
	});

	test("free memory is read again when an unloaded model's engine exits during the reading", async () => {
		const { store, fake } = await setup();
		const GB = 2 ** 30;
		const warm = {
			loaded: null,
			unused: true,
			stop() {},
			async stopAndWait() {},
			async unloading() {
				return warm.unloadedBytes;
			},
			unloadedBytes: 12 * GB,
		};
		const readings: number[] = [];
		const events = await run(
			new LocalProvider({
				store: store as never,
				catalog: [FLUX],
				spawn: fake([]),
				warm: warm as never,
				freeMemory: async () => {
					readings.push(warm.unloadedBytes);
					// The engine exits while the first reading is taken.
					warm.unloadedBytes = 0;
					return { freeBytes: 0, totalBytes: 12 * GB };
				},
			}),
		);
		// The second reading, with nothing left exiting, is trusted.
		expect(readings).toEqual([12 * GB, 0]);
		expect(events.some((e) => "busyBytes" in e)).toBe(true);
	});

	test("a reading that stays unsure while Hatchlight's own memory changes says nothing", async () => {
		const { store, fake } = await setup();
		const GB = 2 ** 30;
		let exiting = 12 * GB;
		const warm = {
			loaded: null,
			unused: true,
			stop() {},
			async stopAndWait() {},
			async unloading() {
				return exiting;
			},
			get unloadedBytes() {
				return exiting;
			},
		};
		let readings = 0;
		const events = await run(
			new LocalProvider({
				store: store as never,
				catalog: [FLUX],
				spawn: fake([]),
				warm: warm as never,
				freeMemory: async () => {
					readings++;
					exiting -= GB;
					return { freeBytes: 0, totalBytes: 12 * GB };
				},
			}),
		);
		expect(readings).toBe(2);
		expect(events.some((e) => "busyBytes" in e)).toBe(false);
		expect(events.some((e) => e.type === "completed")).toBe(true);
	});

	test("a cancel while the free memory is read ends the job at once", async () => {
		const { provider, fake } = await setup();
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("canceled")), 20);
		const started = Date.now();
		await expect(
			run(
				provider(fake([]), () => new Promise(() => {})),
				controller.signal,
			),
		).rejects.toThrow("canceled");
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("a job with enough free graphics memory, or an unknown amount, says nothing", async () => {
		const { provider, fake } = await setup();
		const GB = 2 ** 30;
		for (const memory of [{ freeBytes: 8 * GB, totalBytes: 12 * GB }, null]) {
			const events = await run(provider(fake([]), async () => memory));
			expect(events.some((e) => "busyBytes" in e)).toBe(false);
		}
	});

	test("a failing reading of the free memory does not fail the job", async () => {
		const { provider, fake } = await setup();
		const events = await run(
			provider(fake([]), async () => {
				throw new Error("nvidia-smi is gone");
			}),
		);
		expect(events.some((e) => e.type === "completed")).toBe(true);
	});

	test("a job reports sampling progress and returns the image", async () => {
		const { provider, fake, calls, dir } = await setup();
		const events = await run(
			provider(
				fake([
					"[I] loading model",
					"  |=====>      | 1/4 - 2.00s/it",
					"  |=====>      | 1/4 - 2.00s/it",
					"  |=========>  | 4/4 - 1.00s/it",
				]),
			),
		);
		expect(events).toEqual([
			{ type: "progress", message: "Loading the model", stage: "loading" },
			{
				type: "progress",
				fraction: 0.25,
				message: "Generating",
				stage: "generating",
				step: 1,
				steps: 4,
			},
			{
				type: "progress",
				fraction: 1,
				message: "Generating",
				stage: "generating",
				step: 4,
				steps: 4,
			},
			{
				type: "completed",
				outputs: [{ data: PNG, mime: "image/png" }],
				costUsd: 0,
			},
		]);
		expect(calls[0]?.[0]).toBe("/engines/b/sd-cli.exe");
		// The engine's output is removed once read.
		expect(await readdir(dir)).toEqual([]);
	});

	test("models that take pictures are offered for editing", async () => {
		const both: LocalModelSpec = {
			...FLUX,
			tasks: ["text-to-image", "image-edit"],
			defaults: { ...FLUX.defaults, references: { as: "ref", max: 3 } },
		};
		const editOnly: LocalModelSpec = { ...both, tasks: ["image-edit"] };
		for (const [model, operations] of [
			[both, ["generate", "edit"]],
			[editOnly, ["edit"]],
		] as const) {
			const { provider, fake } = await setup(model);
			const local = provider(fake([]));
			await local.load();
			const [listed] = local.listModels();
			expect(listed?.operations).toEqual([...operations]);
			expect(listed?.capabilities.maxReferenceImages).toBe(3);
		}
	});

	test("a picture to follow is handed to the engine as a file, then removed", async () => {
		const edit: LocalModelSpec = {
			...FLUX,
			tasks: ["image-edit"],
			defaults: { ...FLUX.defaults, references: { as: "ref", max: 1 } },
		};
		const { provider, fake, calls, dir } = await setup(edit);
		let given: Uint8Array = new Uint8Array();
		const spawn: Spawn = (argv) => {
			const path = argv[argv.indexOf("-r") + 1] as string;
			given = new Uint8Array(readFileSync(path));
			return fake([])(argv);
		};
		const events = await run(provider(spawn), undefined, [
			{ data: new Uint8Array([9, 8, 7]), mime: "image/jpeg" },
		]);
		expect(events.at(-1)?.type).toBe("completed");
		expect(calls[0]?.[calls[0].indexOf("-r") + 1]).toEndWith(".jpeg");
		expect(given).toEqual(new Uint8Array([9, 8, 7]));
		expect(await readdir(dir)).toEqual([]);
	});

	test("a model that cannot show its picture forming while following one does not", async () => {
		const edit: LocalModelSpec = {
			...FLUX,
			tasks: ["text-to-image", "image-edit"],
			defaults: {
				...FLUX.defaults,
				references: { as: "ref", max: 1 },
				previewsWhileFollowing: false,
			},
		};
		const { provider, fake, calls } = await setup(edit);
		const local = provider(fake([]));
		await run(local, undefined, [
			{ data: new Uint8Array([9, 8, 7]), mime: "image/png" },
		]);
		expect(calls[0]).not.toContain("--preview");
		// From words alone it still does.
		await run(local);
		expect(calls[1]).toContain("--preview");
	});

	test("a picture to redraw keeps its shape and reaches the engine at its size", async () => {
		const { provider, fake, calls, dir } = await setup(REDRAW);
		let given: Uint8Array = new Uint8Array();
		const spawn: Spawn = (argv) => {
			const path = argv[argv.indexOf("-i") + 1] as string;
			given = new Uint8Array(readFileSync(path));
			return fake([])(argv);
		};
		const local = provider(spawn);
		await local.load();
		const [listed] = local.listModels();
		expect(listed?.operations).toEqual(["generate", "edit"]);
		expect(listed?.capabilities).toMatchObject({
			maxReferenceImages: 1,
			strength: DEFAULT_STRENGTH,
		});
		const events = await run(local, undefined, [
			{ data: picture(1600, 900), mime: "image/png" },
		]);
		expect(events.at(-1)?.type).toBe("completed");
		const argv = calls[0] ?? [];
		const after = (flag: string) => argv[argv.indexOf(flag) + 1];
		// 16:9 at the model's 1024, in steps of 64.
		expect([after("-W"), after("-H")]).toEqual(["1024", "576"]);
		expect(await new Bun.Image(given).metadata()).toMatchObject({
			width: 1024,
			height: 576,
		});
		expect(after("--strength")).toBe(String(DEFAULT_STRENGTH));
		expect(await readdir(dir)).toEqual([]);
	});

	test("a picture to redraw goes to the model kept loaded, with its mask", async () => {
		const { store, dir } = await setup(REDRAW);
		// An engine with a server beside it, as the real ones have.
		const executable = join(dir, "sd-cli");
		await Bun.write(join(dir, "sd-server"), "");
		store.runtime = async () => ({
			...runtime(REDRAW, dir),
			executable,
			throughWindows: false,
		});
		const asked: WarmRequest[] = [];
		const warm = {
			loaded: null,
			unused: true,
			stop() {},
			async stopAndWait() {},
			async *run(_key: string, argv: string[], request: WarmRequest) {
				expect(argv[0]).toBe(join(dir, "sd-server"));
				asked.push(request);
				yield {
					type: "completed" as const,
					outputs: [{ data: PNG, mime: "image/png" }],
					costUsd: 0,
				};
			},
		};
		const local = new LocalProvider({
			store: store as never,
			catalog: [REDRAW],
			spawn: () => {
				throw new Error("the engine is not run once");
			},
			warm: warm as never,
			freeMemory: async () => null,
		});
		await local.load();
		const [model] = local.listModels();
		const handle = await local.submit({
			model: model as never,
			params: params({ strength: 0.6 }),
			references: [{ data: picture(1600, 900), mime: "image/png" }],
			mask: { data: picture(800, 450), mime: "image/png" },
		});
		const events: ProviderEvent[] = [];
		for await (const event of local.events(handle, {
			apiKey: undefined,
			signal: new AbortController().signal,
		})) {
			events.push(event);
		}
		expect(events.at(-1)?.type).toBe("completed");
		const [request] = asked;
		expect(request?.strength).toBe(0.6);
		expect(request?.initImage?.length).toBeGreaterThan(0);
		expect(request?.maskImage?.length).toBeGreaterThan(0);
		expect(request?.refImages).toBeUndefined();
		// The same size and steps as the engine run once would use.
		const once = await engineArguments(
			runtime(REDRAW),
			REDRAW.defaults,
			params({ strength: 0.6 }),
			"/o.png",
			async (p) => p,
			["/s/old.png"],
			handle.size,
			"/s/mask.png",
		);
		expect(String(request?.steps)).toBe(
			String(once[once.indexOf("--steps") + 1]),
		);
		expect(String(request?.width)).toBe(String(once[once.indexOf("-W") + 1]));
	});

	test("a mask reaches the engine at the size of the picture it marks", async () => {
		const { provider, fake, calls, dir } = await setup(REDRAW);
		let given: Uint8Array = new Uint8Array();
		const spawn: Spawn = (argv) => {
			given = new Uint8Array(
				readFileSync(argv[argv.indexOf("--mask") + 1] as string),
			);
			return fake([])(argv);
		};
		const local = provider(spawn);
		await local.load();
		const [model] = local.listModels();
		expect(model?.capabilities.mask).toBe(DEFAULT_MASK_STRENGTH);
		const handle = await local.submit({
			model: model as never,
			params: params({ strength: 0.75 }),
			references: [{ data: picture(1600, 900), mime: "image/png" }],
			// Marked on the picture as shown, at another size.
			mask: { data: picture(800, 450), mime: "image/png" },
		});
		const events: ProviderEvent[] = [];
		for await (const event of local.events(handle, {
			apiKey: undefined,
			signal: new AbortController().signal,
		})) {
			events.push(event);
		}
		expect(events.at(-1)?.type).toBe("completed");
		const argv = calls[0] ?? [];
		expect(argv[argv.indexOf("--strength") + 1]).toBe("0.75");
		// Unasked, a marked part changes more than a whole picture would.
		const unasked = await engineArguments(
			runtime(REDRAW),
			REDRAW.defaults,
			params(),
			"/o.png",
			async (p) => p,
			["/s/old.png"],
			undefined,
			"/s/mask.png",
		);
		expect(unasked[unasked.indexOf("--strength") + 1]).toBe(
			String(DEFAULT_MASK_STRENGTH),
		);
		expect(unasked[unasked.indexOf("--mask") + 1]).toBe("/s/mask.png");
		expect(await new Bun.Image(given).metadata()).toMatchObject({
			width: 1024,
			height: 576,
		});
		expect(await readdir(dir)).toEqual([]);

		// Without a picture to redraw, a mask means nothing to the engine.
		const words = await engineArguments(
			runtime(REDRAW),
			REDRAW.defaults,
			params(),
			"/o.png",
			async (p) => p,
			[],
			undefined,
			"/s/mask.png",
		);
		expect(words).not.toContain("--mask");
	});

	test("a picture to redraw that cannot be read is refused, saying so", async () => {
		const { provider, fake } = await setup(REDRAW);
		const local = provider(fake([]));
		await local.load();
		const [model] = local.listModels();
		expect(
			local.submit({
				model: model as never,
				params: params(),
				references: [{ data: new Uint8Array([1, 2, 3]), mime: "image/png" }],
			}),
		).rejects.toMatchObject({ code: "referenceUnreadable" });
	});

	test("a mask that cannot be read leaves nothing behind", async () => {
		const { provider, fake, dir } = await setup(REDRAW);
		const local = provider(fake([]));
		await local.load();
		const [model] = local.listModels();
		expect(
			local.submit({
				model: model as never,
				params: params(),
				references: [{ data: picture(64, 64), mime: "image/png" }],
				mask: { data: new Uint8Array([1, 2, 3]), mime: "image/png" },
			}),
		).rejects.toMatchObject({ code: "referenceUnreadable" });
		await Bun.sleep(50);
		expect(await readdir(dir)).toEqual([]);
	});

	test("a phone photo is redrawn the way it is shown, not the way it is stored", async () => {
		const { provider, fake, calls } = await setup(REDRAW);
		const local = provider(fake([]));
		// Stored 200x100, with EXIF saying to turn it a quarter to show it.
		const stored = await new Bun.Image(picture(200, 100)).jpeg().bytes();
		const tiff = [
			0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6,
			0, 0, 0, 0, 0, 0,
		];
		const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
		const turned = new Uint8Array([
			0xff,
			0xd8,
			0xff,
			0xe1,
			0,
			exif.length + 2,
			...exif,
			...stored.subarray(2),
		]);
		await run(local, undefined, [{ data: turned, mime: "image/jpeg" }]);
		const argv = calls[0] ?? [];
		const after = (flag: string) => argv[argv.indexOf(flag) + 1];
		expect([after("-W"), after("-H")]).toEqual(["512", "1024"]);
	});

	test("an upscaler enlarges the picture it is given, and nothing else", async () => {
		const { provider, fake, calls, dir } = await setup(UPSCALER);
		let given: Uint8Array = new Uint8Array();
		const spawn: Spawn = (argv) => {
			given = new Uint8Array(
				readFileSync(argv[argv.indexOf("-i") + 1] as string),
			);
			return fake([])(argv);
		};
		const local = provider(spawn);
		await local.load();
		const [model] = local.listModels();
		expect(model?.operations).toEqual(["edit"]);
		expect(model?.capabilities).toMatchObject({
			upscale: 4,
			maxReferenceImages: 1,
			aspectRatios: [],
		});
		expect(model?.capabilities.strength).toBeUndefined();
		expect(model?.capabilities.mask).toBeUndefined();
		const events = await run(local, undefined, [
			{ data: picture(3000, 1500), mime: "image/png" },
		]);
		expect(events.at(-1)?.type).toBe("completed");
		const argv = calls[0] ?? [];
		expect(argv.slice(1, 3)).toEqual(["-M", "upscale"]);
		// Its weights go by their role, as every model's files do.
		expect(roleOption("upscale_model")).toBe("--upscale-model");
		expect(argv[argv.indexOf("-o") + 1]).toEndWith(".png");
		for (const flag of ["-p", "--steps", "--strength", "-W", "--preview"]) {
			expect(argv).not.toContain(flag);
		}
		// Larger pictures are brought down first: four times them is too much.
		expect(await new Bun.Image(given).metadata()).toMatchObject({
			width: MAX_UPSCALE_INPUT,
			height: MAX_UPSCALE_INPUT / 2,
			format: "png",
		});
		expect(await readdir(dir)).toEqual([]);
	});

	test("a run tried again finds its pictures again", async () => {
		const { provider, fake, calls, dir } = await setup(REDRAW);
		const seen: string[] = [];
		const spawn: Spawn = (argv) => {
			const file = argv[argv.indexOf("-i") + 1] as string;
			seen.push(readFileSync(file).byteLength > 0 ? "found" : "empty");
			return fake([], seen.length === 1 ? 1 : 0)(argv);
		};
		const local = provider(spawn);
		await local.load();
		const [model] = local.listModels();
		const handle = await local.submit({
			model: model as never,
			params: params(),
			references: [{ data: picture(64, 64), mime: "image/png" }],
			mask: { data: picture(64, 64), mime: "image/png" },
		});
		const runOnce = async () => {
			const events: ProviderEvent[] = [];
			for await (const event of local.events(handle, {
				apiKey: undefined,
				signal: new AbortController().signal,
			})) {
				events.push(event);
			}
			return events.at(-1)?.type;
		};
		// The engine dies the first time; the job engine tries the same handle.
		expect(await runOnce()).toBe("failed");
		expect(await runOnce()).toBe("completed");
		expect(seen).toEqual(["found", "found"]);
		expect(calls[1]).toContain("--mask");
		expect(await readdir(dir)).toEqual([]);
	});

	test("a failing engine reports its last error line", async () => {
		const { provider, fake } = await setup();
		const events = await run(
			provider(
				fake(
					["[I] loading", "[E] failed to load model: out of memory"],
					1,
					null,
				),
			),
		);
		expect(events.at(-1)).toEqual({
			type: "failed",
			error: "The engine stopped: failed to load model: out of memory",
			code: "engineStopped",
			params: { reason: "failed to load model: out of memory" },
			// A crash is worth one more try.
			retry: { attempts: 2 },
		});
		const silent = await run(provider(fake([], 3, null)));
		expect(silent.at(-1)).toEqual({
			type: "failed",
			error: "The engine stopped with code 3",
			code: "engineExitCode",
			params: { code: 3 },
			retry: { attempts: 2 },
		});
		const empty = await run(provider(fake([], 0, null)));
		expect(empty.at(-1)).toEqual({
			type: "failed",
			error: "The engine produced no result",
			code: "engineNoResult",
		});
	});

	test("canceling stops the engine", async () => {
		const { provider, fake, killed } = await setup();
		const controller = new AbortController();
		const local = provider(fake(["  |=>  | 1/4 - 1.00s/it", "HANG"]));
		const job = run(local, controller.signal);
		await Bun.sleep(20);
		controller.abort();
		expect(job).rejects.toThrow();
		await Bun.sleep(10);
		expect(killed()).toBeGreaterThan(0);
	});

	test("a LoRA made for the model reaches the engine; one for another family is refused", async () => {
		const SDXL = { ...FLUX, loraBase: "sdxl" as const };
		const { provider, fake, calls, store, gpuRoot } = await setup(SDXL);
		const sdxl = await store.loras.add(
			new Blob([
				safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"], {
					"modelspec.title": "Porcelain",
				}),
			]),
			"p.safetensors",
		);
		const flux = await store.loras.add(
			new Blob([safetensors(["lora_unet_double_blocks_0_img_attn.alpha"])]),
			"f.safetensors",
		);
		const local = provider(fake([]));
		await local.load();
		const [model] = local.listModels();
		expect(model?.capabilities.loraBase).toBe("sdxl");
		const handle = await local.submit({
			model: model as never,
			params: params({ loras: [{ id: sdxl.id, weight: 0.7 }] }),
			references: [],
		});
		const events: ProviderEvent[] = [];
		for await (const event of local.events(handle, {
			apiKey: undefined,
			signal: new AbortController().signal,
		})) {
			events.push(event);
		}
		expect(events.at(-1)?.type).toBe("completed");
		const argv = calls[0] ?? [];
		expect(argv[argv.indexOf("-p") + 1]).toBe("a red fox <lora:porcelain:0.7>");
		expect(argv[argv.indexOf("--lora-model-dir") + 1]).toBe(
			join(gpuRoot, "loras"),
		);
		await expect(
			local.submit({
				model: model as never,
				params: params({ loras: [{ id: flux.id, weight: 1 }] }),
				references: [],
			}),
		).rejects.toMatchObject({ code: "loraWrongBase" });
		// Sent to models of both families, each keeps its own.
		const mixed = await local.submit({
			model: model as never,
			params: params({
				loras: [
					{ id: flux.id, weight: 1 },
					{ id: sdxl.id, weight: 1 },
				],
			}),
			references: [],
		});
		expect(mixed.loras?.map((l) => l.id)).toEqual([sdxl.id]);
		await expect(
			local.submit({
				model: model as never,
				params: params({ loras: [{ id: "gone", weight: 1 }] }),
				references: [],
			}),
		).rejects.toMatchObject({ code: "loraMissing" });
	});

	test("a LoRA from another app's folder reaches the engine through a folder of the job's", async () => {
		const SDXL = { ...FLUX, loraBase: "sdxl" as const };
		const { provider, fake, calls, store, gpuRoot, dir } = await setup(SDXL);
		const app = await mkdtemp(join(tmpdir(), "hatchlight-comfyui-"));
		dirs.push(app);
		await mkdir(join(app, "models", "loras"), { recursive: true });
		await Bun.write(
			join(app, "models", "loras", "Ink v2.safetensors"),
			safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"]),
		);
		const folders = new LinkedFolders({
			root: () => gpuRoot,
			ownIds: { lora: async () => [], checkpoint: async () => [] },
		});
		store.loras = new LoraShelf({
			root: () => gpuRoot,
			linked: folders.loras,
		});
		const own = await store.loras.add(
			new Blob([safetensors(["lora_te2_x.alpha"], { ss_output_name: "Mine" })]),
			"mine.safetensors",
		);
		await folders.add(app);
		// What the engine finds in its LoRA folder while it runs.
		let seen: string[] = [];
		const watching: Spawn = (argv) => {
			seen = readdirSync(argv[argv.indexOf("--lora-model-dir") + 1] as string);
			return fake([])(argv);
		};
		const watched = provider(watching);
		await watched.load();
		const [model] = watched.listModels();
		const handle = await watched.submit({
			model: model as never,
			params: params({
				loras: [
					{ id: "ink-v2", weight: 1 },
					{ id: own.id, weight: 0.5 },
				],
			}),
			references: [],
		});
		const events: ProviderEvent[] = [];
		for await (const event of watched.events(handle, {
			apiKey: undefined,
			signal: new AbortController().signal,
		})) {
			events.push(event);
		}
		expect(events.at(-1)?.type).toBe("completed");
		const argv = calls[0] ?? [];
		expect(argv[argv.indexOf("-p") + 1]).toBe(
			"a red fox <lora:ink-v2:1> <lora:mine:0.5>",
		);
		const loraDir = argv[argv.indexOf("--lora-model-dir") + 1] as string;
		expect(loraDir.startsWith(join(dir, "loras-"))).toBe(true);
		expect(seen.sort()).toEqual(["ink-v2.safetensors", "mine.safetensors"]);
		// Gone after the job; the other app's file stays.
		expect(await readdir(dir)).not.toContain(loraDir.slice(dir.length + 1));
		expect(await readdir(join(app, "models", "loras"))).toEqual([
			"Ink v2.safetensors",
		]);
	});

	test("a LoRA deleted after the job was asked for fails the job, saying so", async () => {
		const SDXL = { ...FLUX, loraBase: "sdxl" as const };
		const { provider, fake, store } = await setup(SDXL);
		const lora = await store.loras.add(
			new Blob([safetensors(["lora_te2_x.alpha"])]),
			"p.safetensors",
		);
		const local = provider(fake([]));
		await local.load();
		const [model] = local.listModels();
		const handle = await local.submit({
			model: model as never,
			params: params({ loras: [{ id: lora.id, weight: 1 }] }),
			references: [],
		});
		await store.loras.remove(lora.id);
		const run = async () => {
			for await (const _ of local.events(handle, {
				apiKey: undefined,
				signal: new AbortController().signal,
			})) {
			}
		};
		await expect(run()).rejects.toMatchObject({ code: "loraMissing" });
	});

	test("a checkpoint added by hand is offered once its engine is here, and runs with its settings", async () => {
		const SDXL_BASE: LocalModelSpec = {
			...FLUX,
			id: "sdxl-base",
			name: "Stable Diffusion XL",
			variants: [
				{ id: "v", label: "v", engine: "sd", memoryBytes: 1, files: [] },
			],
		};
		const { provider, fake, calls, store } = await setup(SDXL_BASE);
		await store.checkpoints.add(
			new Blob([
				safetensors(
					[
						"model.diffusion_model.input_blocks.0.0.weight",
						"conditioner.embedders.1.model.ln_final.weight",
						"first_stage_model.decoder.conv_in.weight",
					],
					{ "modelspec.title": "Pony" },
				),
			]),
			"pony.safetensors",
		);
		await store.checkpoints.update("pony", { steps: 6, cfgScale: 2 });
		const local = provider(fake([]));
		await local.load();
		const model = local.listModels().find((m) => m.id === "local/ckpt-pony");
		expect(model).toMatchObject({ name: "Pony", media: "image" });
		const handle = await local.submit({
			model: model as never,
			params: params({ seed: 3 }),
			references: [],
		});
		for await (const _ of local.events(handle, {
			apiKey: undefined,
			signal: new AbortController().signal,
		})) {
		}
		const argv = calls[0] ?? [];
		expect(argv.slice(argv.indexOf("-m"), argv.indexOf("-m") + 2)).toEqual([
			"-m",
			"/checkpoints/pony.safetensors",
		]);
		expect(argv[argv.indexOf("--steps") + 1]).toBe("6");
		expect(argv[argv.indexOf("--cfg-scale") + 1]).toBe("2");
		expect(argv[argv.indexOf("--clip-skip") + 1]).toBe("2");
		// Deleted, it is no longer offered.
		await store.checkpoints.remove("pony");
		await local.load();
		expect(local.listModels().map((m) => m.id)).toEqual(["local/sdxl-base"]);
	});

	test("a look at the models that fails after a change is not left unhandled", async () => {
		let changed: (event: { type: string }) => void = () => {};
		const local = new LocalProvider({
			store: {
				subscribe: (listener: typeof changed) => {
					changed = listener;
					return () => {};
				},
				list: async () => {
					throw new Error("ENOENT: the folder is gone");
				},
			} as never,
			catalog: [FLUX],
			warm: false,
		});
		changed({ type: "models.changed" });
		// An unhandled rejection would fail this test, or the next one.
		await Bun.sleep(20);
		expect(local.listModels()).toEqual([]);
	});

	test("pictures and videos wait in separate lines", async () => {
		const local = new LocalProvider({
			store: { subscribe: () => () => {} } as never,
			catalog: [FLUX, WAN],
			warm: false,
		});
		expect(local.lineOf("local/flux")).toBe("image");
		expect(local.lineOf("local/wan")).toBe("video");
	});

	test("a job waits while another Hatchlight holds the GPU's memory", async () => {
		const { provider, fake, calls, gpuRoot } = await setup();
		const other = new GpuLock({
			root: gpuRoot,
			capacity: async () => 12 * 2 ** 30,
		});
		const it = other.acquire(12 * 2 ** 30, new AbortController().signal);
		let held = await it.next();
		while (!held.done) held = await it.next();
		const local = provider(fake(["  |====| 4/4 - 1.00s/it"]));
		const job = run(local);
		await Bun.sleep(30);
		expect(calls.length).toBe(0);
		held.value.release();
		const events = await job;
		expect(
			events.some((e) => e.type === "progress" && e.stage === "waitingGpu"),
		).toBe(true);
		expect(events.at(-1)?.type).toBe("completed");
	});
});
