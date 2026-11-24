import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import {
	MAX_TRAINING_PICTURES,
	MAX_TRAINING_STEPS,
	MIN_TRAINING_PICTURES,
	MIN_TRAINING_STEPS,
} from "@hatchlight/core";
import type {
	TrainerInstallStep,
	TrainerStatus,
	TrainingStage,
	TrainingView,
} from "@hatchlight/core/types";
import { ASSET_ID } from "@hatchlight/tools";
import type { TrainingPicture } from "./api";
import {
	bytes,
	COMMON_HELP,
	type Command,
	type Context,
	duration,
	EXIT,
	type Io,
	integer,
	json,
	pause,
	UsageError,
} from "./command";

/** Training LoRAs from a terminal: the trainer, and what it trains. */

const PICTURE = /\.(png|jpe?g|webp)$/i;
const DEFAULT_STEPS = 800;

const INSTALL_STEPS: Record<TrainerInstallStep, string> = {
	uv: "getting the Python installer",
	scripts: "getting the training scripts",
	python: "getting Python",
	packages: "getting the packages",
	checking: "checking it works",
};

const STAGES: Record<TrainingStage, string> = {
	waitingGpu: "waiting for the graphics card",
	loading: "loading Stable Diffusion XL",
	caching: "preparing the pictures",
	training: "training",
	saving: "saving the LoRA",
};

function trainingLine(training: TrainingView): string {
	if (training.stage !== "training") return STAGES[training.stage];
	const left =
		training.secondsLeft != null
			? ` · ${duration(training.secondsLeft)} left`
			: "";
	return `step ${training.step} of ${training.steps}${left}`;
}

/** The trainer's state, in a line. */
function trainerLine(status: TrainerStatus): string {
	if (status.state === "missing") {
		return `not installed (about ${bytes(status.downloadBytes)}): hatchlight trainer install`;
	}
	if (status.state === "installing") {
		const install = status.install;
		const received =
			install?.receivedBytes != null && install.totalBytes
				? ` · ${bytes(install.receivedBytes)} of ${bytes(install.totalBytes)}`
				: "";
		return `installing: ${install ? INSTALL_STEPS[install.step] : "starting"}${received}`;
	}
	return "ready";
}

/** Picture files from files and folders, and picture ids as they are. */
async function picturesFrom(io: Io, given: string[]): Promise<string[]> {
	const found: string[] = [];
	for (const item of given) {
		if (ASSET_ID.test(item)) {
			found.push(item);
			continue;
		}
		const path = resolve(io.cwd, item);
		const info = await stat(path).catch(() => null);
		if (!info) throw new UsageError(`Cannot read ${item}.`);
		if (info.isDirectory()) {
			const names = (await readdir(path)).filter((n) => PICTURE.test(n)).sort();
			found.push(...names.map((n) => join(path, n)));
		} else if (PICTURE.test(path)) {
			found.push(path);
		} else {
			throw new UsageError(`${item} is not a PNG, JPEG or WebP picture.`);
		}
	}
	return found;
}

/** The words next to a picture: "dog1.png" is described in "dog1.txt". */
async function captionBeside(path: string): Promise<string | undefined> {
	const text = await readFile(
		join(resolve(path, ".."), `${basename(path, extname(path))}.txt`),
		"utf8",
	).catch(() => null);
	return text?.trim() || undefined;
}

/** Follows a training to its end, saving its samples as they come. */
async function followTraining(
	id: string,
	samples: string | null,
	{ api, io, startedServer, pollMs = 500 }: Context,
): Promise<TrainingView | "interrupted"> {
	const saved = new Set<number>();
	if (samples) await mkdir(samples, { recursive: true });
	const started = Date.now();
	for (;;) {
		const training = (await api.trainer()).training;
		if (!training || training.id !== id) {
			throw new Error("The training is gone");
		}
		for (const step of samples ? training.samples : []) {
			if (saved.has(step)) continue;
			saved.add(step);
			const path = join(
				samples as string,
				`step-${String(step).padStart(5, "0")}.png`,
			);
			// A sample that cannot be had does not stop the following.
			try {
				await writeFile(path, await api.trainingSample(id, step));
				io.err(`Sample at step ${step}: ${path}`);
			} catch (error) {
				io.err(`! No sample at step ${step}: ${(error as Error).message}`);
			}
		}
		if (training.state !== "running") {
			io.status(null);
			return training;
		}
		io.status(
			`${training.name}: ${trainingLine(training)} · ${duration((Date.now() - started) / 1000)}`,
		);
		await pause(Math.max(pollMs, 1000), io.signal);
		if (io.signal.aborted) {
			io.status(null);
			io.err(
				startedServer
					? "Stopped. The training stops too, with the Hatchlight started for this command."
					: "Stopped waiting; it goes on in Hatchlight. `hatchlight trainer finish` keeps what it learned so far, `hatchlight trainer stop` drops it.",
			);
			return "interrupted";
		}
	}
}

