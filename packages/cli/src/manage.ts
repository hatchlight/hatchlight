import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
	type HubUnsupported,
	hubRepoUrl,
	parseHubSpec,
} from "@hatchlight/core/hugging-face";
import type {
	CommercialUse,
	Fit,
	LocalModelEvent,
	LocalModelStatus,
	ModelFolder,
	ModelFolderApp,
} from "@hatchlight/core/types";
import type { Api } from "./api";
import {
	bytes,
	COMMON_HELP,
	type Command,
	type Context,
	EXIT,
	type Io,
	json,
	pause,
	table,
	UsageError,
	type Values,
} from "./command";

/**
 * Setting Hatchlight up from a terminal: keys, models, LoRAs, and a look at
 * how this machine is doing. These are the person's to do; agents cannot.
 */

const FITS: Record<Fit, string> = {
	gpu: "fits the GPU",
	offload: "slower: part in system memory",
	cpu: "very slow: on the CPU",
	none: "does not run here",
};

const FIT_SENTENCES: Record<Fit, string> = {
	gpu: "It fits the GPU.",
	offload: "It runs slower, with part of it in system memory.",
	cpu: "It runs on the CPU, very slowly.",
	none: "It does not run here.",
};

function commercial(use: CommercialUse): string {
	if (use.kind === "allowed") return "any use";
	if (use.kind === "limited") {
		return `paid work below $${use.revenueUsd.toLocaleString("en-US")} a year`;
	}
	return "personal use only";
}

/** A catalog id from what a person may type: "sdxl-turbo" or "local/sdxl-turbo". */
const APPS: Record<ModelFolderApp, string> = {
	comfyui: "ComfyUI",
	a1111: "AUTOMATIC1111, Forge or Forge Neo",
	swarmui: "SwarmUI",
	stabilityMatrix: "Stability Matrix",
};

/** ", 3 files skipped" for files a linked folder has that are not used. */
function skippedText(folder: ModelFolder): string {
	const { unknown, unreadable, tooLarge } = folder.skipped;
	const skipped = unknown + unreadable + tooLarge;
	return skipped > 0
		? `; ${skipped} other files skipped (a family Hatchlight does not run, unreadable or too large)`
		: "";
}

/** A linked folder's id, as the server makes them. */
const FOLDER_ID = /^[0-9a-f]{8}$/;

/** A folder as typed: a full path (`C:\\…` too) stays as it is. */
function fullPath(cwd: string, path: string): string {
	return isAbsolute(path) || /^[a-z]:[\\/]/i.test(path)
		? path
		: resolve(cwd, path);
}

function folderRow(folder: ModelFolder): string[] {
	return [
		folder.id,
		folder.path ?? "",
		folder.app ? APPS[folder.app] : "folder",
		folder.available
			? `${folder.checkpoints} checkpoints, ${folder.loras} LoRAs`
			: "not there now",
		folder.truncated ? "too many files: some left out" : "",
	];
}

