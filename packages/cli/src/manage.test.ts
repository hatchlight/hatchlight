import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatReply } from "@hatchlight/core";
import { picture, safetensors } from "@hatchlight/core/testing";
import { EXIT, UsageError } from "./commands";
import { cleanups, idsIn, terminal } from "./testing";

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("keys", () => {
	test("are listed, set from what is typed or piped, and removed", async () => {
		const typing = await terminal({ typed: ["  fal-secret  "] });
		// Only providers that need a key are listed: the fake one is made to.
		await typing.run("keys");
		expect(typing.out).toEqual([]);
		typing.provider.requiresKey = true;
		await typing.run("keys");
		expect(typing.out.join("\n")).toMatch(/fake\s+Fake \(fake\)\s+not set/);
		await typing.run("keys", ["set", "fake"]);
		expect(typing.prompts).toEqual(["Key for Fake (fake) (not shown): "]);
		await typing.run("keys", ["--json"]);
		expect(typing.json()).toMatchObject([{ id: "fake", hasKey: true }]);
		await typing.run("keys", ["remove", "fake"]);
		await typing.run("keys", ["--json"]);
		expect(typing.json()).toMatchObject([{ id: "fake", hasKey: false }]);

		const piping = await terminal({ piped: "from-a-pipe\n" });
		piping.provider.requiresKey = true;
		await piping.run("keys", ["set", "fake"]);
		await piping.run("keys", ["--json"]);
		expect(piping.json()).toMatchObject([{ id: "fake", hasKey: true }]);
	});

	test("an unknown provider, or no key, is refused", async () => {
		const t = await terminal({ piped: "" });
		t.provider.requiresKey = true;
		await expect(t.run("keys", ["set", "nope"])).rejects.toThrow(
			"They are: fake",
		);
		await expect(t.run("keys", ["set", "fake"])).rejects.toThrow(
			"No key was given",
		);
		await expect(t.run("keys", ["drop", "fake"])).rejects.toBeInstanceOf(
			UsageError,
		);
	});
});

describe("local models", () => {
	test("the catalog says what a model takes and allows", async () => {
		const t = await terminal();
		await t.run("catalog");
		expect(t.out).toHaveLength(1);
		expect(t.out[0]).toMatch(/^tiny\s+Tiny\s+image\s+available/);
		expect(t.out[0]).toContain("personal use only");
		await t.run("catalog", ["nothing-like-it"]);
		expect(t.err.join()).toContain("No model matches");
	});

	test("a model is installed, waited for, and uninstalled", async () => {
		const t = await terminal();
		expect(await t.run("install", ["local/tiny"])).toBe(EXIT.ok);
		expect(t.err[0]).toContain("Installing Tiny, Full");
		expect(t.err.at(-1)).toContain("-m local/tiny");
		await t.run("catalog", ["--json"]);
		expect(t.json()[0]).toMatchObject({ id: "tiny", state: "installed" });

		expect(await t.run("install", ["tiny"])).toBe(EXIT.ok);
		expect(t.err.join()).toContain("already installed");

		expect(await t.run("uninstall", ["tiny"])).toBe(EXIT.ok);
		expect(t.err.join()).toContain("Deleted Tiny");
		await expect(t.run("uninstall", ["tiny"])).rejects.toThrow("not installed");
		await expect(t.run("install", ["nope"])).rejects.toThrow("No model nope");
		await expect(
			t.run("install", ["tiny", "--variant", "huge"]),
		).rejects.toThrow("has no variant huge; it has full");
	});
});

describe("LoRAs", () => {
	test("are added from a file, listed and removed", async () => {
		const t = await terminal();
		await t.run("loras");
		expect(t.err.join()).toContain("No LoRA yet");
		const file = join(t.dir, "Ink Style.safetensors");
		await writeFile(
			file,
			safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"], {
				ss_tag_frequency: JSON.stringify({ "1_inkz": { inkz: 3 } }),
			}),
		);
		expect(await t.run("loras", ["add", "Ink Style.safetensors"])).toBe(
			EXIT.ok,
		);
		expect(t.err.join()).toContain("<lora:ink-style:1>");
		await t.run("loras", ["--json"]);
		expect(t.json()).toMatchObject([{ id: "ink-style", base: "sdxl" }]);
		await t.run("loras", ["remove", "ink-style"]);
		await t.run("loras", ["--json"]);
		expect(t.json()).toEqual([]);
		await expect(
			t.run("loras", ["add", "missing.safetensors"]),
		).rejects.toThrow("Cannot read");
	});
});

