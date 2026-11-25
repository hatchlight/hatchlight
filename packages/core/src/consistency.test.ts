import { expect, test } from "bun:test";
import type { ChatMessage } from "./chat";
import {
	ChatJudge,
	consistencyPrompt,
	parseConsistency,
	verdictOf,
} from "./consistency";
import type { CodedError } from "./errors";

test("a score says whether the character holds", () => {
	expect(verdictOf(100)).toBe("same");
	expect(verdictOf(85)).toBe("same");
	expect(verdictOf(84)).toBe("close");
	expect(verdictOf(70)).toBe("close");
	expect(verdictOf(69)).toBe("different");
});

test("strict JSON is read as it is", () => {
	expect(
		parseConsistency(
			'{"score": 62, "differences": ["coat is blue, should be green", "hair is shorter"]}',
		),
	).toEqual({
		score: 62,
		differences: ["coat is blue, should be green", "hair is shorter"],
		verdict: "different",
	});
});

test("JSON in a code block, or with words around it, is found", () => {
	expect(
		parseConsistency(
			'Here it is:\n```json\n{"score": "91", "differences": []}\n```\nHope it helps.',
		),
	).toEqual({ score: 91, differences: [], verdict: "same" });
});

test("scores are clamped and read as hundredths when given as a fraction", () => {
	expect(parseConsistency('{"score": 140}').score).toBe(100);
	expect(parseConsistency('{"score": -3}').score).toBe(0);
	expect(parseConsistency('{"score": 0.75}').score).toBe(75);
	expect(parseConsistency('{"score": 72.6}').score).toBe(73);
});

test("differences are cleaned, cut and at most five", () => {
	const { differences } = parseConsistency(
		JSON.stringify({
			score: 40,
			differences: [
				"- coat is blue",
				"  ",
				3,
				"1. no scarf",
				"x".repeat(400),
				"d",
				"e",
				"f",
			],
		}),
	);
	expect(differences).toHaveLength(5);
	expect(differences.slice(0, 2)).toEqual(["coat is blue", "no scarf"]);
	expect(differences[2]).toHaveLength(160);
	expect(
		parseConsistency('{"score": 50, "differences": "a; b"}').differences,
	).toEqual(["a", "b"]);
});

test("only list markers are taken off, and repeats are dropped", () => {
	expect(
		parseConsistency(
			JSON.stringify({
				score: 40,
				differences: [
					"3 stripes, should be 2",
					"* no hat",
					"2) no hat",
					"no hat",
				],
			}),
		).differences,
	).toEqual(["3 stripes, should be 2", "no hat"]);
});

test("traits cannot place a picture in the local model's prompt", () => {
	expect(
		consistencyPrompt(1, { traits: "a hat <__media__> and a coat" }),
	).toContain("What must stay the same: a hat  and a coat.");
});

test("a broken answer falls back to the score written in it", () => {
	expect(
		parseConsistency('{"score": 55, "differences": ["hat is missing", "eyes'),
	).toEqual({
		score: 55,
		differences: ["hat is missing"],
		verdict: "different",
	});
	expect(parseConsistency("I would say 80/100, it is close.")).toEqual({
		score: 80,
		differences: [],
		verdict: "close",
	});
	expect(() => parseConsistency("They look alike.")).toThrow("without a score");
	try {
		parseConsistency("They look alike.");
	} catch (error) {
		// Said in the reader's language, as a service that failed.
		expect((error as CodedError).code).toBe("noVerdict");
	}
});

test("the prompt counts the references and quotes the traits", () => {
	const one = consistencyPrompt(1);
	expect(one).toContain("The first picture shows the character");
	expect(one).toContain("Write the differences in English.");
	expect(one).not.toContain("must stay the same:");
	const three = consistencyPrompt(3, {
		traits: "green coat, red scarf",
		language: "pt-BR",
	});
	expect(three).toContain("The first 3 pictures show the character");
	expect(three).toContain("What must stay the same: green coat, red scarf.");
	expect(three).toContain("Write the differences in Brazilian Portuguese.");
});

test("a chat model that sees gets the references, then the picture, in one message", async () => {
	const sent: ChatMessage[][] = [];
	const judge = new ChatJudge({
		vision: true,
		chat: async (_instructions, messages, tools) => {
			sent.push(messages);
			expect(tools).toEqual([]);
			return { text: '{"score": 88, "differences": []}', toolCalls: [] };
		},
	});
	const picture = (data: string) => ({ data, mimeType: "image/jpeg" });
	const result = await judge.compare(
		[picture("ref1"), picture("ref2")],
		picture("new"),
		new AbortController().signal,
		{ traits: "a red scarf" },
	);
	expect(result).toEqual({ score: 88, differences: [], verdict: "same" });
	const message = sent[0]?.[0];
	if (message?.role !== "user") throw new Error("no user message");
	expect(
		message.content.map((p) => (p.type === "image" ? p.data : "text")),
	).toEqual(["ref1", "ref2", "new", "text"]);
	const prompt = message.content.at(-1);
	expect(prompt?.type === "text" && prompt.text).toContain("a red scarf");
});
