import {
	type GenerationParams,
	type LibraryEntry,
	type LibraryInput,
	type LibraryKind,
	type LoraInfo,
	MAX_LIBRARY_PICTURES,
	MAX_LORAS,
} from "@hatchlight/core/types";
import type { I18n } from "./i18n";
import { href, navigate } from "./route";

/** What an entry adds, in a few words. */
export function libraryFacts(
	t: I18n["t"],
	entry: Pick<LibraryEntry, "pictureIds" | "loras" | "prompt">,
): string {
	return [
		entry.pictureIds.length > 0 &&
			t("library.pictures", { count: entry.pictureIds.length }),
		entry.loras.length > 0 && t("library.loras", { count: entry.loras.length }),
		entry.prompt,
	]
		.filter(Boolean)
		.join(" · ");
}

/** A character or style being written, new or (with `id`) changed. */
export type LibraryDraft = LibraryInput & { id?: string };

/** What the Library opens with next, set from elsewhere in the app. */
let pending: LibraryDraft | null = null;

/** Opens the Library with a draft to finish and save. */
export function openLibraryDraft(draft: LibraryDraft): void {
	pending = draft;
	navigate(href.library);
}

/** The draft waiting for the Library, once: it is then forgotten. */
export function takeLibraryDraft(): LibraryDraft | null {
	const draft = pending;
	pending = null;
	return draft;
}

/** An entry as a draft to change. */
export function draftOf(entry: LibraryEntry): LibraryDraft {
	const { createdAt: _created, updatedAt: _updated, ...rest } = entry;
	return rest;
}

/** The LoRAs a picture was made with, with the trigger words they have. */
function lorasOf(
	params: GenerationParams | null,
	installed: LoraInfo[],
): NonNullable<LibraryInput["loras"]> {
	return (params?.loras ?? []).slice(0, MAX_LORAS).flatMap(({ id, weight }) => {
		const lora = installed.find((l) => l.id === id);
		return lora ? [{ id, weight, trigger: lora.trigger }] : [];
	});
}

/**
 * A character or style made from a picture: the picture itself first, then
 * what it was made from (its references, LoRAs, words and seed).
 */
export function draftFromPicture(
	kind: LibraryKind,
	item: {
		assetId: string;
		prompt: string | null;
		params: GenerationParams | null;
	},
	installed: LoraInfo[],
): LibraryDraft {
	const params = item.params;
	const pictures = [item.assetId, ...(params?.referenceAssetIds ?? [])];
	return {
		kind,
		name: "",
		pictureIds: [...new Set(pictures)].slice(
			0,
			kind === "character" ? MAX_LIBRARY_PICTURES : 1,
		),
		loras: lorasOf(params, installed),
		// The words as written: a character's or style's own were added later.
		prompt: params?.library?.prompt ?? item.prompt ?? null,
		seed: kind === "character" ? (params?.seed ?? null) : null,
		aspectRatio: kind === "style" ? (params?.aspectRatio ?? null) : null,
	};
}

/** A character or style made from a LoRA just trained, with its trigger word. */
export function draftFromLora(
	kind: LibraryKind,
	lora: { id: string; name: string; trigger: string | null },
): LibraryDraft {
	return {
		kind,
		name: lora.name,
		loras: [{ id: lora.id, weight: 1, trigger: lora.trigger }],
	};
}