test("doctor says what is missing, and what to do", async () => {
	const t = await terminal();
	expect(await t.run("doctor")).toBe(EXIT.ok);
	const said = t.out.join("\n");
	expect(said).toContain("running at http://127.0.0.1:4096");
	expect(said).toMatch(/System\s+Linux x64, 8\.0 GB memory/);
	expect(said).toMatch(/Installed\s+nothing yet/);
	expect(said).toMatch(/Trainer\s+not installed: hatchlight trainer install/);
	expect(t.err.join("\n")).toContain("No graphics card was found");
	await t.run("doctor", ["--json"]);
	expect(t.json()).toMatchObject({ installed: [], trainer: "missing" });
});

describe("training", () => {
	test("nothing trains without consent, enough pictures and the trainer", async () => {
		const t = await terminal();
		const folder = join(t.dir, "dog");
		await mkdir(folder);
		for (const n of [1, 2, 3]) {
			await writeFile(join(folder, `dog${n}.png`), picture(32, 32));
		}
		await writeFile(join(folder, "notes.md"), "not a picture");
		const base = ["--name", "Dog", "--trigger", "qzxdog"];
		await expect(t.run("train", [folder, ...base])).rejects.toThrow(
			"needs --consent",
		);
		await expect(
			t.run("train", [join(folder, "dog1.png"), ...base, "--consent"]),
		).rejects.toThrow("3 to 200 pictures; 1 were given");
		await expect(
			t.run("train", [folder, ...base, "--consent", "--steps", "5"]),
		).rejects.toThrow("--steps takes a whole number from 100 to 4000");
		await expect(
			t.run("train", [folder, ...base, "--consent"]),
		).rejects.toThrow("The trainer is not installed");
		await t.run("trainer");
		expect(t.out[0]).toContain("Trainer: not installed");
	});
});

describe("batch", () => {
	test("makes each line of a file, skipping comments", async () => {
		const t = await terminal();
		await writeFile(
			join(t.dir, "prompts.txt"),
			"# foxes\na red fox\n\na blue fox\n",
		);
		const code = await t.run("generate", [
			"--batch",
			"prompts.txt",
			"--allow-paid",
			"-m",
			"fake/alpha",
			"--json",
		]);
		expect(code).toBe(EXIT.ok);
		const lines = t.out.map((line) => JSON.parse(line));
		expect(lines).toHaveLength(2);
		await t.run("gallery", ["fox"]);
		expect(t.out.join("\n")).toContain('"a red fox"');
		expect(t.out.join("\n")).toContain('"a blue fox"');
	});

	test("reads standard input, and refuses a prompt beside it", async () => {
		const t = await terminal({ piped: "one\ntwo\n" });
		expect(
			await t.run("generate", [
				"--batch",
				"-",
				"--allow-paid",
				"-m",
				"fake/alpha",
			]),
		).toBe(EXIT.ok);
		expect(t.err.filter((line) => /^\[\d\/2\]/.test(line))).toEqual([
			"[1/2] one",
			"[2/2] two",
		]);
		await expect(
			t.run("generate", ["x", "--batch", "-", "-m", "fake/alpha"]),
		).rejects.toThrow("not both");
		await expect(
			t.run("generate", [
				"--batch",
				"-",
				"--allow-paid",
				"-m",
				"fake/alpha",
				"-o",
				"one.png",
			]),
		).rejects.toThrow("give a folder");
	});
});

