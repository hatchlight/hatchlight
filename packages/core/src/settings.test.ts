import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSettingsStore } from "./settings";
import { chooseLocalModel } from "./types";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function store() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-settings-"));
	dirs.push(dir);
	const path = join(dir, "settings.json");
	return { settings: new FileSettingsStore(path), path };
}

const ana = { userId: "ana" };
const bia = { userId: "bia" };

describe("settings", () => {
	test("translate on this computer until a person chooses otherwise", async () => {
		const { settings } = await store();
		expect(await settings.get(ana)).toEqual({
			translateWith: "local",
			improveWith: "auto",
			assistantWith: "auto",
			otherAppsPaid: false,
			otherAppsModel: null,
			blindPicks: false,
			writerModel: null,
			eyesModel: null,
		});
	});

	test("are kept per person, and survive a restart", async () => {
		const { settings, path } = await store();
		expect(await settings.set(ana, { translateWith: "openai" })).toEqual({
			translateWith: "openai",
			improveWith: "auto",
			assistantWith: "auto",
			otherAppsPaid: false,
			otherAppsModel: null,
			blindPicks: false,
			writerModel: null,
			eyesModel: null,
		});
		expect(await settings.set(ana, { improveWith: "local" })).toEqual({
			translateWith: "openai",
			improveWith: "local",
			assistantWith: "auto",
			otherAppsPaid: false,
			otherAppsModel: null,
			blindPicks: false,
			writerModel: null,
			eyesModel: null,
		});
		expect(await settings.get(bia)).toEqual({
			translateWith: "local",
			improveWith: "auto",
			assistantWith: "auto",
			otherAppsPaid: false,
			otherAppsModel: null,
			blindPicks: false,
			writerModel: null,
			eyesModel: null,
		});
		expect(await new FileSettingsStore(path).get(ana)).toEqual({
			translateWith: "openai",
			improveWith: "local",
			assistantWith: "auto",
			otherAppsPaid: false,
			otherAppsModel: null,
			blindPicks: false,
			writerModel: null,
			eyesModel: null,
		});
	});

	test("a value Hatchlight does not know reads as the default", async () => {
		const { path } = await store();
		await writeFile(
			path,
			JSON.stringify({
				ana: { translateWith: "carrier pigeon", improveWith: "owl" },
			}),
		);
		expect(await new FileSettingsStore(path).get(ana)).toEqual({
			translateWith: "local",
			improveWith: "auto",
			assistantWith: "auto",
			otherAppsPaid: false,
			otherAppsModel: null,
			blindPicks: false,
			writerModel: null,
			eyesModel: null,
		});
		await writeFile(path, "not json");
		expect(await new FileSettingsStore(path).get(ana)).toEqual({
			translateWith: "local",
			improveWith: "auto",
			assistantWith: "auto",
			otherAppsPaid: false,
			otherAppsModel: null,
			blindPicks: false,
			writerModel: null,
			eyesModel: null,
		});
	});

	test("changes made at once are all kept", async () => {
		const { settings } = await store();
		await Promise.all([
			settings.set(ana, { translateWith: "google" }),
			settings.set(bia, { translateWith: "off" }),
		]);
		expect((await settings.get(ana)).translateWith).toBe("google");
		expect((await settings.get(bia)).translateWith).toBe("off");
	});
});

test("the first owner of a server takes the choices made before", async () => {
	const { settings } = await store();
	await settings.set({ userId: "local" }, { translateWith: "openai" });
	await settings.moveUser("local", ana.userId);
	expect((await settings.get(ana)).translateWith).toBe("openai");
	expect((await settings.get({ userId: "local" })).translateWith).toBe("local");
	// Choices someone already made are kept.
	await settings.set({ userId: "local" }, { translateWith: "google" });
	await settings.moveUser("local", ana.userId);
	expect((await settings.get(ana)).translateWith).toBe("openai");
});

describe("the language models chosen for this computer", () => {
	test("are kept, and anything but an id reads as none chosen", async () => {
		const { settings, path } = await store();
		expect(
			await settings.set(ana, {
				writerModel: "qwen3-4b-instruct",
				eyesModel: "qwen3-vl-4b",
			}),
		).toMatchObject({
			writerModel: "qwen3-4b-instruct",
			eyesModel: "qwen3-vl-4b",
		});
		expect(await settings.set(ana, { eyesModel: null })).toMatchObject({
			writerModel: "qwen3-4b-instruct",
			eyesModel: null,
		});
		await writeFile(
			path,
			JSON.stringify({ ana: { writerModel: 4, eyesModel: ["x"] } }),
		);
		expect(await new FileSettingsStore(path).get(ana)).toMatchObject({
			writerModel: null,
			eyesModel: null,
		});
	});

	const eyes = ["qwen2.5-vl-7b", "qwen3-vl-8b", "qwen3-vl-4b"];
	const installed =
		(...ids: string[]) =>
		(id: string) =>
			ids.includes(id);

	test("the chosen one does the job while it is installed", () => {
		expect(
			chooseLocalModel(
				eyes,
				"qwen3-vl-4b",
				installed("qwen2.5-vl-7b", "qwen3-vl-4b"),
			),
		).toBe("qwen3-vl-4b");
	});

	test("none chosen, the first installed in the catalog's order does it", () => {
		expect(
			chooseLocalModel(eyes, null, installed("qwen3-vl-4b", "qwen3-vl-8b")),
		).toBe("qwen3-vl-8b");
		expect(chooseLocalModel(eyes, null, installed())).toBeNull();
	});

	test("a chosen one deleted, or unknown, falls back to one installed", () => {
		expect(
			chooseLocalModel(eyes, "qwen3-vl-4b", installed("qwen2.5-vl-7b")),
		).toBe("qwen2.5-vl-7b");
		expect(
			chooseLocalModel(eyes, "flux-2-klein-4b", installed("qwen3-vl-4b")),
		).toBe("qwen3-vl-4b");
		expect(chooseLocalModel(eyes, "qwen3-vl-4b", installed())).toBeNull();
	});
});
