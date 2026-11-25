import { describe, expect, test } from "bun:test";
import {
	median,
	type PickedTurn,
	promptKinds,
	rankModels,
	wilsonLowerBound,
} from "./ranking";
import type { JobView, ModelSpec, TurnView } from "./types";

describe("kinds of prompt", () => {
	test("are told by words, in English and Portuguese, accents or not", () => {
		expect(promptKinds("A close-up portrait of an old sailor")).toEqual([
			"portrait",
		]);
		expect(promptKinds("Retrato de uma senhora, foto realista")).toEqual([
			"portrait",
			"photo",
		]);
		expect(promptKinds("Paisagem de montanhas ao pôr do sol")).toEqual([
			"landscape",
		]);
		expect(promptKinds("anime girl, watercolor")).toEqual(["illustration"]);
		expect(promptKinds("ilustração de um gato")).toEqual(["illustration"]);
		expect(promptKinds("a perfume bottle on marble, product shot")).toEqual([
			"product",
		]);
	});

	test("words to write in quotes mean text in the picture", () => {
		expect(promptKinds('a cafe sign that reads "OPEN"')).toEqual(["text"]);
		expect(promptKinds("uma placa com “Aberto”")).toEqual(["text"]);
		expect(promptKinds('a mug with "hello"')).toEqual(["text"]);
	});

	test("match whole words only, plural or not", () => {
		expect(promptKinds("a design on the surface of a texture")).toEqual([]);
		expect(promptKinds("two mountains and lakes")).toEqual(["landscape"]);
	});

	test("pictures given make it editing", () => {
		expect(promptKinds("make the sky purple", 1)).toEqual(["editing"]);
		expect(promptKinds("make the sky purple")).toEqual([]);
	});
});

describe("ranking math", () => {
	test("the median of an even list is the mean of its middle two", () => {
		expect(median([])).toBeNull();
		expect(median([5])).toBe(5);
		expect(median([9, 1, 5])).toBe(5);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});

	test("one win in one counts for less than eight in ten", () => {
		expect(wilsonLowerBound(0, 0)).toBe(0);
		expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.207, 2);
		expect(wilsonLowerBound(8, 10)).toBeGreaterThan(wilsonLowerBound(1, 1));
		expect(wilsonLowerBound(10, 10)).toBeLessThan(1);
	});
});

const spec = (id: string, media: "image" | "video" = "image") =>
	({ id, name: id.toUpperCase(), media }) as ModelSpec;
const MODELS = new Map(
	[
		spec("local/a"),
		spec("paid/b"),
		spec("paid/c"),
		spec("paid/v", "video"),
		spec("paid/w", "video"),
	].map((m) => [m.id, m]),
);

let ids = 0;
function job(modelId: string, patch: Partial<JobView> = {}): JobView {
	const id = `job_${++ids}`;
	return {
		id,
		turnId: "",
		position: 0,
		userId: "u",
		providerId: modelId.split("/")[0] as string,
		modelId,
		params: { prompt: "", count: 1, referenceAssetIds: [] } as never,
		status: "succeeded",
		handle: null,
		error: null,
		errorCode: null,
		errorParams: null,
		costUsd: modelId.startsWith("paid") ? 0.04 : null,
		createdAt: 0,
		startedAt: 1000,
		finishedAt: 3000,
		assets: [{ id: `ast_${id}`, mime: "image/png" } as never],
		...patch,
	};
}

function picked(
	jobs: JobView[],
	winner: string,
	prompt = "a fox",
	createdAt = 0,
): PickedTurn {
	const turn: TurnView = {
		id: `trn_${++ids}`,
		sessionId: "s",
		userId: "u",
		prompt,
		referenceAssetIds: [],
		createdAt,
		jobs,
	};
	const won = jobs.find((j) => j.modelId === winner) as JobView;
	return { turn, assetId: won.assets[0]?.id ?? "", modelId: winner };
}

const rank = (turns: PickedTurn[], options = {}) =>
	rankModels(turns, { model: (id) => MODELS.get(id), ...options });

describe("ranking", () => {
	test("counts wins over comparisons, with medians per picture", () => {
		const ranking = rank([
			picked([job("local/a"), job("paid/b")], "local/a"),
			picked(
				[
					job("local/a", { startedAt: 0, finishedAt: 8000 }),
					job("paid/b", {
						params: { count: 2 } as never,
						costUsd: 0.1,
					}),
				],
				"local/a",
			),
			picked([job("local/a"), job("paid/b")], "paid/b"),
		]);
		expect(ranking.comparisons).toBe(3);
		const [a, b] = ranking.models;
		expect(a).toMatchObject({
			modelId: "local/a",
			name: "LOCAL/A",
			wins: 2,
			comparisons: 3,
			few: true,
			msPerOutput: 2000,
			usdPerOutput: 0,
		});
		expect(a?.winRate).toBeCloseTo(2 / 3);
		// Two pictures for 0.10 is 0.05 each; times are per picture too.
		expect(b).toMatchObject({ wins: 1, msPerOutput: 2000 });
		expect(b?.usdPerOutput).toBeCloseTo(0.04);
	});

	test("a lucky single win does not top a steady winner", () => {
		const turns = [picked([job("paid/c"), job("paid/b")], "paid/c")];
		for (let i = 0; i < 10; i++) {
			turns.push(
				picked([job("local/a"), job("paid/b")], i < 8 ? "local/a" : "paid/b"),
			);
		}
		const ranking = rank(turns);
		expect(ranking.models.map((m) => m.modelId)).toEqual([
			"local/a",
			"paid/c",
			"paid/b",
		]);
		expect(ranking.models[0]?.few).toBe(false);
		expect(ranking.models[1]?.few).toBe(true);
	});

	test("only turns where two models made something are comparisons", () => {
		const ranking = rank([
			// One model with several pictures: nothing to rank between.
			picked([job("local/a"), job("paid/b", { status: "failed" })], "local/a"),
			picked([job("local/a")], "local/a"),
		]);
		expect(ranking).toMatchObject({ comparisons: 0, models: [] });
	});

	test("narrows by media and by kind of prompt", () => {
		const turns = [
			picked([job("local/a"), job("paid/b")], "local/a", "a portrait"),
			picked([job("local/a"), job("paid/b")], "paid/b", "a beach"),
			picked([job("paid/v"), job("paid/w")], "paid/w"),
		];
		expect(rank(turns, { kind: "portrait" }).models[0]?.modelId).toBe(
			"local/a",
		);
		expect(rank(turns, { kind: "landscape" }).models[0]?.modelId).toBe(
			"paid/b",
		);
		expect(rank(turns, { media: "image" }).comparisons).toBe(2);
		expect(rank(turns, { media: "video" }).models[0]?.modelId).toBe("paid/w");
		// A model not known any more is told by what it made.
		const gone = picked(
			[
				job("old/x", { assets: [{ id: "x", mime: "video/mp4" } as never] }),
				job("old/y", { assets: [{ id: "y", mime: "video/mp4" } as never] }),
			],
			"old/x",
		);
		expect(rank([gone], { media: "video" }).models[0]).toMatchObject({
			name: "old/x",
			media: "video",
		});
	});

	test("the example is the latest picture a model won with", () => {
		const first = picked([job("local/a"), job("paid/b")], "local/a", "x", 1);
		const last = picked([job("local/a"), job("paid/b")], "local/a", "x", 2);
		const ranking = rank([last, first]);
		expect(ranking.models[0]?.exampleAssetId).toBe(last.assetId);
		expect(ranking.models[1]?.exampleAssetId).toBeNull();
	});
});
