import { describe, expect, test } from "bun:test";
import en from "./locales/en.json";
import { parse } from "./route";
import {
	CHAPTERS,
	type ChapterId,
	chaptersFor,
	loadProgress,
	saveProgress,
	stepsFor,
	type TourState,
	tourReducer,
} from "./tour";

const count = (chapter: ChapterId) => stepsFor(chapter, { demo: false }).length;
const at = (chapter: ChapterId, index: number): TourState => ({
	chapter,
	index,
});

function memory(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
	};
}

describe("steps", () => {
	test("every step's text is in the English catalog", () => {
		const t = (key: string) => {
			expect(key in en).toBe(true);
			return key;
		};
		for (const chapter of CHAPTERS) {
			for (const step of stepsFor(chapter, { demo: false })) {
				step.text(t as never);
			}
		}
	});

	test("step ids are unique within a chapter", () => {
		for (const chapter of CHAPTERS) {
			const ids = stepsFor(chapter, { demo: false }).map((step) => step.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	test("a demo only goes where its visitors can", () => {
		for (const chapter of CHAPTERS) {
			for (const step of stepsFor(chapter, { demo: true })) {
				expect(["chat", "gallery"]).toContain(parse(step.to).view);
				expect(step.hideInDemo).toBeUndefined();
			}
		}
		expect(chaptersFor({ demo: true })).toEqual(["basics"]);
		expect(chaptersFor({ demo: false })).toEqual([...CHAPTERS]);
	});
});

describe("moving through a chapter", () => {
	test("starts at the first step", () => {
		expect(
			tourReducer(null, { type: "start", chapter: "styles" }, count),
		).toEqual(at("styles", 0));
	});

	test("next and back move one step, and back stops at the first", () => {
		expect(tourReducer(at("basics", 0), { type: "next" }, count)).toEqual(
			at("basics", 1),
		);
		expect(tourReducer(at("basics", 2), { type: "back" }, count)).toEqual(
			at("basics", 1),
		);
		expect(tourReducer(at("basics", 0), { type: "back" }, count)).toEqual(
			at("basics", 0),
		);
	});

	test("going past the last step ends the tour", () => {
		const last = count("cloud") - 1;
		expect(tourReducer(at("cloud", last), { type: "next" }, count)).toBeNull();
	});

	test("stop ends the tour, and nothing moves once it has ended", () => {
		expect(tourReducer(at("basics", 2), { type: "stop" }, count)).toBeNull();
		expect(tourReducer(null, { type: "next" }, count)).toBeNull();
	});
});

describe("progress", () => {
	test("is kept between visits", () => {
		const storage = memory();
		saveProgress({ done: ["basics", "cloud"], offered: true }, storage);
		expect(loadProgress(storage)).toEqual({
			done: ["basics", "cloud"],
			offered: true,
		});
	});

	test("starts empty when nothing or something broken was kept", () => {
		const empty = { done: [], offered: false };
		expect(loadProgress(memory())).toEqual(empty);
		expect(loadProgress(memory({ "hatchlight.tour": "{not json" }))).toEqual(
			empty,
		);
		expect(
			loadProgress(
				memory({ "hatchlight.tour": '{"done":["basics","nope"],"offered":1}' }),
			),
		).toEqual({ done: ["basics"], offered: false });
	});
});
