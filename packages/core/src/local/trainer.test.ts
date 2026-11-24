import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors";
import type { TrainerEvent } from "../types";
import { GpuLock } from "./gpu";
import { LoraShelf } from "./loras";
import { safetensors } from "./testing";
import {
	type BaseModel,
	type RunProgram,
	sampleEvery,
	samplePrompt,
	Trainer,
	type TrainingRequest,
	trainingProgress,
	trainingStage,
} from "./trainer";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

const temp = async () => {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-trainer-"));
	dirs.push(dir);
	return dir;
};

describe("reading the trainer's output", () => {
	test("progress comes from the steps bar, with the time left", () => {
		expect(
			trainingProgress(
				"steps:  10%|█         | 80/800 [01:00<09:05,  1.33it/s, avr_loss=0.1]",
			),
		).toEqual({ step: 80, steps: 800, secondsLeft: 545 });
		expect(
			trainingProgress("steps:   0%|          | 0/800 [00:00<?, ?it/s]"),
		).toEqual({ step: 0, steps: 800, secondsLeft: null });
		expect(
			trainingProgress(" 50%|█████     | 8/16 [00:06<00:05,  1.57it/s]"),
		).toBeNull();
	});

	test("a line full of steps bars is read quickly", () => {
		const started = performance.now();
		expect(trainingProgress(`${"steps:".repeat(50_000)}|`)).toBeNull();
		expect(trainingProgress(`steps: |${"9".repeat(100_000)}`)).toBeNull();
		expect(trainingProgress(`steps: | 1/2 [${"9".repeat(100_000)}`)).toBeNull();
		expect(performance.now() - started).toBeLessThan(500);
		expect(
			trainingProgress(
				`steps: | x | ${"steps:".repeat(10)}| 3/9 [00:01<00:02, 1it/s]`,
			),
		).toEqual({ step: 3, steps: 9, secondsLeft: 2 });
	});

	test("stages come from what it says it does", () => {
		expect(trainingStage("INFO caching latents.")).toBe("caching");
		expect(trainingStage("INFO caching Text Encoder outputs...")).toBe(
			"caching",
		);
		expect(trainingStage("INFO Building U-Net")).toBe("loading");
		expect(trainingStage("saving checkpoint: out/lora.safetensors")).toBe(
			"saving",
		);
		expect(trainingStage("epoch 1/5")).toBeNull();
	});

	test("samples come four times a training, from the trigger and a caption", () => {
		expect(sampleEvery(800)).toBe(200);
		expect(sampleEvery(1000)).toBe(250);
		expect(sampleEvery(100)).toBe(100);
		expect(samplePrompt("qzfox", ["", "a fox -- on a  table"])).toBe(
			"qzfox, a fox - on a table --w 768 --h 768 --s 20 --l 6 --d 42 --n blurry, low quality",
		);
		expect(samplePrompt("qzfox", [""])).toStartWith("qzfox --w");
	});
});

/** A trainer whose downloads and programs are fakes. */
async function setup(
	options: {
		run?: RunProgram;
		freeMemory?: () => Promise<number>;
		ready?: boolean;
		baseModel?: () => Promise<BaseModel>;
		letGo?: () => Promise<void>;
	} = {},
) {
	const dir = await temp();
	const shelfRoot = await temp();
	const gpuRoot = await temp();
	const loras = new LoraShelf({ root: () => shelfRoot });
	const events: TrainerEvent[] = [];
	const trainer = new Trainer({
		dir,
		platform: "linux",
		gpu: new GpuLock({ root: gpuRoot, capacity: async () => 12 * 2 ** 30 }),
		loras,
		baseModel:
			options.baseModel ??
			(async () => ({
				file: "/models/sdxl.safetensors",
				scratch: "/models/tmp",
			})),
		fetch: async () => new Response("not used", { status: 404 }),
		run: options.run ?? (() => fakeProgram([], 0)),
		freeMemory: options.freeMemory ?? (async () => 8 * 2 ** 30),
		memoryCheckMs: 5,
		letGo: options.letGo,
	});
	trainer.subscribe((event) => events.push(event));
	if (options.ready !== false) {
		await Bun.write(
			join(dir, "ready.json"),
			JSON.stringify({
				version: "sd-scripts-cb70b96+torch-2.14.1-cu130+py3.11",
			}),
		);
	}
	return { dir, trainer, loras, events };
}

