import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
	cleanTranslation,
	loraPrompt,
	sameWords,
	samplingProgress,
} from "./index";

/**
 * Text that comes from outside — a pasted prompt, a language model's reply,
 * the engine's output — read with random input, not only the cases we
 * thought of.
 */

const TAG = /<(?:lora|lyco|hypernet):[^>]*>/i;

/** Strings made mostly of the pieces the readers look for. */
const tricky = (pieces: string[]) =>
	fc
		.array(fc.oneof(fc.constantFrom(...pieces), fc.string({ maxLength: 4 })), {
			maxLength: 40,
		})
		.map((parts) => parts.join(""));

describe("a pasted prompt", () => {
	test("keeps no LoRA tag of its own", () => {
		const prompt = tricky([
			"<lora:",
			"<LoRA:",
			"<lyco:",
			"<hypernet:",
			">",
			"<",
			":",
			"x",
			" ",
		]);
		fc.assert(
			fc.property(prompt, (text) => {
				expect(loraPrompt(text, [])).not.toMatch(TAG);
			}),
		);
	});

	test("without tags comes back with its words", () => {
		const plain = fc.string().filter((text) => !text.includes("<"));
		fc.assert(
			fc.property(plain, (text) => {
				expect(sameWords(loraPrompt(text, []), text)).toBe(true);
			}),
		);
	});
});

describe("a language model's reply", () => {
	test("loses what it reasoned before answering", () => {
		const free = (word: string) =>
			fc.string().filter((text) => !text.includes(word));
		fc.assert(
			fc.property(free("</think>"), free("<think>"), (thought, answer) => {
				expect(cleanTranslation(`<think>${thought}</think>${answer}`)).toBe(
					cleanTranslation(answer),
				);
			}),
		);
	});

	test("is never made longer", () => {
		const reply = tricky([
			"<think>",
			"</think>",
			"Translation:",
			'"',
			"“",
			"”",
			"'",
			" ",
		]);
		fc.assert(
			fc.property(reply, (text) => {
				expect(cleanTranslation(text).length).toBeLessThanOrEqual(text.length);
			}),
		);
	});
});

describe("the engine's progress bar", () => {
	test("never reads a step past the end", () => {
		const line = tricky([
			"|",
			"=",
			">",
			" ",
			"/",
			"-",
			"s/it",
			"it/s",
			"3",
			"0",
			".",
		]);
		fc.assert(
			fc.property(fc.oneof(line, fc.string()), (text) => {
				const progress = samplingProgress(text);
				if (progress) {
					expect(progress.steps).toBeGreaterThan(0);
					expect(progress.step).toBeLessThanOrEqual(progress.steps);
				}
			}),
		);
	});

	test("reads the step and the steps it shows", () => {
		fc.assert(
			fc.property(
				fc.nat(500),
				fc.integer({ min: 1, max: 500 }),
				(step, steps) => {
					const shown = Math.min(step, steps);
					expect(
						samplingProgress(`  |=====>   | ${shown}/${steps} - 1.25s/it`),
					).toEqual({ step: shown, steps });
				},
			),
		);
	});
});
