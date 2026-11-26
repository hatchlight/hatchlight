import { describe, expect, test } from "bun:test";
import type { GenerationParams } from "@hatchlight/core/types";
import { rerunInput } from "./rerun";

const params = {
	prompt: "the person in picture 1 on the beach, soft watercolor",
	count: 4,
	referenceAssetIds: ["ast_rex", "ast_ref"],
	loras: [{ id: "rexy", weight: 0.7 }],
	seed: 42,
	aspectRatio: "16:9",
	strength: 0.6,
	extras: { steps: 30 },
	characterId: "lib_rex",
	styleId: "lib_watercolor",
	library: { prompt: "Rex on the beach", character: "Rex" },
	translatedPrompt: "the person in picture 1 on the beach",
} satisfies GenerationParams;

const item = { modelId: "fake/alpha", params, sessionId: "ses_1" };

describe("running a result again", () => {
	test("keeps the model, words and settings, with a new seed", () => {
		expect(rerunInput(item, false, () => 7)).toEqual({
			prompt: "the person in picture 1 on the beach, soft watercolor",
			count: 1,
			referenceAssetIds: ["ast_rex", "ast_ref"],
			loras: [{ id: "rexy", weight: 0.7 }],
			seed: 7,
			aspectRatio: "16:9",
			strength: 0.6,
			extras: { steps: 30 },
			modelIds: ["fake/alpha"],
			sessionId: "ses_1",
		});
	});

	test("keeps the seed when asked to", () => {
		expect(rerunInput(item, true, () => 7)?.seed).toBe(42);
	});

	test("starts a new session when the one that made it is gone", () => {
		expect(
			rerunInput({ ...item, sessionId: null }, false)?.sessionId,
		).toBeUndefined();
	});

	test("a new seed is a whole number a model takes", () => {
		const seed = rerunInput(item, false)?.seed ?? -1;
		expect(Number.isInteger(seed)).toBe(true);
		expect(seed).toBeGreaterThanOrEqual(0);
		expect(seed).toBeLessThan(2 ** 31);
	});

	test("nothing to run again without a model or what it was given", () => {
		expect(rerunInput({ ...item, modelId: null }, false)).toBeNull();
		expect(rerunInput({ ...item, params: null }, false)).toBeNull();
	});
});