function fakeProgram(
	lines: string[],
	code: number,
	before?: () => Promise<void>,
): ReturnType<RunProgram> {
	let finish!: (code: number) => void;
	const exited = new Promise<number>((resolve) => {
		finish = resolve;
	});
	let killed = false;
	return {
		output: (async function* () {
			for (const line of lines) {
				if (killed) break;
				if (line === "WAIT") {
					await new Promise((resolve) => setTimeout(resolve, 60));
					continue;
				}
				yield line;
			}
			if (!killed) await before?.();
			finish(killed ? 137 : code);
		})(),
		exited,
		kill: () => {
			killed = true;
			finish(137);
		},
	};
}

const request = (over: Partial<TrainingRequest> = {}): TrainingRequest => ({
	name: "Porcelain",
	trigger: "qzporcelain",
	steps: 800,
	pictures: [1, 2, 3].map((n) => ({
		data: new Uint8Array([n]),
		extension: "png",
		caption: n === 1 ? "a fox  figurine" : "",
	})),
	...over,
});

async function settled(trainer: Trainer) {
	for (;;) {
		const { training } = await trainer.status();
		if (training && training.state !== "running") return training;
		await Bun.sleep(5);
	}
}

describe("training", () => {
	test("a LoRA is trained from captioned pictures and lands on the shelf", async () => {
		let argv: string[] = [];
		const dataset: { captions: string[]; toml: string } = {
			captions: [],
			toml: "",
		};
		const { trainer, loras, dir } = await setup({
			run: (args) => {
				argv = args;
				const out = args[args.indexOf("--output_dir") + 1] as string;
				const toml = args[args.indexOf("--dataset_config") + 1] as string;
				return fakeProgram(
					[
						"INFO caching latents.",
						"steps:  50%|█   | 400/800 [05:00<05:00,  1.33it/s]",
						"steps: 100%|████| 800/800 [10:00<00:00,  1.33it/s]",
					],
					0,
					async () => {
						const pictures = join(dir, "runs");
						const [run] = await readdir(pictures);
						const folder = join(
							pictures,
							run as string,
							"dataset",
							"10_subject",
						);
						Object.assign(dataset, {
							toml: await Bun.file(toml).text(),
							captions: await Promise.all(
								["000", "001", "002"].map((n) =>
									Bun.file(join(folder, `${n}.txt`)).text(),
								),
							),
						});
						await mkdir(out, { recursive: true });
						await Bun.write(
							join(out, "lora.safetensors"),
							safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"], {
								"modelspec.title": "Porcelain",
								ss_tag_frequency: JSON.stringify({
									"10_subject": { qzporcelain: 3 },
								}),
								ss_dataset_dirs: JSON.stringify({
									"10_subject": { img_count: 3 },
								}),
							}),
						);
					},
				);
			},
		});
		const started = await trainer.train(request());
		expect(started).toMatchObject({ state: "running", steps: 800 });
		const done = await settled(trainer);
		expect(done).toMatchObject({
			state: "done",
			step: 800,
			loraId: "porcelain",
		});
		expect(await loras.get("porcelain")).toMatchObject({
			base: "sdxl",
			trigger: "qzporcelain",
		});
		// The trigger leads every caption.
		expect(dataset.captions).toEqual([
			"qzporcelain, a fox figurine",
			"qzporcelain",
			"qzporcelain",
		]);
		expect(dataset.toml).toContain("num_repeats = 10");
		// SDXL kept small enough not to freeze the computer.
		for (const flag of [
			"--lowram",
			"--full_bf16",
			"--network_train_unet_only",
		]) {
			expect(argv).toContain(flag);
		}
		expect(argv[argv.indexOf("--max_train_steps") + 1]).toBe("800");
		expect(argv[argv.indexOf("--pretrained_model_name_or_path") + 1]).toBe(
			"/models/sdxl.safetensors",
		);
		// What it wrote for the run is gone.
		expect(await readdir(join(dir, "runs"))).toEqual([]);
	});

	test("training stops before the computer runs out of memory", async () => {
		const { trainer } = await setup({
			run: () => fakeProgram(["WAIT", "WAIT", "WAIT", "WAIT"], 0),
			freeMemory: async () => 512 * 2 ** 20,
		});
		await trainer.train(request());
		expect(await settled(trainer)).toMatchObject({
			state: "failed",
			error: { code: "trainingOutOfMemory" },
		});
	});

	test("a failing trainer says why; a canceled one is canceled", async () => {
		const failing = await setup({
			run: () =>
				fakeProgram(
					["Traceback", "RuntimeError: CUDA error: out of memory"],
					1,
				),
		});
		await failing.trainer.train(request());
		expect(await settled(failing.trainer)).toMatchObject({
			state: "failed",
			error: {
				code: "trainingFailed",
				params: { reason: "RuntimeError: CUDA error: out of memory" },
			},
		});

		const canceled = await setup({
			run: () => fakeProgram(["WAIT", "WAIT", "WAIT", "WAIT", "WAIT"], 0),
		});
		await canceled.trainer.train(request());
		canceled.trainer.cancelTraining();
		expect(await settled(canceled.trainer)).toMatchObject({
			state: "canceled",
		});
	});

	test("what cannot be trained is refused before anything starts", async () => {
		const missing = await setup({ ready: false });
		await expect(missing.trainer.train(request())).rejects.toMatchObject({
			code: "trainerMissing",
		});
		const { trainer } = await setup();
		await expect(
			trainer.train(request({ pictures: request().pictures.slice(0, 2) })),
		).rejects.toMatchObject({ code: "trainingNeedsPictures" });
		for (const trigger of ["a", "two words", "<lora:x:1>", "x".repeat(41)]) {
			await expect(trainer.train(request({ trigger }))).rejects.toThrow(
				"trigger",
			);
		}
		await expect(trainer.train(request({ steps: 50 }))).rejects.toThrow(
			"Steps",
		);
		// One at a time.
		const busy = await setup({
			run: () => fakeProgram(["WAIT", "WAIT", "WAIT"], 0),
		});
		await busy.trainer.train(request());
		await expect(busy.trainer.train(request())).rejects.toMatchObject({
			code: "trainerBusy",
		});
		busy.trainer.cancelTraining();
		await settled(busy.trainer);
	});

	test("two requests at once start one training, and no install starts under it", async () => {
		const { trainer } = await setup({
			run: () => fakeProgram(["WAIT", "WAIT", "WAIT"], 0),
		});
		const results = await Promise.allSettled([
			trainer.train(request()),
			trainer.train(request()),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		await expect(trainer.install()).rejects.toMatchObject({
			code: "trainerBusy",
		});
		trainer.cancelTraining();
		await settled(trainer);
	});

	test("the model is given to the scripts under a name they can read", async () => {
		const models = await temp();
		const blob = join(models, "31e35c80");
		await Bun.write(blob, "weights");
		let given = "";
		let read = "";
		const { trainer } = await setup({
			baseModel: async () => ({ file: blob, scratch: join(models, "tmp") }),
			run: (args) => {
				given = args[
					args.indexOf("--pretrained_model_name_or_path") + 1
				] as string;
				return fakeProgram([], 1, async () => {
					read = await Bun.file(given).text();
				});
			},
		});
		await trainer.train(request());
		await settled(trainer);
		expect(given).toEndWith(".safetensors");
		expect(given.startsWith(join(models, "tmp"))).toBe(true);
		expect(read).toBe("weights");
		// The model itself is untouched, and the link is gone.
		expect(await Bun.file(blob).text()).toBe("weights");
		expect(await readdir(join(models, "tmp"))).toEqual([]);
	});

	test("without the SDXL model there is nothing to train on", async () => {
		const { trainer } = await setup({
			baseModel: async () => {
				throw new ValidationError("Install SDXL", "trainingNeedsBase");
			},
		});
		await expect(trainer.train(request())).rejects.toMatchObject({
			code: "trainingNeedsBase",
		});
		expect((await trainer.status()).training).toBeNull();
	});
});

