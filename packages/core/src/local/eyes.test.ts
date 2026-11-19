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
