import type {
	Media,
	ModelRank,
	ModelSpec,
	PromptKind,
	Ranking,
	TurnView,
} from "./types";

/** Below this many comparisons, a model's win rate says little. */
export const MIN_COMPARISONS = 5;

/**
 * Words that tell a kind of prompt, in English and Portuguese, written as
 * `normalize` leaves them: lower case, without accents, hyphens as spaces.
 * A trailing "s" is matched too, for plurals.
 */
const KIND_WORDS: Record<Exclude<PromptKind, "editing">, string[]> = {
	portrait: [
		"portrait",
		"headshot",
		"selfie",
		"face",
		"close up",
		"closeup",
		"retrato",
		"rosto",
	],
	landscape: [
		"landscape",
		"scenery",
		"mountain",
		"valley",
		"forest",
		"beach",
		"ocean",
		"sunset",
		"sunrise",
		"desert",
		"lake",
		"paisagem",
		"paisagens",
		"montanha",
		"floresta",
		"praia",
		"oceano",
		"por do sol",
		"deserto",
		"lago",
	],
	text: [
		"text",
		"lettering",
		"typography",
		"logo",
		"sign",
		"poster",
		"caption",
		"headline",
		"that says",
		"texto",
		"letreiro",
		"placa",
		"tipografia",
		"logotipo",
		"cartaz",
		"escrito",
		"que diz",
	],
	product: [
		"product",
		"packshot",
		"packaging",
		"bottle",
		"e commerce",
		"ecommerce",
		"produto",
		"embalagem",
		"garrafa",
	],
	illustration: [
		"anime",
		"cartoon",
		"illustration",
		"drawing",
		"watercolor",
		"comic",
		"pixel art",
		"chibi",
		"ilustracao",
		"ilustracoes",
		"desenho",
		"aquarela",
		"quadrinho",
	],
	photo: [
		"photo",
		"photograph",
		"photorealistic",
		"realistic",
		"dslr",
		"35mm",
		"50mm",
		"foto",
		"fotografia",
		"fotorrealista",
		"realista",
	],
};

const KIND_PATTERNS = Object.entries(KIND_WORDS).map(
	([kind, words]) =>
		[
			kind as PromptKind,
			new RegExp(`(?:^| )(?:${words.join("|")})s?(?= |$)`),
		] as const,
);

/** Lower case, without accents, words apart by single spaces. */
function normalize(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * The kinds a prompt is of, by its words; `references` pictures given make
 * it editing. Words in quotes are words to write in the picture.
 */
export function promptKinds(prompt: string, references = 0): PromptKind[] {
	const words = normalize(prompt);
	const kinds = KIND_PATTERNS.filter(([, pattern]) => pattern.test(words)).map(
		([kind]) => kind,
	);
	if (!kinds.includes("text") && /["“”«»][^"“”«»]+["“”«»]/.test(prompt)) {
		kinds.push("text");
	}
	if (references > 0) kinds.push("editing");
	return kinds;
}

export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = values.toSorted((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[middle] as number)
		: ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * The lower bound of the 95% Wilson interval of `wins` in `n`: a win rate
 * that is cautious when there is little to go on.
 */
export function wilsonLowerBound(wins: number, n: number): number {
	if (n === 0) return 0;
	const z = 1.96;
	const p = wins / n;
	const z2 = z * z;
	return (
		(p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) /
		(1 + z2 / n)
	);
}

/** A turn the person picked a best result of, and the model that made it. */
export interface PickedTurn {
	turn: TurnView;
	assetId: string;
	modelId: string;
}

export interface RankOptions {
	media?: Media;
	kind?: PromptKind;
	model(id: string): ModelSpec | undefined;
}

/**
 * Ranks the models of a person's comparisons: turns with a pick where two
 * models or more made something. Times and costs are those of the same
 * comparisons, so every model is measured on the same prompts.
 */
export function rankModels(
	picked: PickedTurn[],
	options: RankOptions,
): Ranking {
	interface Tally {
		modelId: string;
		media: Media;
		comparisons: number;
		wins: number;
		ms: number[];
		usd: number[];
		example: { assetId: string; at: number } | null;
	}
	const tallies = new Map<string, Tally>();
	let comparisons = 0;
	for (const { turn, assetId, modelId } of picked) {
		const made = turn.jobs.filter((job) => job.status === "succeeded");
		const models = new Set(made.map((job) => job.modelId));
		if (models.size < 2 || !models.has(modelId)) continue;
		if (
			options.kind &&
			!promptKinds(turn.prompt, turn.referenceAssetIds.length).includes(
				options.kind,
			)
		) {
			continue;
		}
		const mediaOf = (job: (typeof made)[number]): Media =>
			options.model(job.modelId)?.media ??
			(job.assets[0]?.mime.startsWith("video/") ? "video" : "image");
		if (options.media && made.some((job) => mediaOf(job) !== options.media)) {
			continue;
		}
		comparisons++;
		for (const job of made) {
			let tally = tallies.get(job.modelId);
			if (!tally) {
				tally = {
					modelId: job.modelId,
					media: mediaOf(job),
					comparisons: 0,
					wins: 0,
					ms: [],
					usd: [],
					example: null,
				};
				tallies.set(job.modelId, tally);
			}
			tally.comparisons++;
			const outputs = Math.max(1, job.params.count);
			if (job.startedAt != null && job.finishedAt != null) {
				tally.ms.push((job.finishedAt - job.startedAt) / outputs);
			}
			const usd = job.costUsd ?? (job.providerId === "local" ? 0 : null);
			if (usd != null) tally.usd.push(usd / outputs);
			if (job.modelId === modelId) {
				tally.wins++;
				if (!tally.example || turn.createdAt > tally.example.at) {
					tally.example = { assetId, at: turn.createdAt };
				}
			}
		}
	}
	const models: ModelRank[] = [...tallies.values()].map((tally) => ({
		modelId: tally.modelId,
		name: options.model(tally.modelId)?.name ?? tally.modelId,
		media: tally.media,
		comparisons: tally.comparisons,
		wins: tally.wins,
		winRate: tally.wins / tally.comparisons,
		score: wilsonLowerBound(tally.wins, tally.comparisons),
		few: tally.comparisons < MIN_COMPARISONS,
		msPerOutput: median(tally.ms),
		usdPerOutput: median(tally.usd),
		exampleAssetId: tally.example?.assetId ?? null,
	}));
	models.sort(
		(a, b) =>
			b.score - a.score ||
			b.wins - a.wins ||
			a.name.localeCompare(b.name, "en"),
	);
	return { models, comparisons, minComparisons: MIN_COMPARISONS };
}
