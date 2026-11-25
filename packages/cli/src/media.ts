import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import { findLibraryEntry, libraryModel } from "@hatchlight/core/library";
import {
	CONSISTENT_SCORE,
	type EngineEvent,
	GUIDE_KINDS,
	type GuideKind,
	type JobView,
	type LibraryEntry,
	type LibraryKind,
	MAX_CHARACTER_REFERENCES,
	type ModelSpec,
	PROMPT_KINDS,
	type ProgressStage,
	type PromptKind,
	RANKING_PERIODS,
	type RankingPeriod,
	type TurnView,
} from "@hatchlight/core/types";
import {
	ASSET_ID,
	bestLocalModel,
	done,
	estimate,
	ID,
	isLocal,
	money,
	usableModels,
} from "@hatchlight/tools";
import type { Api } from "./api";
import {
	COMMON_HELP,
	type Command,
	type Context,
	duration,
	EXIT,
	type Io,
	id,
	integer,
	json,
	jsonLine,
	table,
	UsageError,
	type Values,
} from "./command";

/**
 * Making and finding pictures and videos. Models are picked the way agents
 * pick them: free local ones unless paid ones are allowed.
 */

function cost(model: ModelSpec): string {
	if (isLocal(model)) return "free";
	if (model.pricing?.usdPerOutput != null) {
		return `$${model.pricing.usdPerOutput}/${model.media}`;
	}
	if (model.pricing?.usdPerSecond != null) {
		return `$${model.pricing.usdPerSecond}/s`;
	}
	return "paid";
}

const EXTENSIONS: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/bmp": ".bmp",
	"video/mp4": ".mp4",
	"video/webm": ".webm",
};

/** The file name extension for a type, such as ".png". */
export function extension(mime: string): string {
	return (
		EXTENSIONS[mime] ?? `.${mime.split("/")[1]?.split(/[;+]/)[0] ?? "bin"}`
	);
}

