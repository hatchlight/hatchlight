import type { ChatModel, SeenPicture } from "./chat";
import {
	CONSISTENT_SCORE,
	type ConsistencyResult,
	type ConsistencyVerdict,
} from "./types";

/**
 * Whether a picture shows the same character as one to three pictures of it:
 * for a series, such as a comic or a mascot, where a character must look
 * the same in every picture. A model that sees compares them and says what
 * is off, so the next try can fix it.
 */

export interface CompareOptions {
	/** What must stay the same, in words. */
	traits?: string;
	/** The language to write the differences in, such as "pt-BR". */
	language?: string;
}

/** Something that compares a picture with pictures of a character. */
export interface Judge {
	compare(
		references: SeenPicture[],
		candidate: SeenPicture,
		signal: AbortSignal,
		options?: CompareOptions,
	): Promise<ConsistencyResult>;
}

/** Differences kept, and the longest each may be. */
const MAX_DIFFERENCES = 5;
const MAX_DIFFERENCE_LENGTH = 160;
/** The longest traits quoted to the model. */
const MAX_TRAITS = 300;

/** From this score up, the character is the same. */
const SAME_SCORE = 85;

export function verdictOf(score: number): ConsistencyVerdict {
	if (score >= SAME_SCORE) return "same";
	if (score >= CONSISTENT_SCORE) return "close";
	return "different";
}

/** A language's English name, for a model to write in. */
function languageName(language?: string): string {
	if (!language) return "English";
	try {
		return (
			new Intl.DisplayNames(["en"], { type: "language" }).of(language) ??
			"English"
		);
	} catch {
		return "English";
	}
}

/**
 * What a model that sees is asked, after the references and then the
 * picture to check, in that order.
 */
export function consistencyPrompt(
	references: number,
	options: CompareOptions = {},
): string {
	const traits = options.traits?.trim().slice(0, MAX_TRAITS);
	const them =
		references === 1
			? "The first picture shows the character as it must look."
			: `The first ${references} pictures show the character as it must look.`;
	return [
		`These pictures are from one series, such as a comic. ${them} The last picture is a new one, to check.`,
		traits ? `What must stay the same: ${traits}.` : "",
		"Compare only the character: face, hair, body, clothes and their colors, accessories, and drawing style. Ignore the pose, expression, framing, background and light.",
		'Answer with JSON only, no other text: {"score": a number from 0 to 100 for how much the character in the last picture looks like the one before (100 the same, 70 clearly the same with small changes, below 50 another character), "differences": a list of at most 5 short phrases, each saying what is off in the last picture and what it should be, such as "coat is blue, should be green" or "hair is shorter"}. When nothing is off, differences is an empty list.',
		`Write the differences in ${languageName(options.language)}.`,
	]
		.filter(Boolean)
		.join(" ");
}

/** A number from a model, as 0 to 100, or null. */
function scoreOf(value: unknown): number | null {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseFloat(value)
				: Number.NaN;
	if (!Number.isFinite(number)) return null;
	// Some say 0.8 for 80.
	const scaled = number > 0 && number < 1 ? number * 100 : number;
	return Math.round(Math.min(100, Math.max(0, scaled)));
}

function differencesOf(value: unknown): string[] {
	const list = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(/[;\n]/)
			: [];
	return list
		.filter((item): item is string => typeof item === "string")
		.map((item) =>
			item
				.replace(/^[\s\-*•\d.)]+/, "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, MAX_DIFFERENCE_LENGTH),
		)
		.filter(Boolean)
		.slice(0, MAX_DIFFERENCES);
}

/**
 * What a model said, read as a result: JSON when it kept to it, even
 * inside a code block or with words around; else a score written out.
 * Throws when no score can be found.
 */
export function parseConsistency(said: string): ConsistencyResult {
	const start = said.indexOf("{");
	const end = said.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			const value = JSON.parse(said.slice(start, end + 1)) as Record<
				string,
				unknown
			>;
			const score = scoreOf(value.score);
			if (score != null) {
				const differences = differencesOf(value.differences);
				return { score, differences, verdict: verdictOf(score) };
			}
		} catch {
			// Read as words below.
		}
	}
	const written =
		said.match(/score["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i) ??
		said.match(/(\d+(?:\.\d+)?)\s*(?:\/\s*100|out of 100)/i);
	const score = scoreOf(written?.[1]);
	if (score == null) {
		throw new Error("The comparison came back without a score");
	}
	const listed = said.match(/differences["']?\s*[:=]\s*\[([^\]]*)\]?/i)?.[1];
	const differences = listed
		? differencesOf(
				[...listed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]),
			)
		: [];
	return { score, differences, verdict: verdictOf(score) };
}

/**
 * Compares with a language model that sees, such as a cloud one on the
 * person's key: the pictures in one message, in order.
 */
export class ChatJudge implements Judge {
	constructor(private model: ChatModel) {}

	async compare(
		references: SeenPicture[],
		candidate: SeenPicture,
		signal: AbortSignal,
		options: CompareOptions = {},
	): Promise<ConsistencyResult> {
		const pictures = [...references, candidate].map((picture) => ({
			type: "image" as const,
			data: picture.data,
			mimeType: picture.mimeType,
		}));
		const reply = await this.model.chat(
			"You check that a character looks the same in every picture of a series. You answer with JSON only.",
			[
				{
					role: "user",
					content: [
						...pictures,
						{
							type: "text",
							text: consistencyPrompt(references.length, options),
						},
					],
				},
			],
			[],
			signal,
		);
		return parseConsistency(reply.text);
	}
}
