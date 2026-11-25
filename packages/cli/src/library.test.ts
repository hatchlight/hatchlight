import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { picture } from "@hatchlight/core/testing";
import { EXIT } from "./commands";
import { cleanups, terminal } from "./testing";

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("library", () => {
	test("characters and styles are added, listed, used by name and removed", async () => {
		const t = await terminal();
		await t.run("library");
		expect(t.err.join()).toContain("Nothing saved yet");
		await writeFile(join(t.dir, "rex.png"), picture(8, 8));
		expect(
			await t.run("library", [
				"add",
				"character",
				"Rex",
				"the",
				"dog",
				"--ref",
				"rex.png",
				"--seed",
				"5",
			]),
		).toBe(EXIT.ok);
		expect(t.err.join()).toContain('--character "Rex the dog"');
		await t.run("library", [
			"add",
			"style",
			"Ink",
			"--prompt",
			"ink lines",
			"--model",
			"fake/alpha",
		]);
		await t.run("library", ["--json", "--kind", "style"]);
		expect(t.json()).toMatchObject([{ kind: "style", name: "Ink" }]);
		await expect(t.run("library", ["add", "style", "ink"])).rejects.toThrow(
			"already",
		);
		await expect(
			t.run("library", ["add", "style", "x", "--lora", "a:9"]),
		).rejects.toThrow("weight from -2 to 2");

		// No model named: the style's own, as it can be used.
		const code = await t.run("generate", [
			"rex the dog asleep",
			"--character",
			"rex",
			"--style",
			"ink",
			"--allow-paid",
			"--json",
		]);
		expect(code).toBe(EXIT.ok);
		expect(t.json().jobs[0].modelId).toBe("fake/alpha");
		await expect(
			t.run("generate", ["a fox", "--style", "oil", "--allow-paid"]),
		).rejects.toThrow("No style named oil");

		expect(await t.run("library", ["remove", "ink"])).toBe(EXIT.ok);
		expect(t.err.join()).toContain("Removed the style Ink");
		await t.run("library", ["--json"]);
		expect(t.json().map((e: { name: string }) => e.name)).toEqual([
			"Rex the dog",
		]);
		await expect(t.run("library", ["remove", "nobody"])).rejects.toThrow(
			"Nothing named nobody",
		);
	});
});
