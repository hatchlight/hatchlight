import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Eyes, SeenPicture } from "../chat";
import {
	type CompareOptions,
	consistencyPrompt,
	type Judge,
	PICTURE_MARKER,
	parseConsistency,
} from "../consistency";
import { CodedError } from "../errors";
import type { ConsistencyResult, UserContext } from "../types";
import { type PathMapper, windowsPath } from "./provider";
import type { LocalModelStore } from "./store";
import { type RunOnce, runOnce } from "./translator";

/** Pictures looked at per call: each takes about half a minute on a CPU. */
export const MAX_LOOKED_AT = 2;
/** Enough for a few sentences about one picture. */
const MAX_TOKENS = 200;
/** The longest request quoted to the model. */
const MAX_ASKED = 500;

/** Enough for a score and a few differences. */
const MAX_COMPARE_TOKENS = 300;

/** Enough for a line of short phrases. */
const MAX_CAPTION_TOKENS = 120;
/** The longest caption kept: training reads at most 500 characters. */
const MAX_CAPTION_LENGTH = 400;

/**
 * What the model is asked to caption a training picture with. What a caption
 * names, the LoRA learns as separate from the trigger word; what it leaves
 * out, the trigger word takes in. So it names what changes from picture to
 * picture, not who or what the subject is.
 */
export const CAPTION_PROMPT =
	"Write a caption for this picture, to train an image model with: one line in English of phrases of a few words each, separated by commas, such as: sitting on a wooden table, soft window light, close-up, plain gray background. Say where it is, what the subject does or how it is posed, what it wears or holds, the light, the framing and the background. Do not say who or what the main subject is, nor its colors or art style. No full sentences, no quotes.";

