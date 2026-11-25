import { ValidationError } from "./errors";
import {
	followsGuide,
	type GenerationParams,
	type GuideKind,
	type LibraryEntry,
	type LibraryKind,
	type LoraInfo,
	MAX_LORAS,
	type ModelCapabilities,
	type ModelSpec,
} from "./types";

/**
 * Characters and styles a person keeps, and how one is added to a
 * generation: its pictures go first among the references, its LoRAs join
 * the person's, and its words join the prompt. Nothing here reads the
 * database, so the app and agents can use it too.
 */

/** A name as typed, to compare: no case, accents or extra spaces. */
export function looseName(name: string): string {
	return name
		.normalize("NFC")
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The entry of this kind a name means: the same name, else the only one
 * that starts with it, else the only one that contains it. `matches` lists
 * them when the name could mean several, and is empty when it means none.
 */
export function findLibraryEntry(
	entries: LibraryEntry[],
	kind: LibraryKind,
	name: string,
): { entry: LibraryEntry } | { entry: null; matches: LibraryEntry[] } {
	const wanted = looseName(name);
	const mine = entries.filter((e) => e.kind === kind);
	const tries = [
		(n: string) => n === wanted,
		(n: string) => n.startsWith(wanted),
		(n: string) => n.includes(wanted) || (n.length > 2 && wanted.includes(n)),
	];
	for (const fits of tries) {
		const found = wanted ? mine.filter((e) => fits(looseName(e.name))) : [];
		if (found.length === 1) return { entry: found[0] as LibraryEntry };
		if (found.length > 1) return { entry: null, matches: found };
	}
	return { entry: null, matches: [] };
}

/** `<character:name>` and `<style:name>`, as other apps write them. */
const TAG = /<(character|style):([^<>:]+)>/gi;

/** The character and style a prompt names in tags, and the prompt without them. */
export function libraryTags(prompt: string): {
	prompt: string;
	character?: string;
	style?: string;
} {
	const named: { character?: string; style?: string } = {};
	const text = prompt.replace(TAG, (_tag, kind: string, name: string) => {
		const key = kind.toLowerCase() as LibraryKind;
		named[key] ??= name.trim();
		return " ";
	});
	if (!named.character && !named.style) return { prompt };
	return { prompt: text.replace(/\s{2,}/g, " ").trim(), ...named };
}

/** Whether a model follows given pictures as examples (not redrawing them). */
export function followsPictures(caps: ModelCapabilities): boolean {
	return (
		caps.maxReferenceImages > 0 && caps.strength == null && caps.upscale == null
	);
}

/** What a generation needs of a model, besides a character and a style. */
export interface ModelNeeds {
	/** The person's own pictures. */
	references: number;
	guide?: { kind: GuideKind; ready: boolean };
}

/**
 * The model a character or style prefers, when nothing else is chosen and
 * it can be used and fits what is asked (pictures, guide): the
 * character's first.
 */
export function libraryModel(
	usable: ModelSpec[],
	entries: (LibraryEntry | null | undefined)[],
	needs: ModelNeeds = { references: 0 },
): ModelSpec | null {
	const pictures = entries.some(
		(e) => e?.kind === "character" && e.pictureIds.length > 0,
	);
	const fits = (model: ModelSpec) => {
		const caps = model.capabilities;
		if (needs.references > caps.maxReferenceImages) return false;
		if (needs.guide && !followsGuide(caps.guide, needs.guide)) return false;
		// Its only picture would be the character's, which it must follow.
		if (caps.needsReference && needs.references === 0) {
			return pictures && followsPictures(caps);
		}
		return true;
	};
	for (const entry of entries) {
		const found = usable.find((m) => m.id === entry?.modelId);
		if (found && fits(found)) return found;
	}
	return null;
}

/** "1", "1 and 2", "1, 2 and 3". */
const numbers = (list: number[]) =>
	list.length === 1
		? String(list[0])
		: `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the words are in the text as words, whatever their case. */
const has = (text: string, words: string) =>
	new RegExp(
		`(?<![\\p{L}\\p{N}])${literal(words.trim())}(?![\\p{L}\\p{N}])`,
		"iu",
	).test(text);

/**
 * A prompt that already calls something by its picture's number, in any
 * of the languages people write here: "picture 1", "imagem 2", "foto 1".
 */
const NUMBERED =
	/(?<![\p{L}])(pictures?|images?|imagens?|imagem|photos?|fotos?)\s+\d/iu;

/**
 * Adds a character and a style to what one model is asked, as far as that
 * model can take them:
 *
 * - their pictures go before the person's own, for a model that follows
 *   given pictures, within how many it takes; the prompt then calls the
 *   character "the person in picture 1" (in place of its name, if there);
 * - their LoRAs of the model's family join the person's, which win;
 * - their words, and their LoRAs' trigger words, join the prompt when it
 *   does not have them yet;
 * - their seed and ratio are used when none was asked for.
 *
 * Throws when the character would add nothing a model can use: neither
 * its pictures nor its LoRAs. `loras` are the ones installed, by id.
 */
export function applyLibrary(
	params: GenerationParams,
	model: ModelSpec,
	used: { character?: LibraryEntry | null; style?: LibraryEntry | null },
	loras: ReadonlyMap<string, LoraInfo>,
): GenerationParams {
	const { character, style } = used;
	if (!character && !style) return params;
	const caps = model.capabilities;
	const own = params.referenceAssetIds;
	// A mask marks the one picture given: nothing may join it.
	const room =
		followsPictures(caps) && params.maskAssetId == null
			? Math.max(0, caps.maxReferenceImages - own.length)
			: 0;
	const added: string[] = [];
	for (const id of [
		...(character?.pictureIds ?? []),
		...(style?.pictureIds ?? []),
	]) {
		if (added.length >= room) break;
		if (!own.includes(id) && !added.includes(id)) added.push(id);
	}
	const references = [...added, ...own];

	const fits = (id: string) =>
		caps.loraBase != null && loras.get(id)?.base === caps.loraBase;
	const theirs = [...(character?.loras ?? []), ...(style?.loras ?? [])].filter(
		(l) => fits(l.id),
	);
	const mine = params.loras ?? [];
	const joined = [
		...mine,
		...theirs
			.filter((l, i) => theirs.findIndex((o) => o.id === l.id) === i)
			.filter((l) => !mine.some((m) => m.id === l.id))
			.map(({ id, weight }) => ({ id, weight })),
	];
	// The engine takes so many of one family at once.
	if (joined.filter((l) => fits(l.id)).length > MAX_LORAS) {
		throw new ValidationError(
			`At most ${MAX_LORAS} LoRAs can be used at once, with those of ${[character?.name, style?.name].filter(Boolean).join(" and ")}`,
			"tooManyLoras",
			{ max: MAX_LORAS },
		);
	}

	const seen = character
		? character.pictureIds.flatMap((id) => {
				const at = references.indexOf(id);
				return at >= 0 ? [at + 1] : [];
			})
		: [];
	if (
		character &&
		seen.length === 0 &&
		!character.loras.some((l) => fits(l.id)) &&
		(character.pictureIds.length > 0 || character.loras.length > 0)
	) {
		throw new ValidationError(
			`${model.name} can use neither the pictures nor the LoRAs of ${character.name}`,
			"characterNotUsable",
			{ model: model.name, name: character.name },
		);
	}

	let text = params.prompt;
	if (character && seen.length > 0 && !NUMBERED.test(text)) {
		const who = `the person in ${seen.length === 1 ? "picture" : "pictures"} ${numbers(seen)}`;
		// The name as saved, its case too, once: "Cat" is a name, "a cat"
		// is not, and other words stay as written.
		const name = new RegExp(
			`(?<![\\p{L}\\p{N}])${literal(character.name)}(?![\\p{L}\\p{N}])`,
			"u",
		);
		text = name.test(text)
			? text.replace(name, who)
			: `${who[0]?.toUpperCase()}${who.slice(1)}, ${text}`;
	}
	const styleSeen = style
		? style.pictureIds.flatMap((id) => {
				const at = references.indexOf(id);
				return at >= 0 && !seen.includes(at + 1) ? [at + 1] : [];
			})
		: [];
	const words = [
		character?.prompt,
		style?.prompt,
		styleSeen.length > 0 &&
			`in the style of ${styleSeen.length === 1 ? "picture" : "pictures"} ${numbers(styleSeen)}`,
	].filter((w): w is string => Boolean(w) && !has(text, w as string));
	// The engine adds an installed LoRA's own trigger word when missing:
	// only a word the entry keeps instead of it is added here, and none for
	// a LoRA turned off.
	const triggers = theirs
		.filter(
			(l) =>
				l.weight !== 0 &&
				l.trigger &&
				l.trigger.toLowerCase() !==
					(loras.get(l.id)?.trigger ?? "").toLowerCase(),
		)
		.map((l) => l.trigger as string)
		.filter((t, i, all) => all.indexOf(t) === i && !has(text, t));

	return {
		...params,
		prompt: [...triggers, text, ...words].join(", "),
		referenceAssetIds: references,
		loras: joined.length > 0 ? joined : params.loras,
		seed: params.seed ?? character?.seed ?? style?.seed ?? undefined,
		aspectRatio:
			params.aspectRatio ??
			style?.aspectRatio ??
			character?.aspectRatio ??
			undefined,
		library: {
			prompt: params.library?.prompt ?? params.prompt,
			...(character && { character: character.name }),
			...(style && { style: style.name }),
		},
	};
}
