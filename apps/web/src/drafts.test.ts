import { describe, expect, test } from "bun:test";
import type { GenerationParams, LoraInfo } from "@hatchlight/core/types";
import { draftFromLora, draftFromPicture, libraryFacts } from "./drafts";

const installed: LoraInfo[] = [
	{
		id: "rexy",
		name: "Rexy",
		base: "sdxl",
		trigger: "rexdog",
		size: 1,
		addedAt: 1,
	},
];

const params = {
	prompt: "rexdog, the person in picture 1 on the beach, soft watercolor",
	count: 1,
	referenceAssetIds: ["ast_ref", "ast_made"],
	loras: [
		{ id: "rexy", weight: 0.7 },
		{ id: "gone", weight: 1 },
	],
	seed: 42,
	aspectRatio: "16:9",
	extras: {},
	library: { prompt: "Rex on the beach", character: "Rex" },
} satisfies GenerationParams;

describe("saving a picture to the library", () => {
	test("a character keeps the picture first, its references, LoRAs, words and seed", () => {
		expect(
			draftFromPicture(
				"character",
				{ assetId: "ast_made", prompt: "Rex on the beach", params },
				installed,
			),
		).toEqual({
			kind: "character",
			name: "",
			pictureIds: ["ast_made", "ast_ref"],
			loras: [{ id: "rexy", weight: 0.7, trigger: "rexdog" }],
			prompt: "Rex on the beach",
			seed: 42,
			aspectRatio: null,
		});
	});

	test("a style keeps the picture and its shape, not its seed", () => {
		expect(
			draftFromPicture(
				"style",
				{ assetId: "ast_made", prompt: "a fox", params: null },
				installed,
			),
		).toMatchObject({
			pictureIds: ["ast_made"],
			loras: [],
			prompt: "a fox",
			seed: null,
			aspectRatio: null,
		});
		expect(
			draftFromPicture("style", { assetId: "a", prompt: null, params }, []),
		).toMatchObject({ aspectRatio: "16:9", seed: null });
	});

	test("a LoRA just trained becomes an entry with its trigger word", () => {
		expect(
			draftFromLora("character", {
				id: "rexy",
				name: "Rex",
				trigger: "rexdog",
			}),
		).toEqual({
			kind: "character",
			name: "Rex",
			loras: [{ id: "rexy", weight: 1, trigger: "rexdog" }],
		});
	});

	test("says what an entry adds", () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			`${key}:${values?.count}`;
		expect(
			libraryFacts(t as never, {
				pictureIds: ["a", "b"],
				loras: [],
				prompt: "ink",
			}),
		).toBe("library.pictures:2 · ink");
	});
});