/** One line of phrases, without what a model adds around it. */
export function cleanCaption(said: string): string {
	const line = said
		.replace(/^\s*(caption|description)\s*:\s*/i, "")
		.replace(/["“”]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\.$/, "");
	if (line.length <= MAX_CAPTION_LENGTH) return line;
	// Cut at the last whole phrase.
	const cut = line.slice(0, MAX_CAPTION_LENGTH);
	const comma = cut.lastIndexOf(",");
	return (comma > 0 ? cut.slice(0, comma) : cut).trim();
}

/** What the model is asked about one picture. */
export function lookPrompt(asked: string): string {
	const request = asked.trim().slice(0, MAX_ASKED);
	return [
		request
			? `The person asked for: "${request}".`
			: "The person asked for a picture.",
		"In two or three sentences, in English: say what the picture shows, then say plainly whether it matches what was asked and what, if anything, is off (something missing, cut off, the wrong number of things, misspelled text).",
	].join(" ");
}

/** Writes training captions; absent where no model can see. */
export interface Captioner {
	/**
	 * Whether the model and its engine are installed. Given who asks, the
	 * model is the one they chose.
	 */
	ready(ctx?: UserContext): Promise<boolean>;
	caption(
		picture: SeenPicture,
		signal: AbortSignal,
		ctx?: UserContext,
	): Promise<string>;
}

export interface LocalEyesOptions {
	store: LocalModelStore;
	/** The catalog model that looks at pictures. */
	model: string;
	run?: RunOnce;
	windowsPath?: PathMapper;
	/** Where its runs wait their turn; by default, with every other model's. */
	queue?: RunQueue;
}

/**
 * Runs one after another: a model that looks at pictures takes gigabytes of
 * memory, so one runs at a time, whichever model and whoever asked.
 */
export class RunQueue {
	private last: Promise<unknown> = Promise.resolve();

	/** Runs `job` after the runs before it, whether they worked or not. */
	add<T>(job: () => Promise<T>): Promise<T> {
		const run = this.last.then(job);
		this.last = run.catch(() => {});
		return run;
	}
}

/** The queue every model that looks at pictures shares, unless given one. */
const SHARED_QUEUE = new RunQueue();

/**
 * A model on this computer that looks at pictures (Qwen2.5-VL, Qwen3-VL), run once
 * per picture with llama.cpp's multimodal program: it works from WSL too,
 * where llama.cpp's server on the Windows side cannot be reached.
 */
export class LocalEyes implements Eyes, Captioner, Judge {
	private store: LocalModelStore;
	private model: string;
	private run: RunOnce;
	private windowsPath: PathMapper;
	private queue: RunQueue;

	constructor(options: LocalEyesOptions) {
		this.store = options.store;
		this.model = options.model;
		this.run = options.run ?? runOnce;
		this.windowsPath = options.windowsPath ?? windowsPath;
		this.queue = options.queue ?? SHARED_QUEUE;
	}

	/** Whether the model and its engine are installed. */
	async ready(): Promise<boolean> {
		const view = await this.store.list().catch(() => null);
		return view?.models.find((m) => m.id === this.model)?.ready ?? false;
	}

	async look(
		pictures: SeenPicture[],
		asked: string,
		signal: AbortSignal,
	): Promise<string> {
		const said: string[] = [];
		for (const picture of pictures.slice(0, MAX_LOOKED_AT)) {
			const text = await this.ask(
				[picture],
				lookPrompt(asked),
				MAX_TOKENS,
				signal,
			);
			said.push(picture.label ? `${picture.label}: ${text}` : text);
		}
		return said.join("\n");
	}

	/**
	 * A caption to train a LoRA with: what the picture shows, in short
	 * phrases, leaving the subject itself to the trigger word.
	 */
	async caption(picture: SeenPicture, signal: AbortSignal): Promise<string> {
		return cleanCaption(
			await this.ask([picture], CAPTION_PROMPT, MAX_CAPTION_TOKENS, signal),
		);
	}

	/**
	 * Whether a picture shows the character of the references: all of them
	 * in one run, which reads several pictures, each labeled in the prompt.
	 */
	async compare(
		references: SeenPicture[],
		candidate: SeenPicture,
		signal: AbortSignal,
		options: CompareOptions = {},
	): Promise<ConsistencyResult> {
		const labels = [
			...references.map((_, i) => `Reference ${i + 1}: ${PICTURE_MARKER}`),
			`New picture: ${PICTURE_MARKER}`,
		];
		const prompt = [
			...labels,
			consistencyPrompt(references.length, options),
		].join("\n");
		let said: string;
		try {
			said = await this.ask(
				[...references, candidate],
				prompt,
				MAX_COMPARE_TOKENS,
				signal,
			);
		} catch (error) {
			if (signal.aborted) throw error;
			throw new CodedError(
				`Comparing the pictures failed: ${error instanceof Error ? error.message : String(error)}`,
				"noVerdict",
			);
		}
		return parseConsistency(said);
	}

	/** Runs the model once on some pictures, after any run before it. */
	private ask(
		pictures: SeenPicture[],
		prompt: string,
		maxTokens: number,
		signal: AbortSignal,
	): Promise<string> {
		return this.queue.add(() => {
			// Given up while waiting its turn: nothing to run.
			signal.throwIfAborted();
			return this.askNow(pictures, prompt, maxTokens, signal);
		});
	}

	/** Runs the model once on some pictures, and returns what it said. */
	private async askNow(
		pictures: SeenPicture[],
		prompt: string,
		maxTokens: number,
		signal: AbortSignal,
	): Promise<string> {
		const runtime = await this.store.runtime(this.model);
		const model = runtime.files.model;
		const projector = runtime.files.llm_vision;
		if (!model || !projector) {
			throw new Error("The model that looks at pictures is incomplete");
		}
		const path = runtime.throughWindows
			? this.windowsPath
			: async (p: string) => p;
		const program = join(
			dirname(runtime.executable),
			basename(runtime.executable).replace("llama-server", "llama-mtmd-cli"),
		);
		await mkdir(runtime.scratch, { recursive: true });
		const files = pictures.map((picture) =>
			join(
				runtime.scratch,
				`${crypto.randomUUID()}.look.${picture.mimeType.split("/")[1] ?? "jpeg"}`,
			),
		);
		try {
			const images: string[] = [];
			for (const [i, picture] of pictures.entries()) {
				const file = files[i] as string;
				await Bun.write(file, Buffer.from(picture.data, "base64"));
				images.push("--image", await path(file));
			}
			const { code, stdout, stderr } = await this.run(
				[
					program,
					"-m",
					await path(model),
					"--mmproj",
					await path(projector),
					...images,
					"-p",
					prompt,
					"-n",
					String(maxTokens),
					"--temp",
					"0.2",
					"--no-perf",
				],
				signal,
			);
			if (code !== 0) {
				const reason = stderr.trim().split(/\r?\n/).at(-1);
				throw new Error(
					`Looking at the picture failed: ${reason ?? `code ${code}`}`,
				);
			}
			return stdout.replace(/\s+/g, " ").trim();
		} finally {
			for (const file of files) await rm(file, { force: true });
		}
	}
}