const catalogId = (value: string) => value.replace(/^local\//, "");

/** The variant an install picks, or the one installed. */
const variantOf = (model: LocalModelStatus) =>
	model.variants.find((v) => v.id === model.variant);

function stateText(model: LocalModelStatus): string {
	if (model.state === "installed") {
		return model.ready ? "installed" : "installed, engine missing";
	}
	if (model.state === "downloading" && model.size > 0) {
		return `downloading ${Math.floor((model.receivedBytes / model.size) * 100)}%`;
	}
	if (model.error) return "failed";
	return model.state;
}

async function findModel(api: Api, given: string): Promise<LocalModelStatus> {
	const view = await api.localModels();
	const id = catalogId(given);
	const model = view.models.find((m) => m.id === id);
	if (!model) {
		throw new UsageError(
			`No model ${given} in the catalog. See \`hatchlight catalog\`.`,
		);
	}
	return model;
}

/** Waits for a model's install to end, showing how it goes. */
async function followInstall(
	model: LocalModelStatus,
	{ api, io, startedServer, pollMs = 500 }: Context,
): Promise<number> {
	const listening = new AbortController();
	let latest = "";
	void (async () => {
		try {
			for await (const event of api.events(listening.signal)) {
				if (event.type !== "model.progress" || event.id !== model.id) continue;
				const speed =
					event.bytesPerSecond > 0 ? ` · ${bytes(event.bytesPerSecond)}/s` : "";
				latest =
					event.state === "downloading"
						? `${bytes(event.receivedBytes)} of ${bytes(event.size)}${speed}`
						: event.state;
			}
		} catch {
			// Progress is a nicety; the install is followed by asking.
		}
	})();
	try {
		for (;;) {
			io.status(`${model.name}: ${latest || "starting"}`);
			await pause(Math.max(pollMs, 1000), io.signal);
			if (io.signal.aborted) {
				io.status(null);
				if (startedServer) {
					await api.cancelInstall(model.id).catch(() => {});
					io.err(
						`Stopped. What was downloaded is kept: \`hatchlight install ${model.id}\` goes on from there.`,
					);
				} else {
					io.err(
						`Stopped waiting; the download goes on in Hatchlight. Stop it with: hatchlight install --cancel ${model.id}`,
					);
				}
				return EXIT.interrupted;
			}
			const now = (await api.localModels()).models.find(
				(m) => m.id === model.id,
			);
			if (!now) throw new Error(`${model.id} left the catalog`);
			if (now.state === "installed") {
				io.status(null);
				return EXIT.ok;
			}
			if (now.state === "available") {
				io.status(null);
				io.err(`${model.name} was not installed: ${now.error ?? "stopped"}`);
				return EXIT.failed;
			}
		}
	} finally {
		listening.abort();
	}
}

/** Why a repository cannot be opened yet, in a sentence. */
const HUB_REASONS: Record<HubUnsupported, string> = {
	notFound: "There is no such repository, or it is private.",
	gated:
		"Its files are only given to people who accept its terms on Hugging Face.",
	noFile:
		"It has no single model file: models made of many files, such as diffusers folders, are not supported yet.",
	manyFiles: "It has several model files. Name one: hf:<owner>/<repo>/<file>.",
	fileNotFound: "That file is not in the repository.",
	notSafetensors: "Only .safetensors files can be added.",
	unknownFile:
		"The file is not a whole SDXL or SD 1.5 model, nor a LoRA for a model Hatchlight runs.",
	tooLarge: "The file is larger than any model of its kind.",
};

/**
 * `install hf:<owner>/<repo>[/<file>]`: the catalog's install when it is a
 * model the catalog has, else a checkpoint or LoRA file, once the person
 * agreed to its size and license.
 */
async function installFromHub(
	given: string,
	values: Values,
	context: Context,
): Promise<number | string> {
	const { api, io } = context;
	const target = parseHubSpec(given);
	if (!target) {
		throw new UsageError(
			`Not a Hugging Face repository: ${given}. Use hf:<owner>/<repo>, or hf:<owner>/<repo>/<file>.`,
		);
	}
	const choice = await api.openFromHub(target);
	// The catalog's own install takes it from here.
	if (choice.kind === "catalog") return choice.modelId;
	if (values.variant || values.cancel) {
		throw new UsageError(
			"--variant and --cancel are for models in the catalog.",
		);
	}
	if (choice.kind === "unsupported") {
		io.err(
			`${target.repo} cannot be opened in Hatchlight yet. ${HUB_REASONS[choice.reason]} See ${hubRepoUrl(target.repo)}`,
		);
		return EXIT.failed;
	}
	const what =
		choice.kind === "checkpoint"
			? `a whole ${BASE_NAMES[choice.base]} model`
			: `a LoRA for ${BASE_NAMES[choice.base]}`;
	io.err(
		`${choice.file} from ${choice.repo} is ${what}: ${bytes(choice.size)} to download. License: ${choice.license ?? "not stated"} (see ${hubRepoUrl(choice.repo)}).`,
	);
	if (!values.yes) {
		if (!io.interactive) {
			throw new UsageError("Add --yes to download it without being asked.");
		}
		const answer = await io.readLine("Download it? [y/N] ");
		if (!/^y(es)?$/i.test(answer?.trim() ?? "")) {
			io.err("Nothing was downloaded.");
			return EXIT.ok;
		}
	}
	// The download goes on in Hatchlight; its end comes as an event, so the
	// events are listened to before it starts.
	const listening = new AbortController();
	let ready = () => {};
	const listens = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const ended = new Promise<HubEnd>((resolve, reject) => {
		void (async () => {
			try {
				for await (const event of api.events(listening.signal, ready)) {
					if (
						!event.type.startsWith("hub.") ||
						!("repo" in event) ||
						event.repo !== choice.repo ||
						event.file !== choice.file
					) {
						continue;
					}
					if (event.type === "hub.progress") {
						io.status(
							`${choice.file}: ${bytes(event.receivedBytes)} of ${bytes(event.size)}`,
						);
					} else {
						resolve(event as HubEnd);
						return;
					}
				}
				if (!listening.signal.aborted) {
					reject(new Error("Lost touch with Hatchlight during the download."));
				}
			} catch (error) {
				reject(error);
			}
		})();
	});
	ended.catch(() => {});
	const interrupted = new Promise<null>((resolve) => {
		if (io.signal.aborted) resolve(null);
		io.signal.addEventListener("abort", () => resolve(null), { once: true });
	});
	try {
		await Promise.race([listens, ended, interrupted]);
		if (io.signal.aborted) {
			io.err("Stopped. Nothing was downloaded.");
			return EXIT.interrupted;
		}
		await api.startFromHub(choice);
		const end = await Promise.race([ended, interrupted]);
		io.status(null);
		if (!end || end.type === "hub.canceled") {
			await api.cancelFromHub(choice).catch(() => {});
			io.err("Stopped. Nothing was kept.");
			return EXIT.interrupted;
		}
		if (end.type === "hub.failed") {
			io.err(`${choice.file} was not added: ${end.message}`);
			return EXIT.failed;
		}
		const { added } = end;
		if (values.json) json(io, added);
		io.err(
			added.kind === "checkpoint"
				? `Added ${added.item.name}. Use it with: -m local/ckpt-${added.item.id}`
				: `Added ${added.item.name} (${added.item.base}). Use it with <lora:${added.item.id}:1> in a prompt${added.item.trigger ? `, and the word ${added.item.trigger}` : ""}.`,
		);
		return EXIT.ok;
	} catch (error) {
		io.status(null);
		throw error;
	} finally {
		listening.abort();
	}
}

/** How a download from Hugging Face ended. */
type HubEnd = Extract<
	LocalModelEvent,
	{ type: "hub.done" | "hub.failed" | "hub.canceled" }
>;

/** Families of models as people write them. */
const BASE_NAMES: Record<string, string> = {
	sd1: "SD 1.5",
	sdxl: "SDXL",
	flux: "FLUX",
	wan: "Wan",
	"z-image": "Z-Image",
};

/** A key read from the person, or from what is piped in. */
async function keyFrom(io: Io, provider: string): Promise<string> {
	const key = io.interactive
		? await io.readSecret(`Key for ${provider} (not shown): `)
		: await io.readAll();
	const trimmed = key?.trim();
	if (!trimmed) throw new UsageError("No key was given.");
	return trimmed;
}

export const MANAGE_COMMANDS: Record<string, Command> = {
	keys: {
		summary: "Show, set or remove API keys for cloud models",
		usage: `Usage: hatchlight keys
       hatchlight keys set <provider>
       hatchlight keys remove <provider>

Cloud models run on your own keys. \`set\` asks for the key without showing
it, or reads it from standard input:  echo "$FAL_KEY" | hatchlight keys set fal
A key in the environment (FAL_KEY, OPENAI_API_KEY, ...) also works.

${COMMON_HELP}`,
		options: {},
		async run(values, [action, provider, ...extra], { api, io }) {
			const providers = await api.providers();
			if (action == null) {
				const cloud = providers.filter((p) => p.requiresKey);
				if (values.json) {
					json(io, cloud);
					return EXIT.ok;
				}
				for (const line of table(
					cloud.map((p) => [p.id, p.name, p.hasKey ? "set" : "not set"]),
				)) {
					io.out(line);
				}
				return EXIT.ok;
			}
			if ((action !== "set" && action !== "remove") || extra.length > 0) {
				throw new UsageError(
					"Use `keys`, `keys set <provider>` or `keys remove <provider>`.",
				);
			}
			const target = providers.find((p) => p.id === provider);
			if (!target?.requiresKey) {
				const known = providers
					.filter((p) => p.requiresKey)
					.map((p) => p.id)
					.join(", ");
				throw new UsageError(
					`${provider ? `No cloud provider ${provider}` : "Name a provider"}. They are: ${known}.`,
				);
			}
			if (action === "set") {
				await api.setKey(target.id, await keyFrom(io, target.name));
				io.err(`The key for ${target.name} is set.`);
			} else {
				await api.removeKey(target.id);
				io.err(`The key for ${target.name} is removed.`);
			}
			if (values.json) json(io, { provider: target.id, action });
			return EXIT.ok;
		},
	},

	catalog: {
		summary: "List the models that can be installed on this computer",
		usage: `Usage: hatchlight catalog [words] [options]

Lists the models Hatchlight can download and run on this computer, with
what each takes on disk, how it fits this machine and what its license
allows. Words narrow the list.

  --all             Also models that do not run on this machine
${COMMON_HELP}`,
		options: { all: { type: "boolean", default: false } },
		async run(values, positionals, { api, io }) {
			const view = await api.localModels();
			const words = positionals.map((w) => w.toLowerCase());
			const models = view.models.filter(
				(m) =>
					m.media !== "text" &&
					(values.all || m.variant != null) &&
					words.every((w) =>
						`${m.id} ${m.name} ${m.summary}`.toLowerCase().includes(w),
					),
			);
			if (values.json) {
				json(io, models);
				return EXIT.ok;
			}
			if (models.length === 0) {
				io.err("No model matches.");
				return EXIT.ok;
			}
			for (const line of table(
				models.map((m) => {
					const variant = variantOf(m);
					return [
						m.id,
						m.name,
						m.media,
						stateText(m),
						variant ? `${bytes(m.size)} ${variant.label}` : "",
						variant ? FITS[variant.fit] : FITS.none,
						commercial(m.commercial),
					];
				}),
			)) {
				io.out(line);
			}
			io.err(
				`Models are kept in ${view.disk.path} (${bytes(view.disk.freeBytes)} free). Install one with: hatchlight install <id>`,
			);
			return EXIT.ok;
		},
	},

	install: {
		summary: "Download a model to run on this computer",
		usage: `Usage: hatchlight install <model> [options]
       hatchlight install hf:<owner>/<repo>[/<file>] [options]
       hatchlight install --cancel <model>

Downloads a model from \`hatchlight catalog\`, with the engine that runs
it, and waits until it is ready. The variant that fits this machine best
is chosen unless --variant names another.

With hf:, opens a repository on Hugging Face: a model the catalog has is
installed as above; a single SDXL or SD 1.5 checkpoint, or a LoRA, in a
.safetensors file is added after you agree to its size and license.

  --variant <id>    A variant from \`hatchlight catalog <model> --json\`
  --cancel          Stop an install that is going on
  -y, --yes         Download from Hugging Face without asking
${COMMON_HELP}`,
		options: {
			variant: { type: "string" },
			cancel: { type: "boolean", default: false },
			yes: { type: "boolean", short: "y", default: false },
		},
		interruptible: "once",
		async run(values, positionals, context) {
			const { api, io } = context;
			const [named, ...extra] = positionals;
			if (!named || extra.length > 0) {
				throw new UsageError("Name one model, such as sdxl-turbo.");
			}
			let given = named;
			if (named.startsWith("hf:")) {
				const found = await installFromHub(named, values, context);
				if (typeof found === "number") return found;
				given = found;
			}
			const model = await findModel(api, given);
			if (values.cancel) {
				await api.cancelInstall(model.id);
				io.err(`Stopped installing ${model.name}.`);
				return EXIT.ok;
			}
			const variantId = values.variant as string | undefined;
			// Installed without its engine, installing again fetches it.
			if (model.state === "installed" && model.ready) {
				if (variantId && variantId !== model.variant) {
					throw new UsageError(
						`${model.name} is installed as ${model.variant}. To change it, uninstall it first.`,
					);
				}
				io.err(`${model.name} is already installed.`);
				return EXIT.ok;
			}
			const variant = variantId
				? model.variants.find((v) => v.id === variantId)
				: variantOf(model);
			if (!variant) {
				throw new UsageError(
					variantId
						? `${model.name} has no variant ${variantId}; it has ${model.variants.map((v) => v.id).join(", ")}.`
						: `${model.name} does not run on this machine.`,
				);
			}
			if (variant.fit === "none") {
				throw new UsageError(
					`${model.name} (${variant.label}) does not fit this machine's memory.`,
				);
			}
			const size = variantId
				? variant.files
						.filter((f) => !f.present)
						.reduce((s, f) => s + f.size, 0)
				: model.size - model.receivedBytes;
			io.err(
				`Installing ${model.name}, ${variant.label}: about ${bytes(size)} to download. ${FIT_SENTENCES[variant.fit]} License ${model.license}: ${commercial(model.commercial)}.`,
			);
			if (context.startedServer) {
				io.err(
					"Hatchlight was started for this command: Ctrl+C stops the download, and installing again goes on from where it stopped.",
				);
			}
			await api.install(model.id, variantId);
			const code = await followInstall(model, context);
			if (code === EXIT.ok) {
				if (values.json) json(io, { id: model.id, variant: variant.id });
				io.err(`${model.name} is installed. Use it with: -m local/${model.id}`);
			}
			return code;
		},
	},

	uninstall: {
		summary: "Delete a model from this computer",
		usage: `Usage: hatchlight uninstall <model>

Deletes an installed model's files. Files other installed models use stay.

${COMMON_HELP}`,
		options: {},
		async run(values, [given, ...extra], { api, io }) {
			if (!given || extra.length > 0) {
				throw new UsageError("Name one installed model.");
			}
			const model = await findModel(api, given);
			if (model.state !== "installed") {
				throw new UsageError(`${model.name} is not installed.`);
			}
			await api.uninstall(model.id);
			if (values.json)
				json(io, { id: model.id, freedBytes: model.reclaimableBytes });
			io.err(`Deleted ${model.name}; ${bytes(model.reclaimableBytes)} freed.`);
			return EXIT.ok;
		},
	},

	loras: {
		summary: "List, add or remove LoRAs",
		usage: `Usage: hatchlight loras
       hatchlight loras add <file.safetensors>
       hatchlight loras remove <id>

A LoRA teaches a model a style, a person or a thing. Use one by putting
<lora:id:1> in a prompt, with its trigger word if it has one, on a model of
its family (sd1, sdxl, flux, ...). Train your own with \`hatchlight train\`.

${COMMON_HELP}`,
		options: {},
		async run(values, [action, target, ...extra], { api, io }) {
			if (action == null) {
				const loras = await api.loras();
				if (values.json) {
					json(io, loras);
					return EXIT.ok;
				}
				if (loras.length === 0) {
					io.err("No LoRA yet. Add one with: hatchlight loras add <file>");
					return EXIT.ok;
				}
				for (const line of table(
					loras.map((l) => [
						l.id,
						l.name,
						l.base,
						l.trigger ? `trigger: ${l.trigger}` : "",
						bytes(l.size),
					]),
				)) {
					io.out(line);
				}
				return EXIT.ok;
			}
			if (!target || extra.length > 0) {
				throw new UsageError(
					action === "add"
						? "Give one .safetensors file."
						: "Give the id of one LoRA.",
				);
			}
			if (action === "add") {
				const path = resolve(io.cwd, target);
				const data = await readFile(path).catch(() => {
					throw new UsageError(`Cannot read ${target}.`);
				});
				const lora = await api.addLora(basename(path), new Uint8Array(data));
				if (values.json) json(io, lora);
				io.err(
					`Added ${lora.name} (${lora.base}). Use it with <lora:${lora.id}:1> in a prompt${lora.trigger ? `, and the word ${lora.trigger}` : ""}.`,
				);
				return EXIT.ok;
			}
			if (action === "remove") {
				await api.removeLora(target);
				if (values.json) json(io, { id: target, removed: true });
				io.err(`Removed ${target}.`);
				return EXIT.ok;
			}
			throw new UsageError(
				"Use `loras`, `loras add <file>` or `loras remove <id>`.",
			);
		},
	},

	folders: {
		summary:
			"Use the models in ComfyUI, AUTOMATIC1111, Forge, Forge Neo, SwarmUI or Stability Matrix",
		usage: `Usage: hatchlight folders
       hatchlight folders add <folder>
       hatchlight folders remove <id|folder>
       hatchlight folders rescan

Points Hatchlight at another app's folder, or at its models folder. The
SDXL and SD 1.5 checkpoints and the LoRAs for a family Hatchlight runs are
used where they are: nothing is copied, moved or deleted. Other files are
counted as skipped. Hatchlight looks again at startup; \`rescan\` looks now.

${COMMON_HELP}`,
		options: {},
		async run(values, [action, target, ...extra], { api, io }) {
			const show = (folders: ModelFolder[]) => {
				if (values.json) {
					json(io, folders);
					return;
				}
				if (folders.length === 0) {
					io.err(
						"No folder yet. Add one with: hatchlight folders add <folder>",
					);
					return;
				}
				for (const line of table(folders.map(folderRow))) io.out(line);
			};
			if (action == null || action === "rescan") {
				if (target != null) throw new UsageError(`Unexpected ${target}.`);
				show(await (action ? api.rescanModelFolders() : api.modelFolders()));
				return EXIT.ok;
			}
			if (!target || extra.length > 0) {
				throw new UsageError(
					action === "add"
						? "Give one folder."
						: "Give the id or the folder of one linked folder.",
				);
			}
			if (action === "add") {
				const folder = await api.addModelFolder(fullPath(io.cwd, target));
				if (values.json) json(io, folder);
				io.err(
					`Linked ${folder.path ?? target}: ${folder.checkpoints} checkpoints and ${folder.loras} LoRAs${skippedText(folder)}.`,
				);
				return EXIT.ok;
			}
			if (action === "remove") {
				// By its id, else by its path: the server knows a folder by any name.
				await api.removeModelFolder(
					FOLDER_ID.test(target) ? target : fullPath(io.cwd, target),
				);
				if (values.json) json(io, { id: target, removed: true });
				io.err(`Removed ${target}. Its files stay where they are.`);
				return EXIT.ok;
			}
			throw new UsageError(
				"Use `folders`, `folders add <folder>`, `folders remove <id>` or `folders rescan`.",
			);
		},
	},

	doctor: {
		summary: "Check this computer, the models and what is set up",
		usage: `Usage: hatchlight doctor

Says what Hatchlight sees: the graphics card, memory and disk, the engines
and models installed, the keys set, and whether the assistant, the picture
describer and the LoRA trainer are ready, with what to do when something is
missing.

${COMMON_HELP}`,
		options: {},
		async run(values, _, { api, io, url, dataDir, startedServer }) {
			const [view, providers, trainer, captions, brain] = await Promise.all([
				api.localModels(),
				api.providers(),
				api.trainer().catch(() => null),
				api.captionerReady().catch(() => false),
				api.assistantBrain().catch(() => null),
			]);
			const { hardware, disk } = view;
			const installed = view.models.filter((m) => m.state === "installed");
			const keys = providers.filter((p) => p.requiresKey);
			const problems: string[] = [];
			if (hardware.gpus.length === 0) {
				problems.push(
					"No graphics card was found: local models run on the CPU, very slowly.",
				);
			}
			if (disk.freeBytes < 10e9) {
				problems.push(
					`Only ${bytes(disk.freeBytes)} free where models are kept; models take 2 to 30 GB each.`,
				);
			}
			if (installed.length === 0 && !keys.some((k) => k.hasKey)) {
				problems.push(
					"Nothing can make pictures yet: `hatchlight catalog` lists models to install, or set a key with `hatchlight keys set`.",
				);
			}
			// The local language model runs through Windows under WSL, where it
			// can answer prompts but not hold the assistant's conversation.
			const brainOnlyInWindows =
				brain === "local" &&
				view.engines.some(
					(e) => e.installed && e.throughWindows && /llama/i.test(e.name),
				);
			if (brainOnlyInWindows) {
				problems.push(
					"The assistant's model on this computer runs only in the Windows app, not under WSL: `hatchlight chat` here needs a key for OpenAI, Google or OpenRouter.",
				);
			}
			const broken = installed.filter((m) => !m.ready);
			if (broken.length > 0) {
				problems.push(
					`Installed without their engine: ${broken.map((m) => m.id).join(", ")}. Install them again.`,
				);
			}

			if (values.json) {
				json(io, {
					url: startedServer ? null : url,
					dataDir,
					hardware,
					disk,
					engines: view.engines,
					installed: installed.map((m) => m.id),
					keys: Object.fromEntries(keys.map((k) => [k.id, k.hasKey])),
					assistant: brain,
					captions,
					trainer: trainer?.state ?? null,
					problems,
				});
				return EXIT.ok;
			}
			const os = {
				linux: "Linux",
				darwin: "macOS",
				win32: "Windows",
				other: "Another system",
			}[hardware.os];
			const rows: string[][] = [
				[
					"Hatchlight",
					startedServer
						? "not running; started for this check"
						: `running at ${url}`,
				],
				["Data", dataDir],
				[
					"System",
					`${os} ${hardware.arch}${hardware.wsl ? " (WSL)" : ""}, ${bytes(hardware.memoryBytes)} memory`,
				],
				...hardware.gpus.map((gpu) => [
					"GPU",
					`${gpu.name}, ${gpu.freeBytes != null ? `${bytes(gpu.freeBytes)} free of ${bytes(gpu.memoryBytes)}` : bytes(gpu.memoryBytes)}${gpu.driver ? `, driver ${gpu.driver}` : ""}`,
				]),
				[
					"Models",
					`${disk.path}: ${bytes(disk.usedBytes)} used, ${bytes(disk.freeBytes)} free`,
				],
				...view.engines
					.filter((e) => e.installed)
					.map((e) => [
						"Engine",
						`${e.name} ${e.version} (${e.backend}${e.throughWindows ? ", through Windows" : ""})`,
					]),
				[
					"Installed",
					installed.length > 0
						? installed.map((m) => m.id).join(", ")
						: "nothing yet",
				],
				[
					"Keys",
					keys.map((k) => `${k.id} ${k.hasKey ? "set" : "-"}`).join(", "),
				],
				[
					"Assistant",
					brainOnlyInWindows
						? "only in the Windows app (see below)"
						: brain
							? `thinks with ${brain}`
							: "nothing to think with: install a local text model or set a key",
				],
				[
					"Captions",
					captions
						? "ready"
						: "not installed (a picture-reading model, for training)",
				],
				[
					"Trainer",
					trainer == null
						? "not here"
						: trainer.state === "ready"
							? "ready"
							: trainer.state === "installing"
								? "installing"
								: `not installed: hatchlight trainer install (${bytes(trainer.downloadBytes)})`,
				],
			];
			for (const line of table(rows)) io.out(line);
			for (const problem of problems) io.err(`! ${problem}`);
			return EXIT.ok;
		},
	},
};