export const TRAIN_COMMANDS: Record<string, Command> = {
	trainer: {
		summary: "Install the LoRA trainer, or stop a training",
		usage: `Usage: hatchlight trainer             How the trainer stands
       hatchlight trainer install     Download it (Python and its packages)
       hatchlight trainer remove      Delete it
       hatchlight trainer stop        Stop a training and drop it
       hatchlight trainer finish      Stop a training and keep the LoRA
                                      saved at its latest step

${COMMON_HELP}`,
		options: {},
		interruptible: "once",
		async run(
			values,
			[action, ...extra],
			{ api, io, startedServer, pollMs = 500 },
		) {
			if (extra.length > 0) throw new UsageError("One action at a time.");
			if (action == null) {
				const status = await api.trainer();
				if (values.json) {
					json(io, status);
					return EXIT.ok;
				}
				io.out(`Trainer: ${trainerLine(status)}`);
				if (status.error)
					io.out(`Last install failed: ${status.error.message}`);
				const training = status.training;
				if (training) {
					const state =
						training.state === "running"
							? trainingLine(training)
							: training.state;
					io.out(`Training ${training.name} (${training.trigger}): ${state}`);
					if (training.loraId) io.out(`LoRA: ${training.loraId}`);
				}
				return EXIT.ok;
			}
			if (action === "remove") {
				await api.removeTrainer();
				io.err("The trainer is deleted.");
				return EXIT.ok;
			}
			if (action === "stop") {
				await api.stopTraining();
				io.err("The training is stopped.");
				return EXIT.ok;
			}
			if (action === "finish") {
				await api.finishTraining();
				io.err(
					"The training stops at its latest saved step, and the LoRA is kept.",
				);
				return EXIT.ok;
			}
			if (action !== "install") {
				throw new UsageError("Use install, remove, stop or finish.");
			}
			const before = await api.trainer();
			if (before.state === "ready") {
				io.err("The trainer is already installed.");
				return EXIT.ok;
			}
			if (before.state === "missing") {
				io.err(`Installing the trainer: about ${bytes(before.downloadBytes)}.`);
				await api.installTrainer();
			}
			for (;;) {
				const status = await api.trainer();
				if (status.state === "ready") {
					io.status(null);
					io.err("The trainer is ready. Train a LoRA with: hatchlight train");
					return EXIT.ok;
				}
				if (status.state === "missing") {
					io.status(null);
					io.err(
						`The trainer was not installed: ${status.error?.message ?? "stopped"}`,
					);
					return EXIT.failed;
				}
				io.status(`Trainer: ${trainerLine(status)}`);
				await pause(Math.max(pollMs, 1000), io.signal);
				if (io.signal.aborted) {
					io.status(null);
					// An install the app started is the app's to stop.
					if (before.state === "missing" || startedServer) {
						await api.cancelTrainerInstall().catch(() => {});
						io.err("Stopped installing the trainer.");
					} else {
						io.err("Stopped waiting; the install goes on in Hatchlight.");
					}
					return EXIT.interrupted;
				}
			}
		},
	},

	train: {
		summary: "Teach a model a person, a thing or a style (a LoRA)",
		usage: `Usage: hatchlight train <pictures>... --name <name> --trigger <word> --consent

Trains a LoRA for Stable Diffusion XL from ${MIN_TRAINING_PICTURES} to ${MAX_TRAINING_PICTURES} pictures: files, folders of
them, or picture ids (ast_…). A picture's words come from a .txt file of the
same name beside it ("dog1.png" and "dog1.txt"), or from --describe.

  --name <name>     What to call the LoRA
  --trigger <word>  A word that calls it up in prompts, such as "qzxdog"
  --steps <n>       How long to train, ${MIN_TRAINING_STEPS} to ${MAX_TRAINING_STEPS} (default ${DEFAULT_STEPS})
  --describe        Describe pictures without words with the model that
                    looks at pictures (install it in the app)
  --samples <dir>   Save the pictures it makes along the way, to see it learn
  --consent         The pictures are yours to use, and anyone in them agreed
${COMMON_HELP}`,
		options: {
			name: { type: "string" },
			trigger: { type: "string" },
			steps: { type: "string" },
			describe: { type: "boolean", default: false },
			samples: { type: "string" },
			consent: { type: "boolean", default: false },
		},
		interruptible: "once",
		async run(values, positionals, context) {
			const { api, io } = context;
			const name = (values.name as string | undefined)?.trim();
			const trigger = (values.trigger as string | undefined)?.trim();
			if (!name) throw new UsageError("Give the LoRA a --name.");
			if (!trigger) throw new UsageError("Give a --trigger word.");
			const steps =
				integer(values, "steps", MIN_TRAINING_STEPS, MAX_TRAINING_STEPS) ??
				DEFAULT_STEPS;
			if (values.consent !== true) {
				throw new UsageError(
					"Training needs --consent: say the pictures are yours to use, and that anyone in them agreed.",
				);
			}
			const files = await picturesFrom(io, positionals);
			if (
				files.length < MIN_TRAINING_PICTURES ||
				files.length > MAX_TRAINING_PICTURES
			) {
				throw new UsageError(
					`Training needs ${MIN_TRAINING_PICTURES} to ${MAX_TRAINING_PICTURES} pictures; ${files.length} were given.`,
				);
			}
			const status = await api.trainer();
			if (status.state !== "ready") {
				throw new UsageError(`The trainer is ${trainerLine(status)}`);
			}
			if (status.training?.state === "running") {
				throw new UsageError(
					`${status.training.name} is training now. Wait for it, or stop it with \`hatchlight trainer stop\`.`,
				);
			}
			const describing = values.describe === true;
			if (describing && !(await api.captionerReady())) {
				throw new UsageError(
					"--describe needs the model that looks at pictures (Qwen2.5-VL); install it in the app.",
				);
			}

			const pictures: TrainingPicture[] = [];
			for (const [i, file] of files.entries()) {
				io.status(`Reading pictures: ${i + 1} of ${files.length}`);
				if (ASSET_ID.test(file)) {
					pictures.push({ assetId: file });
					continue;
				}
				const asset = await api.upload(new Uint8Array(await readFile(file)));
				pictures.push({
					assetId: asset.id,
					caption: await captionBeside(file),
				});
			}
			if (describing) {
				const bare = pictures.filter((p) => !p.caption);
				for (const [i, picture] of bare.entries()) {
					io.status(`Describing pictures: ${i + 1} of ${bare.length}`);
					picture.caption = await api.caption(picture.assetId);
				}
			}
			io.status(null);
			const described = pictures.filter((p) => p.caption).length;
			io.err(
				`Training ${name} on ${pictures.length} pictures (${described} with words), ${steps} steps.`,
			);
			if (context.startedServer) {
				io.err(
					"Hatchlight was started for this command: keep this terminal open until the training ends.",
				);
			}
			const started = await api.train({
				name,
				trigger,
				steps,
				pictures,
				consent: true,
			});
			const samples =
				typeof values.samples === "string"
					? resolve(io.cwd, values.samples)
					: null;
			const end = await followTraining(started.id, samples, context);
			if (end === "interrupted") return EXIT.interrupted;
			if (values.json) json(io, end);
			if (end.state === "done" && end.loraId) {
				io.err(
					`The LoRA is ready${end.keptStep != null ? ` (kept at step ${end.keptStep})` : ""}. Use it on an SDXL model with: <lora:${end.loraId}:1> ${end.trigger}`,
				);
				return EXIT.ok;
			}
			io.err(
				end.state === "canceled"
					? "The training was stopped."
					: `The training failed: ${end.error?.message ?? "no reason given"}`,
			);
			return EXIT.failed;
		},
	},
};
