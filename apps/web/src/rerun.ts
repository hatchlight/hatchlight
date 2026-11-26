import type { CreateTurnInput, GalleryItem } from "@hatchlight/core/types";

/** A seed picked at random, kept with the result so it can be made again. */
export function randomSeed(): number {
	return Math.floor(Math.random() * 2 ** 31);
}

/**
 * A picture or video asked for again as it was made: the same model,
 * words and settings, one of it, in the session that made it while it is
 * kept. The seed is new unless `sameSeed`, and then the one it was made
 * with. Null for what no model made.
 */
export function rerunInput(
	item: Pick<GalleryItem, "modelId" | "params" | "sessionId">,
	sameSeed: boolean,
	seed: () => number = randomSeed,
): CreateTurnInput | null {
	if (!item.modelId || !item.params) return null;
	// Sent as the model got them: the words and pictures of a character or
	// style are in them already, so the entries are not added again.
	const {
		characterId: _character,
		styleId: _style,
		library: _library,
		translatedPrompt: _translated,
		...params
	} = item.params;
	return {
		...params,
		count: 1,
		seed: sameSeed ? params.seed : seed(),
		modelIds: [item.modelId],
		sessionId: item.sessionId ?? undefined,
	};
}