describe("installing", () => {
	test("a download that does not match its hash fails the install, saying so", async () => {
		const dir = await temp();
		const trainer = new Trainer({
			dir,
			platform: "linux",
			gpu: new GpuLock({ root: await temp(), capacity: async () => null }),
			loras: new LoraShelf({ root: () => dir }),
			baseModel: async () => ({ file: "x", scratch: "y" }),
			fetch: async () => new Response("not uv"),
		});
		expect((await trainer.status()).state).toBe("missing");
		await trainer.install();
		expect((await trainer.status()).state).toBe("installing");
		for (;;) {
			const status = await trainer.status();
			if (status.state !== "installing") {
				expect(status).toMatchObject({
					state: "missing",
					error: { code: "hashMismatch" },
				});
				break;
			}
			await Bun.sleep(5);
		}
	});
});

/** A LoRA file as the scripts write it. */
const loraFile = (which = "final") =>
	safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"], {
		"modelspec.title": "Porcelain",
		which,
	});

/**
 * The scripts at work: a sample and a saved LoRA every 200 of 800 steps,
 * then the last one, unless they are stopped first.
 */
function trainingWithSamples(args: string[], pause = false) {
	const out = args[args.indexOf("--output_dir") + 1] as string;
	const lines: string[] = [];
	for (const step of [200, 201, 400, 401, 600, 601, 800]) {
		lines.push(`steps: ${step / 8}%| | ${step}/800 [01:00<01:00, 1.3it/s]`);
		if (pause && step === 401)
			lines.push("WAIT", "WAIT", "WAIT", "WAIT", "WAIT", "WAIT");
	}
	let written = 0;
	const program = fakeProgram(lines, 0, async () => {
		await Bun.write(join(out, "lora.safetensors"), loraFile());
	});
	// Each sample and save lands as its step's line goes by.
	const output = (async function* () {
		for await (const line of program.output) {
			const step = Number(line.match(/\| (\d+)\/800/)?.[1]);
			if (step % 200 === 0 && step > written) {
				written = step;
				const name = String(step).padStart(6, "0");
				await Bun.write(
					join(out, "sample", `lora_${name}_00_20261119160000_42.png`),
					`sample ${step}`,
				);
				await Bun.write(
					join(out, `lora-step${String(step).padStart(8, "0")}.safetensors`),
					loraFile(`step ${step}`),
				);
			}
			yield line;
		}
	})();
	return { ...program, output };
}