async function isDirectory(path: string): Promise<boolean> {
	return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** Whether a target names one file rather than a folder to put files in. */
export async function namesFile(target: string): Promise<boolean> {
	return (
		!target.endsWith("/") &&
		!target.endsWith("\\") &&
		extname(target) !== "" &&
		!(await isDirectory(target))
	);
}

const manyToFile = (target: string) =>
	new UsageError(
		`More than one result cannot go in ${target}; give a folder to --output.`,
	);

/**
 * Writes assets to files. `target` is a folder, or a file when there is
 * one asset; folders are made as needed. Existing files are kept unless
 * `force`.
 */
export async function save(
	api: Api,
	ids: string[],
	target: string,
	force: boolean,
): Promise<string[]> {
	const asFolder = !(await namesFile(target));
	if (!asFolder && ids.length > 1) throw manyToFile(target);
	if (asFolder) {
		await mkdir(target, { recursive: true }).catch((error) => {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			throw new UsageError(`${target} is a file, not a folder.`);
		});
	}
	const paths: string[] = [];
	for (const id of ids) {
		const { data, mime } = await api.asset(id);
		const path = asFolder ? join(target, `${id}${extension(mime)}`) : target;
		if (!asFolder) await mkdir(resolve(path, ".."), { recursive: true });
		try {
			await writeFile(path, data, { flag: force ? "w" : "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			throw new UsageError(`${path} exists; pass --force to replace it.`);
		}
		paths.push(path);
	}
	return paths;
}

/** Picture ids as they are; files read and uploaded. */
export async function references(
	api: Api,
	io: Io,
	given: string[],
): Promise<string[]> {
	const ids: string[] = [];
	for (const item of given) {
		if (ASSET_ID.test(item)) {
			ids.push(item);
			continue;
		}
		const path = resolve(io.cwd, item);
		const data = await readFile(path).catch(() => {
			throw new UsageError(`Cannot read ${item}: not a picture id or a file.`);
		});
		ids.push((await api.upload(new Uint8Array(data))).id);
	}
	return ids;
}

/** The person's entry a name or id means; refused when it means several. */
export function libraryEntryNamed(
	entries: LibraryEntry[],
	kind: LibraryKind,
	name: string,
): LibraryEntry {
	const byId = entries.find((e) => e.id === name && e.kind === kind);
	if (byId) return byId;
	const found = findLibraryEntry(entries, kind, name);
	if (found.entry) return found.entry;
	throw new UsageError(
		found.matches.length > 0
			? `"${name}" could be ${found.matches.map((e) => e.name).join(" or ")}: give the whole name.`
			: `No ${kind} named ${name}. See \`hatchlight library\`.`,
	);
}

const seconds = (job: JobView) =>
	job.startedAt && job.finishedAt
		? `${((job.finishedAt - job.startedAt) / 1000).toFixed(1)} s`
		: "";

/** A job's line: its model, how it stands, and what it made. */
function jobRow(job: JobView, models: ModelSpec[]): string[] {
	const name = models.find((m) => m.id === job.modelId)?.name ?? job.modelId;
	const state =
		job.status === "failed" && job.error
			? `failed: ${job.error}`
			: job.status === "succeeded"
				? `done ${seconds(job)}`.trim()
				: job.status;
	const paid = job.costUsd ? money(job.costUsd) : "";
	return [
		`  ${job.id}`,
		name,
		state,
		paid,
		job.assets.map((a) => a.id).join(" "),
	];
}

function turnLines(turn: TurnView, models: ModelSpec[]): string[] {
	return [
		`Turn ${turn.id}: "${turn.prompt}"`,
		...table(turn.jobs.map((job) => jobRow(job, models))),
	];
}

const STAGES: Record<ProgressStage, string> = {
	queued: "in line",
	retrying: "trying again",
	translating: "translating the prompt",
	waitingGpu: "waiting for the graphics card",
	starting: "starting",
	loading: "loading the model",
	lowMemory: "low on graphics memory",
	generating: "generating",
};

type Progress = Extract<EngineEvent, { type: "job.progress" }>;

function progressText(job: JobView, progress: Progress | undefined): string {
	if (job.status === "succeeded") return "done";
	if (job.status !== "queued" && job.status !== "running") return job.status;
	if (!progress) return job.status === "queued" ? "in line" : "running";
	if (progress.stage === "queued" && progress.position != null) {
		return `in line (position ${progress.position})`;
	}
	if (progress.step != null && progress.steps != null) {
		return `step ${progress.step} of ${progress.steps}`;
	}
	if (progress.fraction != null && progress.stage !== "queued") {
		return `${Math.round(progress.fraction * 100)}%`;
	}
	return progress.stage ? STAGES[progress.stage] : "running";
}

interface GenerateInput {
	prompt: string;
	modelIds: string[];
	references: string[];
	sessionId?: string;
	aspectRatio?: string;
	count?: number;
	seed?: number;
	durationSeconds?: number;
	strength?: number;
	characterId?: string;
	styleId?: string;
	/** A picture to follow the outlines, pose or depth of. */
	guide?: { image: string; kind: GuideKind; ready: boolean; strength?: number };
}

/** The guide asked for with --guide and its options, checked. */
function guideOf(values: Values): GenerateInput["guide"] {
	const kind = values["guide-kind"] as string | undefined;
	const given = values["guide-strength"] as string | undefined;
	// An empty value is no number, not 0.
	const strength =
		given == null
			? undefined
			: given.trim() === ""
				? Number.NaN
				: Number(given);
	if (values.guide == null) {
		if (kind != null || strength != null || values["guide-map"] === true) {
			throw new UsageError(
				"--guide-kind, --guide-map and --guide-strength need --guide.",
			);
		}
		return undefined;
	}
	if (kind != null && !(GUIDE_KINDS as readonly string[]).includes(kind)) {
		throw new UsageError(
			`--guide-kind takes ${GUIDE_KINDS.join(", ")}, not ${kind}.`,
		);
	}
	if (
		strength != null &&
		!(Number.isFinite(strength) && strength >= 0 && strength <= 1)
	) {
		throw new UsageError("--guide-strength takes a number from 0 to 1.");
	}
	return {
		image: values.guide as string,
		kind: (kind as GuideKind | undefined) ?? "outlines",
		ready: values["guide-map"] === true,
		...(strength != null && { strength }),
	};
}

/** Makes a turn and, unless told not to, follows it to the end. */
async function make(
	input: GenerateInput,
	models: ModelSpec[],
	values: Values,
	{ api, io, startedServer, pollMs = 500 }: Context,
): Promise<number> {
	const wait = values.wait !== false;
	if (!wait && startedServer) {
		throw new UsageError(
			"--no-wait needs Hatchlight running already: a server started for this command stops with it. Start it with `hatchlight`.",
		);
	}
	const chosen = input.modelIds.map(
		(id) => models.find((m) => m.id === id) as ModelSpec,
	);
	const paid = chosen.reduce(
		(sum, m) =>
			sum + (estimate(m, input.count ?? 1, input.durationSeconds) ?? 0),
		0,
	);
	// Checked before anything is made: results that cannot be saved as asked
	// would otherwise be made, and paid for, for nothing.
	const output =
		typeof values.output === "string" ? resolve(io.cwd, values.output) : null;
	if (
		output &&
		input.modelIds.length * (input.count ?? 1) > 1 &&
		(await namesFile(output))
	) {
		throw manyToFile(output);
	}
	if (paid > 0) io.err(`This may cost about ${money(paid)}.`);

	const referenceIds = await references(api, io, input.references);
	const [guideId] = input.guide
		? await references(api, io, [input.guide.image])
		: [];
	// Listened to before the turn starts, so no progress is missed.
	const listening = new AbortController();
	const progress = new Map<string, Progress>();
	const stopListening = () => listening.abort();
	io.signal.addEventListener("abort", stopListening);
	if (wait) {
		void (async () => {
			try {
				for await (const event of api.events(listening.signal)) {
					if (event.type === "job.progress") progress.set(event.jobId, event);
				}
			} catch {
				// Progress is a nicety; the jobs are followed by asking.
			}
		})();
	}

	try {
		const { session, turn } = await api.createTurn({
			prompt: input.prompt,
			modelIds: input.modelIds,
			referenceAssetIds: referenceIds,
			...(input.sessionId && { sessionId: input.sessionId }),
			...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
			...(input.count != null && { count: input.count }),
			...(input.seed != null && { seed: input.seed }),
			...(input.durationSeconds != null && {
				durationSeconds: input.durationSeconds,
			}),
			...(input.strength != null && { strength: input.strength }),
			...(input.characterId && { characterId: input.characterId }),
			...(input.styleId && { styleId: input.styleId }),
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
		});

		let jobs = turn.jobs;
		const nameOf = (job: JobView) =>
			models.find((m) => m.id === job.modelId)?.name ?? job.modelId;
		const started = Date.now();
		const interrupted = new Promise<void>((stop) =>
			io.signal.addEventListener("abort", () => stop(), { once: true }),
		);
		while (wait && !done(jobs) && !io.signal.aborted) {
			const elapsed = Math.round((Date.now() - started) / 1000);
			io.status(
				`${jobs.map((job) => `${nameOf(job)}: ${progressText(job, progress.get(job.id))}`).join(" · ")} · ${elapsed}s`,
			);
			await Promise.race([Bun.sleep(pollMs), interrupted]);
			if (io.signal.aborted) break;
			const current = (await api.session(session.id)).turns.find(
				(t) => t.id === turn.id,
			);
			if (current) jobs = current.jobs;
		}
		io.status(null);

		const saved = new Map<string, string>();
		const made = jobs.flatMap((job) => job.assets.map((a) => a.id));
		// What was made is said even when saving fails: it was made, and
		// perhaps paid for, and can still be saved with `get`.
		let notSaved: string | null = null;
		if (output && made.length > 0) {
			try {
				const paths = await save(api, made, output, values.force === true);
				for (const [i, asset] of made.entries()) {
					saved.set(asset, paths[i] as string);
				}
			} catch (error) {
				notSaved = (error as Error).message;
			}
		}
		// A server started for this command is gone once it ends: its address
		// would lead nowhere.
		const url = startedServer ? null : api.sessionUrl(session.id);

		if (values.json) {
			(values.batch == null ? json : jsonLine)(io, {
				sessionId: session.id,
				turnId: turn.id,
				url,
				done: done(jobs),
				jobs: jobs.map((job) => ({
					id: job.id,
					modelId: job.modelId,
					status: job.status,
					error: job.error,
					costUsd: job.costUsd,
					assets: job.assets.map((a) => ({
						id: a.id,
						mime: a.mime,
						...(saved.has(a.id) && { path: saved.get(a.id) }),
					})),
				})),
			});
		} else {
			io.out(url ? `Session ${session.id} · ${url}` : `Session ${session.id}`);
			for (const line of turnLines({ ...turn, jobs }, models).slice(1)) {
				io.out(line);
			}
			for (const [asset, path] of saved) io.out(`Saved ${asset} to ${path}`);
		}

		if (notSaved) {
			io.err(`Not saved: ${notSaved} Save it with \`hatchlight get\`.`);
			return EXIT.failed;
		}
		if (io.signal.aborted) {
			io.err(
				startedServer
					? "Stopped. The server started for this command stops too, and what was not done with it."
					: `Stopped waiting; it goes on. See how it stands with: hatchlight status ${session.id}`,
			);
			return EXIT.interrupted;
		}
		if (!wait) {
			if (!values.json) {
				io.err(
					`Started. See how it stands with: hatchlight status ${session.id}`,
				);
			}
			return EXIT.ok;
		}
		return jobs.every((j) => j.status === "succeeded") ? EXIT.ok : EXIT.failed;
	} finally {
		io.signal.removeEventListener("abort", stopListening);
		listening.abort();
	}
}

/** The prompts to make: the words given, or each line of a batch. */
async function promptsOf(
	values: Values,
	positionals: string[],
	io: Io,
): Promise<string[]> {
	const words = positionals.join(" ").trim();
	if (values.batch == null) {
		if (!words) throw new UsageError("Say what to make.");
		return [words];
	}
	if (words) {
		throw new UsageError("Give a prompt or --batch, not both.");
	}
	const source = values.batch as string;
	const text =
		source === "-"
			? await io.readAll()
			: await readFile(resolve(io.cwd, source), "utf8").catch(() => {
					throw new UsageError(`Cannot read ${source}.`);
				});
	const prompts = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	if (prompts.length === 0) {
		throw new UsageError(`${source} has no prompts.`);
	}
	return prompts;
}

const PAID_HELP = `  --allow-paid      Also use paid cloud models, on your own API keys`;
const WAIT_HELP = `  -o, --output <p>  Save what is made: to a folder, or a file for one result
  --force           Replace files that exist
  --no-wait         Return at once; follow it with \`hatchlight status\`
                    (needs Hatchlight running already)
  --session <id>    Add to an existing session`;

const WAIT_OPTIONS: ParseArgsOptionsConfig = {
	output: { type: "string", short: "o" },
	force: { type: "boolean", default: false },
	wait: { type: "boolean", default: true },
	"no-wait": { type: "boolean", default: false },
	session: { type: "string" },
	"allow-paid": { type: "boolean", default: false },
};

export const MEDIA_COMMANDS: Record<string, Command> = {
	models: {
		summary: "List the models that can be used now",
		usage: `Usage: hatchlight models [options]

Lists installed local models, and cloud models that have an API key. Local
models are free and run on this computer.

  --media <m>       Only models that make image or video
${COMMON_HELP}`,
		options: { media: { type: "string" } },
		async run(values, _, { api, io }) {
			const media = values.media;
			if (media != null && media !== "image" && media !== "video") {
				throw new UsageError("--media is image or video.");
			}
			const models = (await usableModels(api, true)).filter(
				(m) => media == null || m.media === media,
			);
			if (values.json) {
				json(io, models);
				return EXIT.ok;
			}
			if (models.length === 0) {
				io.err(
					"No model can be used yet. Install a local model with `hatchlight install`, or add an API key with `hatchlight keys set`.",
				);
				return EXIT.ok;
			}
			for (const line of table(
				models.map((m) => [m.id, m.name, m.media, cost(m)]),
			)) {
				io.out(line);
			}
			return EXIT.ok;
		},
	},

	generate: {
		summary: "Make pictures or videos from a prompt",
		usage: `Usage: hatchlight generate <prompt> [options]
       hatchlight generate --batch <file> [options]

Makes pictures or videos, waits for them, and prints their ids. Without
--model, the best free local model that fits is used.

  --batch <file>    One prompt per line, made one after another with the
                    same options; "-" reads them from standard input. Empty
                    lines and lines starting with # are skipped. With
                    --json, one line of JSON per prompt.
  -m, --model <id>  A model from \`hatchlight models\`; repeat to compare
  -r, --ref <p>     A picture to start from: an id (ast_…) or a file; repeat
  -n, --count <n>   How many to make with each model (1 to 8)
  --ratio <r>       Aspect ratio, such as 16:9
  --seed <n>        A seed, to make the same again
  --strength <s>    How much a given picture changes, 0.05 to 1
  --guide <p>       A picture whose outlines, pose or depth to follow: an id
                    (ast_…) or a file, for models that follow a guide
  --guide-kind <k>  outlines (default), pose or depth
  --guide-map       The guide already is the map: edges, a pose skeleton or
                    depth. Local models find only outlines themselves
  --guide-strength <s>
                    How closely the guide is followed, 0 to 1
  --duration <s>    Video length in seconds
  --character <n>   A character from \`hatchlight library\`, by name
  --style <n>       A style from \`hatchlight library\`, by name
${WAIT_HELP}
${PAID_HELP}
${COMMON_HELP}`,
		options: {
			model: { type: "string", short: "m", multiple: true },
			ref: { type: "string", short: "r", multiple: true },
			count: { type: "string", short: "n" },
			ratio: { type: "string" },
			seed: { type: "string" },
			strength: { type: "string" },
			guide: { type: "string" },
			"guide-kind": { type: "string" },
			"guide-map": { type: "boolean" },
			"guide-strength": { type: "string" },
			duration: { type: "string" },
			character: { type: "string" },
			style: { type: "string" },
			batch: { type: "string" },
			...WAIT_OPTIONS,
		},
		interruptible: "once",
		async run(values, positionals, context) {
			const prompts = await promptsOf(values, positionals, context.io);
			const given = (values.ref as string[] | undefined) ?? [];
			const count = integer(values, "count", 1, 8);
			const seed = integer(values, "seed", 0);
			const duration = integer(values, "duration", 1);
			const strength =
				values.strength == null ? undefined : Number(values.strength);
			if (
				strength != null &&
				!(Number.isFinite(strength) && strength >= 0.05 && strength <= 1)
			) {
				throw new UsageError("--strength takes a number from 0.05 to 1.");
			}
			const guide = guideOf(values);
			const sessionId =
				values.session == null
					? undefined
					: id(values.session as string, ID, "a session id");

			const named = values.character != null || values.style != null;
			const entries = named ? await context.api.library() : [];
			const character =
				values.character == null
					? undefined
					: libraryEntryNamed(entries, "character", values.character as string);
			const style =
				values.style == null
					? undefined
					: libraryEntryNamed(entries, "style", values.style as string);

			const allowPaid = values["allow-paid"] === true;
			const models = await usableModels(context.api, allowPaid);
			let ids = (values.model as string[] | undefined) ?? [];
			// The model the character or style prefers, when it can be used.
			const kept =
				ids.length === 0 &&
				libraryModel(models, [character, style], {
					references: given.length,
					guide,
				});
			if (kept) ids = [kept.id];
			if (ids.length === 0) {
				// A character's pictures are followed by models that take them.
				const fit =
					(character?.pictureIds.length
						? bestLocalModel(models, given.length + 1, guide)
						: undefined) ?? bestLocalModel(models, given.length, guide);
				if (!fit) {
					throw new UsageError(
						guide
							? `No installed local model can follow this ${guide.kind} guide. Install z-image-turbo-guided with \`hatchlight install\`, pass --guide-map for a ready map, or name a cloud model with --model.`
							: given.length > 0
								? "No installed local model can start from a picture. Name one with --model, or install one with `hatchlight install`."
								: "No local model is installed. See `hatchlight catalog`, then `hatchlight install <id>`.",
					);
				}
				ids = [fit.id];
			}
			const unknown = ids.filter((id) => !models.some((m) => m.id === id));
			if (unknown.length > 0) {
				const paidOnes = (await usableModels(context.api, true)).filter((m) =>
					unknown.includes(m.id),
				);
				throw new UsageError(
					paidOnes.length === unknown.length && !allowPaid
						? `${unknown.join(", ")} costs money; pass --allow-paid to use it.`
						: `Cannot use ${unknown.join(", ")}: not installed or without an API key. See \`hatchlight models\`.`,
				);
			}
			const input = {
				modelIds: ids,
				references: given,
				sessionId,
				aspectRatio: values.ratio as string | undefined,
				count,
				seed,
				durationSeconds: duration,
				strength,
				guide,
				characterId: character?.id,
				styleId: style?.id,
			};
			if (values.batch == null) {
				return make(
					{ ...input, prompt: prompts[0] as string },
					models,
					values,
					context,
				);
			}
			// Each prompt's results go in the same folder, so it must be one.
			const output =
				typeof values.output === "string"
					? resolve(context.io.cwd, values.output)
					: null;
			if (output && prompts.length > 1 && (await namesFile(output))) {
				throw manyToFile(output);
			}
			let worst: number = EXIT.ok;
			for (const [i, prompt] of prompts.entries()) {
				if (!values.json) {
					context.io.err(`[${i + 1}/${prompts.length}] ${prompt}`);
				}
				const code = await make({ ...input, prompt }, models, values, context);
				if (code === EXIT.interrupted) return code;
				worst = Math.max(worst, code);
			}
			return worst;
		},
	},

	upscale: {
		summary: "Make a picture larger and sharper",
		usage: `Usage: hatchlight upscale <picture> [options]

Upscales a picture, given by id (ast_…) or as a file, with an installed
upscaler: a free local one when there is.

${WAIT_HELP}
${PAID_HELP}
${COMMON_HELP}`,
		options: WAIT_OPTIONS,
		interruptible: "once",
		async run(values, positionals, context) {
			const [image, ...extra] = positionals;
			if (!image || extra.length > 0) {
				throw new UsageError("Give one picture: an id (ast_…) or a file.");
			}
			const models = await usableModels(
				context.api,
				values["allow-paid"] === true,
			);
			const upscalers = models.filter((m) => m.capabilities.upscale != null);
			const upscaler = upscalers.find(isLocal) ?? upscalers[0];
			if (!upscaler) {
				throw new UsageError(
					"No upscaler is installed. Install it with `hatchlight install real-esrgan-x4plus`.",
				);
			}
			const sessionId =
				values.session == null
					? undefined
					: id(values.session as string, ID, "a session id");
			return make(
				{
					prompt: `Upscale ×${upscaler.capabilities.upscale}`,
					modelIds: [upscaler.id],
					references: [image],
					sessionId,
				},
				models,
				values,
				context,
			);
		},
	},

	status: {
		summary: "Show how a session's generations stand",
		usage: `Usage: hatchlight status <session> [options]

Shows a session's latest turn, and any turn still running.

${COMMON_HELP}`,
		options: {},
		async run(values, [session], { api, io }) {
			const sessionId = id(session, ID, "a session id");
			const [detail, models] = await Promise.all([
				api.session(sessionId),
				api.models(),
			]);
			const latest = detail.turns.at(-1);
			const shown = detail.turns.filter((t) => t === latest || !done(t.jobs));
			if (values.json) {
				json(io, { ...detail, turns: shown });
				return EXIT.ok;
			}
			if (!latest) {
				io.err("The session has nothing in it yet.");
				return EXIT.ok;
			}
			for (const turn of shown) {
				for (const line of turnLines(turn, models)) io.out(line);
			}
			return EXIT.ok;
		},
	},

	gallery: {
		summary: "Find pictures and videos made before",
		usage: `Usage: hatchlight gallery [words] [options]

Lists what was made before, newest first, by words in the prompt.

  -l, --limit <n>   How many to list (default 20)
${COMMON_HELP}`,
		options: { limit: { type: "string", short: "l" } },
		async run(values, positionals, { api, io }) {
			const limit = integer(values, "limit", 1, 500) ?? 20;
			const query = positionals.join(" ").trim() || undefined;
			const items = await api.gallery({ query, limit });
			if (values.json) {
				json(io, items);
				return EXIT.ok;
			}
			if (items.length === 0) {
				io.err("Nothing found.");
				return EXIT.ok;
			}
			for (const line of table(
				items.map((item) => [
					item.id,
					new Date(item.createdAt).toISOString().slice(0, 16).replace("T", " "),
					item.modelId ?? "uploaded",
					item.prompt ? `"${item.prompt}"` : "",
				]),
			)) {
				io.out(line);
			}
			return EXIT.ok;
		},
	},

	ranking: {
		summary: "Rank the models by the results picked as the best",
		usage: `Usage: hatchlight ranking [options]

Ranks the models compared on this computer by how often their result was
picked as the best (in the app), with the median time and cost per picture.
Models with few comparisons are marked: their win rate says little yet.

  --kind <k>        Only prompts of a kind: ${PROMPT_KINDS.join(", ")}
  --media <m>       image or video
  --period <p>      30d or all (default all)
${COMMON_HELP}`,
		options: {
			kind: { type: "string" },
			media: { type: "string" },
			period: { type: "string" },
		},
		async run(values, _positionals, { api, io }) {
			const kind = values.kind as string | undefined;
			const media = values.media as string | undefined;
			const period = values.period as string | undefined;
			if (kind != null && !PROMPT_KINDS.includes(kind as PromptKind)) {
				throw new UsageError(`--kind takes one of ${PROMPT_KINDS.join(", ")}.`);
			}
			if (media != null && media !== "image" && media !== "video") {
				throw new UsageError("--media takes image or video.");
			}
			if (
				period != null &&
				!RANKING_PERIODS.includes(period as RankingPeriod)
			) {
				throw new UsageError("--period takes 30d or all.");
			}
			const ranking = await api.ranking({
				kind: kind as PromptKind | undefined,
				media,
				period: period as RankingPeriod | undefined,
			});
			if (values.json) {
				json(io, ranking);
				return EXIT.ok;
			}
			if (ranking.models.length === 0) {
				io.err(
					"No comparison has a pick yet. Compare models on one prompt in the app and mark the best result.",
				);
				return EXIT.ok;
			}
			for (const line of table(
				ranking.models.map((m, i) => [
					`${i + 1}.`,
					m.name,
					`${m.wins}/${m.comparisons}`,
					`${Math.round(m.winRate * 100)}%`,
					m.msPerOutput == null ? "-" : duration(m.msPerOutput / 1000),
					m.usdPerOutput == null
						? "-"
						: m.usdPerOutput === 0
							? "free"
							: money(m.usdPerOutput),
					m.few ? "few comparisons" : "",
				]),
			)) {
				io.out(line);
			}
			io.err(
				`Sorted by a cautious win rate: under ${ranking.minComparisons} comparisons a model ranks lower than its wins alone say.`,
			);
			return EXIT.ok;
		},
	},

	check: {
		summary: "Check that a picture shows the same character",
		usage: `Usage: hatchlight check <picture> --like <reference>[,<reference>] [options]

Compares a picture with 1 to ${MAX_CHARACTER_REFERENCES} pictures of a character, for a series such as
a comic or a mascot, and says how much it looks the same (0 to 100) and what
differs. From ${CONSISTENT_SCORE} up the character holds. Pictures are ids (ast_…) or files.

It uses the model that looks at pictures chosen in Settings (Qwen2.5-VL or
Qwen3-VL) when one is installed, which takes about a minute without a
graphics card; else the assistant's cloud model, on your key.

  --like <ids>      The pictures of the character, comma-separated or repeated
  --traits <text>   What must stay the same, such as "green coat, red scarf"
${COMMON_HELP}`,
		options: {
			like: { type: "string", multiple: true },
			traits: { type: "string" },
		},
		async run(values, positionals, { api, io }) {
			const [image, ...extra] = positionals;
			if (!image || extra.length > 0) {
				throw new UsageError(
					"Give one picture to check: an id (ast_…) or a file.",
				);
			}
			const like = ((values.like as string[] | undefined) ?? [])
				.flatMap((item) => item.split(","))
				.map((item) => item.trim())
				.filter(Boolean);
			if (like.length < 1 || like.length > MAX_CHARACTER_REFERENCES) {
				throw new UsageError(
					`Give 1 to ${MAX_CHARACTER_REFERENCES} pictures of the character with --like.`,
				);
			}
			const traits = (values.traits as string | undefined)?.trim();
			const [assetId, ...referenceAssetIds] = await references(api, io, [
				image,
				...like,
			]);
			io.err("Comparing…");
			const result = await api.checkConsistency({
				assetId: assetId as string,
				referenceAssetIds,
				...(traits && { traits }),
			});
			if (values.json) {
				json(io, result);
				return EXIT.ok;
			}
			const verdict =
				result.verdict === "same"
					? "the same character"
					: result.verdict === "close"
						? "the same character, with small changes"
						: "not the same character";
			io.out(`${result.score}/100: ${verdict}`);
			for (const difference of result.differences) io.out(`- ${difference}`);
			return EXIT.ok;
		},
	},

	get: {
		summary: "Save pictures or videos to files",
		usage: `Usage: hatchlight get <id>... [options]

Saves pictures or videos, at full size. Without --output they go to the
current folder, named by id.

  -o, --output <p>  A folder, or a file for one picture
  --force           Replace files that exist
${COMMON_HELP}`,
		options: {
			output: { type: "string", short: "o" },
			force: { type: "boolean", default: false },
		},
		async run(values, positionals, { api, io }) {
			if (positionals.length === 0) {
				throw new UsageError("Give the id of a picture or video (ast_…).");
			}
			const ids = positionals.map((p) => id(p, ASSET_ID, "a picture id"));
			const target =
				typeof values.output === "string"
					? resolve(io.cwd, values.output)
					: `${io.cwd}/`;
			const paths = await save(api, ids, target, values.force === true);
			if (values.json) {
				json(
					io,
					ids.map((asset, i) => ({ id: asset, path: paths[i] })),
				);
			} else {
				for (const path of paths) io.out(path);
			}
			return EXIT.ok;
		},
	},

	cancel: {
		summary: "Stop a job",
		usage: `Usage: hatchlight cancel <job> [options]

Stops a job that is in line or running. Job ids are in \`hatchlight status\`.

${COMMON_HELP}`,
		options: {},
		async run(values, [job], { api, io }) {
			const jobId = id(job, ID, "a job id");
			await api.cancelJob(jobId);
			if (values.json) json(io, { id: jobId, canceled: true });
			else io.err(`Canceled ${jobId}.`);
			return EXIT.ok;
		},
	},

	retry: {
		summary: "Run a failed or stopped job again",
		usage: `Usage: hatchlight retry <job> [options]

Runs a job that failed or was stopped again. Job ids are in
\`hatchlight status\`.

${COMMON_HELP}`,
		options: {},
		async run(values, [job], { api, io, startedServer }) {
			const jobId = id(job, ID, "a job id");
			if (startedServer) {
				throw new UsageError(
					"retry needs Hatchlight running already: a server started for this command would stop the job with it. Start it with `hatchlight`.",
				);
			}
			await api.retryJob(jobId);
			if (values.json) json(io, { id: jobId, retried: true });
			else io.err(`Running ${jobId} again.`);
			return EXIT.ok;
		},
	},

	open: {
		summary: "Open the app, or a session in it",
		usage: `Usage: hatchlight open [session] [options]

Opens the running Hatchlight in the browser, at a session if given.

${COMMON_HELP}`,
		options: {},
		local: true,
		async run(values, [session], { api, io, url: base }) {
			const url =
				session == null
					? base
					: api.sessionUrl(id(session, ID, "a session id"));
			if (values.json) json(io, { url });
			else io.out(url);
			io.open(url);
			return EXIT.ok;
		},
	},
};
