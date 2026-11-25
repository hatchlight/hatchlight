import { describe, expect, test } from "bun:test";
import type { JobView, TurnView } from "@hatchlight/core/types";
import { blindLetter, blindOrder, hasChoice, namesHidden } from "./compare";

describe("a blind comparison", () => {
	const items = ["a", "b", "c", "d", "e"];

	test("has an order of its own that a reload keeps", () => {
		const first = blindOrder(items, "trn_1");
		expect(blindOrder(items, "trn_1")).toEqual(first);
		expect(first.toSorted()).toEqual(items);
		// Some turn puts the results in another order than they were asked.
		const orders = new Set(
			Array.from({ length: 20 }, (_, i) =>
				blindOrder(items, `trn_${i}`).join(""),
			),
		);
		expect(orders.size).toBeGreaterThan(5);
		expect(items).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("names its results by letter", () => {
		expect([0, 1, 2].map(blindLetter)).toEqual(["A", "B", "C"]);
		expect(blindLetter(26)).toBe("27");
	});

	test("hides the names only of models compared, until a pick", () => {
		const job = (assets: number) =>
			({
				assets: Array.from({ length: assets }, (_, i) => ({ id: `a${i}` })),
			}) as JobView;
		const turn = (jobs: JobView[], picked: string | null = null) =>
			({ id: "t", jobs, pickedAssetId: picked }) as TurnView;
		expect(namesHidden(turn([job(1), job(1)]), true)).toBe(true);
		expect(namesHidden(turn([job(1), job(1)]), false)).toBe(false);
		expect(namesHidden(turn([job(1), job(1)], "a0"), true)).toBe(false);
		expect(namesHidden(turn([job(4)]), true)).toBe(false);
		// Only results of two models or more can be picked: they alone rank.
		expect(hasChoice(turn([job(1), job(1)]))).toBe(true);
		expect(hasChoice(turn([job(4)]))).toBe(false);
		expect(hasChoice(turn([job(1), job(0)]))).toBe(false);
	});
});