describe("watching a training", () => {
	test("samples show how it learns, and stay after it ends", async () => {
		let argv: string[] = [];
		let let_go = 0;
		const { trainer } = await setup({
			letGo: async () => {
				let_go++;
			},
			run: (args) => {
				argv = args;
				return trainingWithSamples(args);
			},
		});
		const view = await trainer.train(request());
		const done = await settled(trainer);
		expect(done).toMatchObject({
			state: "done",
			samples: [200, 400, 600, 800],
		});
		expect(argv[argv.indexOf("--sample_every_n_steps") + 1]).toBe("200");
		expect(argv[argv.indexOf("--save_every_n_steps") + 1]).toBe("200");
		const prompts = argv[argv.indexOf("--sample_prompts") + 1] as string;
		expect(prompts).toEndWith("samples.txt");
		// What was kept loaded let go first.
		expect(let_go).toBe(1);
		const file = trainer.sampleFile(view.id, 400);
		expect(await Bun.file(file as string).text()).toBe("sample 400");
		expect(trainer.sampleFile(view.id, 300)).toBeNull();
		expect(trainer.sampleFile("another", 400)).toBeNull();
	});

	test("a training stopped at a saved step keeps that LoRA", async () => {
		const { trainer, loras } = await setup({
			run: (args) => trainingWithSamples(args, true),
		});
		expect(() => trainer.finishTraining()).toThrow("Nothing is saved");
		await trainer.train(request());
		// Step 400 is whole once the steps go past it.
		for (;;) {
			const { training } = await trainer.status();
			if (training?.savedStep === 400) break;
			await Bun.sleep(5);
		}
		trainer.finishTraining();
		const done = await settled(trainer);
		expect(done).toMatchObject({
			state: "done",
			keptStep: 400,
			loraId: "porcelain",
		});
		// The step's own LoRA, not the last one.
		const kept = await Bun.file(loras.path("porcelain")).text();
		expect(kept).toContain("step 400");
	});

	test("asked to keep a step at the very end, it keeps the whole LoRA", async () => {
		let trainer!: Trainer;
		const made = await setup({
			run: (args) => {
				const program = trainingWithSamples(args);
				const output = (async function* () {
					for await (const line of program.output) {
						yield line;
						// The last step's line: it is saving the whole LoRA now.
						if (line.includes("800/800")) trainer.finishTraining();
					}
				})();
				return { ...program, output };
			},
		});
		trainer = made.trainer;
		await trainer.train(request());
		const done = await settled(trainer);
		expect(done).toMatchObject({ state: "done", keptStep: null });
		expect(await Bun.file(made.loras.path("porcelain")).text()).toContain(
			"final",
		);
	});
});

test("running out of graphics memory before the first step is tried once more", async () => {
	let runs = 0;
	const { trainer } = await setup({
		run: (args) => {
			runs++;
			return runs === 1
				? fakeProgram(
						["INFO caching latents.", "Returning 2 (CUDA_ERROR_OUT_OF_MEMORY)"],
						1,
					)
				: trainingWithSamples(args);
		},
	});
	await trainer.train(request());
	expect(await settled(trainer)).toMatchObject({ state: "done" });
	expect(runs).toBe(2);
});
