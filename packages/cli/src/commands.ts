import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type {
	EngineEvent,
	JobView,
	ModelSpec,
	ProgressStage,
	TurnView,
} from "@hatchlight/core/types";
import {
	ASSET_ID,
	bestLocalModel,
	done,
	estimate,
	ID,
	isLocal,
	money,
	type Reel,
	usableModels,
} from "@hatchlight/tools";

/**
 * The commands a person types to use Hatchlight from a terminal. They talk
 * to a Hatchlight server, like the app and agents do, and pick models the
 * same way agents do: free local ones unless paid ones are allowed.
 */

/** What the commands need from Hatchlight. */
export interface Api extends Reel {
	cancelJob(id: string): Promise<void>;
	retryJob(id: string): Promise<void>;
	/** How jobs move, until `signal` stops it. */
	events(signal: AbortSignal): AsyncIterable<EngineEvent>;
}

/** Where a command writes, and what it knows about where it runs. */
export interface Io {
	/** A line of results, on standard output. */
	out(line: string): void;
	/** A line of notes and errors, on standard error. */
	err(line: string): void;
	/** Shows how things stand on a line that is rewritten; null clears it. */
	status(line: string | null): void;
	/** Relative paths are read from here. */
	cwd: string;
	/** Asking to stop, such as Ctrl+C. */
	signal: AbortSignal;
	/** Opens an address in the browser. */
	open(url: string): void;
}

export interface Context {
	api: Api;
	io: Io;
	/** The server's address. */
	url: string;
	/** The server was started for this command, and stops when it ends. */
	startedServer: boolean;
	/** How often a generation being waited for is looked at. */
	pollMs?: number;
}

/** The command was given wrong; says how. */
export class UsageError extends Error {}

/** Exit codes. */
export const EXIT = { ok: 0, failed: 1, usage: 2, interrupted: 130 } as const;

type Values = Record<string, string | boolean | string[] | undefined>;

interface Command {
	summary: string;
	usage: string;
	options: ParseArgsOptionsConfig;
	/** Runs without a server: it only needs to find a running one. */
	local?: boolean;
	/**
	 * Waits on something that goes on without it, so the first Ctrl+C only
	 * stops the waiting. Other commands end at once.
	 */
	interruptible?: boolean;
	run(values: Values, positionals: string[], context: Context): Promise<number>;
}

/** Options every command takes. */
export const COMMON: ParseArgsOptionsConfig = {
	json: { type: "boolean", default: false },
	"data-dir": { type: "string" },
	resources: { type: "string" },
	help: { type: "boolean", short: "h", default: false },
};

const COMMON_HELP = `  --json            Print the result as JSON, for scripts
  --data-dir <p>    The data directory (default: the app's)
  -h, --help        Show this help`;

const json = (io: Io, value: unknown) => io.out(JSON.stringify(value, null, 2));

/** Columns padded to line up. */
function table(rows: string[][]): string[] {
	const widths = rows[0]?.map((_, i) =>
		Math.max(...rows.map((row) => row[i]?.length ?? 0)),
	);
	return rows.map((row) =>
		row
			.map((cell, i) =>
				i === row.length - 1 ? cell : cell.padEnd(widths?.[i] ?? 0),
			)
			.join("  ")
			.trimEnd(),
	);
}

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
async function namesFile(target: string): Promise<boolean> {
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
async function save(
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
async function references(
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

/** Throws when a value given to an option is not a whole number in range. */
function integer(
	values: Values,
	name: string,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): number | undefined {
	const raw = values[name];
	if (raw == null) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new UsageError(
			`--${name} takes a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : " up"}.`,
		);
	}
	return value;
}

function id(value: string | undefined, pattern: RegExp, what: string): string {
	if (!value) throw new UsageError(`Give ${what}.`);
	if (!pattern.test(value)) throw new UsageError(`Not ${what}: ${value}`);
	return value;
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
			json(io, {
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

export const COMMANDS: Record<string, Command> = {
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
					"No model can be used yet. Install a local model, or add an API key, in the Hatchlight app.",
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

Makes pictures or videos, waits for them, and prints their ids. Without
--model, the best free local model that fits is used.

  -m, --model <id>  A model from \`hatchlight models\`; repeat to compare
  -r, --ref <p>     A picture to start from: an id (ast_…) or a file; repeat
  -n, --count <n>   How many to make with each model (1 to 8)
  --ratio <r>       Aspect ratio, such as 16:9
  --seed <n>        A seed, to make the same again
  --strength <s>    How much a given picture changes, 0.05 to 1
  --duration <s>    Video length in seconds
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
			duration: { type: "string" },
			...WAIT_OPTIONS,
		},
		interruptible: true,
		async run(values, positionals, context) {
			const prompt = positionals.join(" ").trim();
			if (!prompt) throw new UsageError("Say what to make.");
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
			const sessionId =
				values.session == null
					? undefined
					: id(values.session as string, ID, "a session id");

			const allowPaid = values["allow-paid"] === true;
			const models = await usableModels(context.api, allowPaid);
			let ids = (values.model as string[] | undefined) ?? [];
			if (ids.length === 0) {
				const fit = bestLocalModel(models, given.length);
				if (!fit) {
					throw new UsageError(
						given.length > 0
							? "No installed local model can start from a picture. Name one with --model, or install one in the Hatchlight app."
							: "No local model is installed. Install one from Local models in the Hatchlight app.",
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
			return make(
				{
					prompt,
					modelIds: ids,
					references: given,
					sessionId,
					aspectRatio: values.ratio as string | undefined,
					count,
					seed,
					durationSeconds: duration,
					strength,
				},
				models,
				values,
				context,
			);
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
		interruptible: true,
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
					"No upscaler is installed. Install Real-ESRGAN from Local models in the Hatchlight app.",
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

/** The commands, one per line, for the main help. */
export function commandList(): string {
	const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
	return Object.entries(COMMANDS)
		.map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`)
		.join("\n");
}

/** A command's arguments, read and checked; a usage error when they are wrong. */
export function parse(
	command: Command,
	args: string[],
): { values: Values; positionals: string[] } {
	try {
		const { values, positionals } = parseArgs({
			args,
			options: { ...COMMON, ...command.options },
			allowPositionals: true,
		});
		const result = values as Values;
		if (result["no-wait"]) result.wait = false;
		return { values: result, positionals };
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
}
