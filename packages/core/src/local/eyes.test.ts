import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_PROMPT, cleanCaption, LocalEyes, lookPrompt } from "./eyes";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function eyes(throughWindows = false) {
	const scratch = await mkdtemp(join(tmpdir(), "hatchlight-eyes-"));
	dirs.push(scratch);
	const runs: string[][] = [];
	const store = {
		list: async () => ({ models: [{ id: "vl", ready: true }] }),
		runtime: async () => ({
			executable: "/engines/llama/llama-server.exe",
			files: { model: "/m/vl.gguf", llm_vision: "/m/mmproj.gguf" },
			scratch,
			throughWindows,
		}),
	};
	const looking = new LocalEyes({
		store: store as never,
		model: "vl",
		windowsPath: async (p) => `C:${p.replaceAll("/", "\\")}`,
		run: async (argv) => {
			runs.push(argv);
			// The picture is there while it is looked at.
			const image = argv[argv.indexOf("--image") + 1] as string;
			const file = throughWindows
				? image.slice(2).replaceAll("\\", "/")
				: image;
			expect(await Bun.file(file).exists()).toBe(true);
			return { code: 0, stdout: "  A fox in snow.\n\nNo scarf.  ", stderr: "" };
		},
	});
	return { looking, runs, scratch };
}

const fox = {
	data: Buffer.from("jpeg").toString("base64"),
	mimeType: "image/jpeg",
};

test("looks at each picture once, with what was asked, and cleans up", async () => {
	const { looking, runs, scratch } = await eyes();
	expect(await looking.ready()).toBe(true);
	const said = await looking.look(
		[
			{ ...fox, label: "ast_1 by Z" },
			{ ...fox, label: "ast_2 by F" },
			{ ...fox, label: "ast_3 by S" },
		],
		"a fox with a scarf",
		new AbortController().signal,
	);
	// At most two: each takes about half a minute on a processor.
	expect(runs).toHaveLength(2);
	const [argv] = runs;
	expect(argv?.[0]).toBe("/engines/llama/llama-mtmd-cli.exe");
	expect(argv?.[argv.indexOf("--mmproj") + 1]).toBe("/m/mmproj.gguf");
	expect(argv?.[argv.indexOf("-p") + 1]).toBe(lookPrompt("a fox with a scarf"));
	expect(said).toBe(
		"ast_1 by Z: A fox in snow. No scarf.\nast_2 by F: A fox in snow. No scarf.",
	);
	expect(await readdir(scratch)).toEqual([]);
});

test("from WSL, the Windows program is given Windows paths", async () => {
	const { looking, runs } = await eyes(true);
	await looking.look([fox], "", new AbortController().signal);
	const [argv] = runs;
	expect(argv?.[argv.indexOf("-m") + 1]).toBe("C:\\m\\vl.gguf");
	expect(argv?.[argv.indexOf("-p") + 1]).toStartWith(
		"The person asked for a picture.",
	);
});

test("a training picture is captioned in one line of phrases", async () => {
	const { looking, runs, scratch } = await eyes();
	const caption = await looking.caption(fox, new AbortController().signal);
	const [argv] = runs;
	expect(argv?.[argv.indexOf("-p") + 1]).toBe(CAPTION_PROMPT);
	expect(caption).toBe("A fox in snow. No scarf");
	expect(await readdir(scratch)).toEqual([]);
});

test("what a model adds around a caption is taken off", () => {
	expect(
		cleanCaption('Caption: "standing in snow, soft light, close-up."'),
	).toBe("standing in snow, soft light, close-up");
	const long = cleanCaption(Array(100).fill("a short phrase").join(", "));
	expect(long.length).toBeLessThanOrEqual(400);
	expect(long).toEndWith("a short phrase");
});

test("compares a picture with its references in one run, in order", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "hatchlight-eyes-"));
	dirs.push(scratch);
	const runs: string[][] = [];
	const store = {
		list: async () => ({ models: [{ id: "vl", ready: true }] }),
		runtime: async () => ({
			executable: "/engines/llama/llama-server",
			files: { model: "/m/vl.gguf", llm_vision: "/m/mmproj.gguf" },
			scratch,
			throughWindows: false,
		}),
	};
	const judge = new LocalEyes({
		store: store as never,
		model: "vl",
		run: async (argv) => {
			runs.push(argv);
			const images = argv.flatMap((arg, i) =>
				arg === "--image" ? [argv[i + 1] as string] : [],
			);
			const read = await Promise.all(images.map((f) => Bun.file(f).text()));
			expect(read).toEqual(["ref1", "ref2", "new"]);
			return {
				code: 0,
				stdout: '```json\n{"score": 64, "differences": ["no scarf"]}\n```',
				stderr: "",
			};
		},
	});
	const seen = (text: string) => ({
		data: Buffer.from(text).toString("base64"),
		mimeType: "image/jpeg",
	});
	const result = await judge.compare(
		[seen("ref1"), seen("ref2")],
		seen("new"),
		new AbortController().signal,
		{ traits: "a red scarf" },
	);
	expect(result).toEqual({
		score: 64,
		differences: ["no scarf"],
		verdict: "different",
	});
	expect(runs).toHaveLength(1);
	const [argv] = runs;
	expect(argv?.[0]).toBe("/engines/llama/llama-mtmd-cli");
	const prompt = argv?.[argv.indexOf("-p") + 1] ?? "";
	// Each picture is placed by a marker, labeled, before the question.
	expect(prompt).toStartWith(
		"Reference 1: <__media__>\nReference 2: <__media__>\nNew picture: <__media__>\n",
	);
	expect(prompt).toContain("What must stay the same: a red scarf.");
	expect(await readdir(scratch)).toEqual([]);
});

test("one run at a time, whoever asks, and a failed one does not stop the next", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "hatchlight-eyes-"));
	dirs.push(scratch);
	let running = 0;
	let most = 0;
	let runs = 0;
	const store = {
		list: async () => ({ models: [{ id: "vl", ready: true }] }),
		runtime: async () => ({
			executable: "/engines/llama/llama-server",
			files: { model: "/m/vl.gguf", llm_vision: "/m/mmproj.gguf" },
			scratch,
			throughWindows: false,
		}),
	};
	const eyes = new LocalEyes({
		store: store as never,
		model: "vl",
		run: async () => {
			running++;
			most = Math.max(most, running);
			await Bun.sleep(10);
			running--;
			// The first run crashes.
			return ++runs === 1
				? { code: 1, stdout: "", stderr: "out of memory" }
				: { code: 0, stdout: '{"score": 80, "differences": []}', stderr: "" };
		},
	});
	const picture = {
		data: Buffer.from("jpeg").toString("base64"),
		mimeType: "image/jpeg",
	};
	const signal = new AbortController().signal;
	const [failed, compared, caption] = await Promise.allSettled([
		eyes.compare([picture], picture, signal),
		eyes.compare([picture], picture, signal),
		eyes.caption(picture, signal),
	]);
	expect(most).toBe(1);
	expect(runs).toBe(3);
	// A run that failed is a comparison with no verdict, told as such.
	expect(failed.status === "rejected" && failed.reason.code).toBe("noVerdict");
	expect(compared.status === "fulfilled" && compared.value.score).toBe(80);
	expect(caption.status).toBe("fulfilled");

	// Given up while waiting its turn, it never runs.
	const stop = new AbortController();
	const first = eyes.caption(picture, signal);
	const second = eyes.caption(picture, stop.signal);
	stop.abort();
	await first;
	await expect(second).rejects.toThrow();
	expect(runs).toBe(4);
});