describe("chat", () => {
	/** An assistant that makes a fox on the paid fake model, then says so. */
	const assistant = () => {
		const replies: ChatReply[] = [
			{
				text: "Making it.",
				toolCalls: [
					{
						id: "c1",
						name: "generate",
						arguments: { prompt: "a red fox", models: ["fake/alpha"] },
					},
				],
			},
			{ text: "Here is your fox.", toolCalls: [] },
		];
		return {
			vision: false,
			chat: async () => replies.shift() ?? { text: "", toolCalls: [] },
		};
	};

	test("asks before paying, makes the picture and saves it", async () => {
		const t = await terminal({ assistantModel: assistant(), typed: ["y"] });
		const code = await t.run("chat", ["a fox with fake/alpha", "-o", "out"]);
		expect(code).toBe(EXIT.ok);
		expect(t.prompts).toEqual(["Spend about $0.01 on Fake alpha? [y/N] "]);
		expect(t.out).toContain("Making it.");
		expect(t.out).toContain("Here is your fox.");
		expect(idsIn(t.out, "ast")).toHaveLength(1);
		expect(t.err.join("\n")).toMatch(/saved .*out\/ast_/);
		expect(t.err.at(-1)).toMatch(/hatchlight chat --session ses_/);
	});

	test("a script is not asked, and says no unless told yes", async () => {
		const declined = await terminal({ assistantModel: assistant() });
		await declined.run("chat", ["a fox with fake/alpha"]);
		expect(declined.err.join("\n")).toContain("No: answer at a terminal");
		expect(idsIn(declined.out, "ast")).toHaveLength(0);

		const approved = await terminal({ assistantModel: assistant() });
		await approved.run("chat", ["a fox with fake/alpha", "--yes"]);
		expect(approved.err.join("\n")).toContain("Yes (--yes)");
		expect(idsIn(approved.out, "ast")).toHaveLength(1);
	});

	test("a conversation goes on until the person leaves", async () => {
		const t = await terminal({
			assistantModel: assistant(),
			typed: ["a fox with fake/alpha", "y"],
		});
		expect(await t.run("chat")).toBe(EXIT.ok);
		expect(t.prompts).toEqual([
			"> ",
			"Spend about $0.01 on Fake alpha? [y/N] ",
			"> ",
		]);
		expect(t.out).toContain("Here is your fox.");
	});

	test("without anything to think with, it says what to set up", async () => {
		const t = await terminal();
		await expect(t.run("chat", ["hello"])).rejects.toThrow(
			"nothing to think with",
		);
	});
});

describe("completions", () => {
	test("are made for every command and its options", async () => {
		const t = await terminal();
		for (const shell of ["bash", "zsh", "fish"]) {
			expect(await t.run("completions", [shell])).toBe(EXIT.ok);
			const script = t.out.join("\n");
			for (const word of [
				"generate",
				"install",
				"chat",
				"allow-paid",
				"batch",
			]) {
				expect(script).toContain(word);
			}
		}
		await expect(t.run("completions", ["tcsh"])).rejects.toThrow(
			"bash, zsh or fish",
		);
	});

	test("the bash and zsh scripts are valid", async () => {
		const t = await terminal();
		for (const shell of ["bash", "zsh"]) {
			if (!Bun.which(shell)) continue;
			await t.run("completions", [shell]);
			const check = Bun.spawnSync([shell, "-n"], {
				stdin: new TextEncoder().encode(t.out.join("\n")),
			});
			expect(check.stderr.toString()).toBe("");
			expect(check.exitCode).toBe(0);
		}
	});
});

describe("what the review found", () => {
	test("a second Ctrl+C leaves a conversation at once", async () => {
		// An assistant slow to stop: it thinks for two seconds whatever happens.
		const slow = {
			vision: false,
			chat: async () => {
				await Bun.sleep(2000);
				return { text: "late", toolCalls: [] };
			},
		};
		const t = await terminal({ assistantModel: slow });
		const started = Date.now();
		const running = t.run("chat", ["hello"]);
		await Bun.sleep(50);
		t.interruptNext();
		await Bun.sleep(50);
		t.interruptNext();
		expect(await running).toBe(EXIT.interrupted);
		expect(Date.now() - started).toBeLessThan(1500);
		expect(t.err.join("\n")).toContain("Stopping the assistant");
	});

	test("chat saves to a folder, never one file", async () => {
		const t = await terminal();
		await expect(t.run("chat", ["hi", "-o", "fox.png"])).rejects.toThrow(
			"--output is a folder for chat",
		);
	});

	test("an installed model is not said to change variant", async () => {
		const t = await terminal();
		await t.run("install", ["tiny"]);
		await expect(
			t.run("install", ["tiny", "--variant", "other"]),
		).rejects.toThrow("installed as full");
	});
});
