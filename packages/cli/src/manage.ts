import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type {
	CommercialUse,
	Fit,
	LocalModelStatus,
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
       hatchlight install --cancel <model>

Downloads a model from \`hatchlight catalog\`, with the engine that runs
it, and waits until it is ready. The variant that fits this machine best
is chosen unless --variant names another.

  --variant <id>    A variant from \`hatchlight catalog <model> --json\`
  --cancel          Stop an install that is going on
${COMMON_HELP}`,
		options: {
			variant: { type: "string" },
			cancel: { type: "boolean", default: false },
		},
		interruptible: "once",
		async run(values, positionals, context) {
			const { api, io } = context;
			const [given, ...extra] = positionals;
			if (!given || extra.length > 0) {
				throw new UsageError("Name one model, such as sdxl-turbo.");
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
