import type { TurnView } from "./types";

type Results = Pick<TurnView, "jobs" | "pickedAssetId">;

/** A number from a text, the same every time: FNV-1a. */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Numbers from 0 to 1 that follow from the seed: mulberry32. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The results of a blind comparison in an order of their own, so the first
 * is not always the first model chosen; seeded by the turn, so a reload
 * shows the same order.
 */
export function blindOrder<T>(items: readonly T[], turnId: string): T[] {
	const next = random(hash(turnId));
	const order = [...items];
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[order[i], order[j]] = [order[j] as T, order[i] as T];
	}
	return order;
}

/** "A", "B", "C"… for the results of a blind comparison. */
export function blindLetter(index: number): string {
	return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** Whether a turn compares several models, the kind that can be blind. */
export const comparesModels = (turn: Results) => turn.jobs.length > 1;

/**
 * Results to choose the best of: pictures or videos from two models or
 * more. Only those count toward the ranking, so only those can be picked.
 */
export const hasChoice = (turn: Results) =>
	turn.jobs.filter((job) => job.assets.length > 0).length > 1;

/** Whether the models' names stay hidden: blind, and nothing picked yet. */
export const namesHidden = (turn: Results, blind: boolean) =>
	blind && comparesModels(turn) && !turn.pickedAssetId;
