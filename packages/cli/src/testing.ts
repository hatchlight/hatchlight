import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatModel,
	FakeProvider,
	type LocalEngineSpec,
	type LocalModelSpec,
} from "@hatchlight/core";
import { zip } from "@hatchlight/core/testing";
import { createApp, createRuntime } from "@hatchlight/server";
import { Api } from "./api";
import { COMMANDS, parse } from "./commands";

/** What a test sets up, and takes down after it. */
export const cleanups: (() => Promise<void>)[] = [];

export const WEIGHTS = new TextEncoder().encode("the weights of a small model");
const ENGINE = zip([{ name: "run", data: new TextEncoder().encode("run") }]);
const hash = (data: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(data).digest("hex");

const ENGINES: LocalEngineSpec[] = [
	{
		id: "run",
		name: "Runner",
		homepage: "https://engine.example",
		license: "MIT",
		builds: [
			{
				id: "run-cpu",
				engine: "run",
				version: "1",
				backend: "cpu",
				os: "linux",
				arch: "x64",
				executable: "run",
				files: [
					{
						name: "run.zip",
						url: "https://models.example/run.zip",
						size: ENGINE.byteLength,
						sha256: hash(ENGINE),
					},
				],
			},
		],
	},
];

/** A small model in the catalog, whose files come from `download`. */
export const TINY: LocalModelSpec = {
	id: "tiny",
	name: "Tiny",
	author: "Example",
	media: "image",
	tasks: ["text-to-image"],
	summary: "A model for tests.",
	license: "MIT",
	licenseUrl: "https://license.example",
	commercial: { kind: "none" },
	homepage: "https://models.example",
	variants: [
		{
			id: "full",
			label: "Full",
			engine: "run",
			memoryBytes: 1,
			files: [
				{
					name: "tiny.safetensors",
					url: "https://models.example/tiny.safetensors",
					size: WEIGHTS.byteLength,
					sha256: hash(WEIGHTS),
					role: "model",
				},
			],
		},
	],
	demos: [],
	defaults: { size: 512, aspectRatios: ["1:1"], steps: 1, cfgScale: 1 },
};

export interface TerminalOptions {
	/** The server was started for the command. */
	startedServer?: boolean;
	/** What the assistant says, in place of a language model. */
	assistantModel?: ChatModel;
	/** A person typing these lines, in order; unset, a script runs it. */
	typed?: string[];
	/** What is piped into the command. */
	piped?: string;
}

/** A person at a terminal, using a real Hatchlight whose models are fakes. */
export async function terminal(options: TerminalOptions = {}) {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-cli-"));
	const provider = new FakeProvider();
	const runtime = await createRuntime({
		dataDir: join(dir, "data"),
		providers: [provider],
		localModels: [TINY],
		engines: ENGINES,
		hardware: async () => ({
			os: "linux",
			arch: "x64",
			wsl: false,
			memoryBytes: 8e9,
			gpus: [],
		}),
		// The test engine is not a real program.
		checkEngine: async () => null,
		fetch: async (url: string) =>
			new Response(url.endsWith(".zip") ? ENGINE : WEIGHTS),
		...(options.assistantModel && { assistantModel: options.assistantModel }),
	});
	await runtime.start();
	const app = createApp(runtime);
	const url = "http://127.0.0.1:4096";
	const api = new Api(url, (target, init) =>
		Promise.resolve(app.fetch(new Request(target, init))),
	);
	let stop = new AbortController();
	let next = new AbortController();
	const out: string[] = [];
	const err: string[] = [];
	const opened: string[] = [];
	const prompts: string[] = [];
	const typed = [...(options.typed ?? [])];
	cleanups.push(async () => {
		provider.gate = null;
		await runtime.engine.idle();
		await runtime.models.idle();
		runtime.close();
		await rm(dir, { recursive: true });
	});
	const answer = async (prompt: string) => {
		prompts.push(prompt);
		return typed.shift() ?? null;
	};
	const run = async (name: string, args: string[] = []) => {
		out.length = 0;
		err.length = 0;
		const command = COMMANDS[name];
		if (!command) throw new Error(`no ${name}`);
		const { values, positionals } = parse(command, args);
		return command.run(values, positionals, {
			api,
			url,
			dataDir: join(dir, "data"),
			startedServer: options.startedServer ?? false,
			pollMs: 5,
			io: {
				out: (line) => out.push(line),
				err: (line) => err.push(line),
				status: () => {},
				cwd: dir,
				signal: stop.signal,
				nextInterrupt: () => {
					next = new AbortController();
					return next.signal;
				},
				open: (target) => opened.push(target),
				interactive: options.typed != null,
				readLine: answer,
				readSecret: answer,
				readAll: async () => options.piped ?? "",
			},
		});
	};
	const json = () => JSON.parse(out.join("\n"));
	return {
		run,
		json,
		api,
		runtime,
		out,
		err,
		opened,
		prompts,
		dir,
		provider,
		/** Ctrl+C, for commands that stop waiting once. */
		interrupt: () => stop.abort(),
		/** Ctrl+C, for what a conversation waits on now. */
		interruptNext: () => next.abort(),
		resetInterrupt: () => {
			stop = new AbortController();
		},
	};
}

export const idsIn = (lines: string[], prefix: string) =>
	lines.join("\n").match(new RegExp(`${prefix}_[A-Za-z0-9_-]+`, "g")) ?? [];
