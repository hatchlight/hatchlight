import { z } from "zod";
import type { ErrorParams } from "./errors";

export type Media = "image" | "video";

/** Where a job is, in words every provider can say the same way. */
export type ProgressStage =
	| "queued"
	| "retrying"
	| "translating"
	| "waitingGpu"
	| "starting"
	| "lowMemory"
	| "loading"
	| "generating";
export type Operation = "generate" | "edit";

/** Who an operation runs for. Local installs use a single fixed user. */
export interface UserContext {
	userId: string;
	/**
	 * The API token asking, by its `ref`, when a program asks: what it starts
	 * is held to the token's scopes and spending limit.
	 */
	tokenId?: string | null;
}

export const LOCAL_USER: UserContext = { userId: "local" };

/** What was paid for: pictures and videos, or text from a language model. */
export type SpendingKind = "generation" | "language";

/** What a person may do on a server: everything, run it, or use it. */
export const USER_ROLES = ["owner", "admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** A person's account on a server, as the interface sees it. */
export interface AccountView {
	id: string;
	username: string;
	displayName: string;
	role: UserRole;
	/** May spend on paid models with the server's keys. */
	canUsePaid: boolean;
	/** May train LoRAs and add them. */
	canTrain: boolean;
	/** Most they may spend in a month, in dollars; null for no limit. */
	monthlyLimitUsd: number | null;
	/** Signs in with a code from an authenticator app too. */
	totp: boolean;
	/** Signed in with a temporary password, which must be changed first. */
	mustChangePassword: boolean;
	disabled: boolean;
	createdAt: number;
	/** The last time a reset link set the password, and who gave the link. */
	lastReset: { by: string; at: number } | null;
	/**
	 * Set on one's own account until dismissed: the password was reset with
	 * a link someone else gave.
	 */
	resetNotice: { by: string; at: number } | null;
	/** What their pictures and videos take, and the most they may (null: no limit). */
	storage: { usedBytes: number; quotaBytes: number | null };
}

/**
 * What an API token may do, on top of what its person may:
 *
 * - `read`: see models, sessions, the gallery and pictures;
 * - `generate`: make, upload and delete pictures and videos;
 * - `paid`: use paid models, for a person allowed to;
 * - `train`: train LoRAs and add them, for a person allowed to.
 */
export const TOKEN_SCOPES = ["read", "generate", "paid", "train"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** How long a new token lasts, in days; null for until revoked. */
export const TOKEN_EXPIRY_DAYS = [30, 90, 365, null] as const;
export type TokenExpiryDays = (typeof TOKEN_EXPIRY_DAYS)[number];

/** What API tokens begin with, so secret scanners can tell them. */
export const TOKEN_PREFIX = "hl_";

/** An API token as lists show it: never the token itself. */
export interface ApiTokenView {
	id: string;
	name: string;
	scopes: TokenScope[];
	/** The most it may spend on paid models, in dollars; null for no limit. */
	spendLimitUsd: number | null;
	/** What it has spent on paid models, in dollars. */
	spentUsd: number;
	createdAt: number;
	lastUsedAt: number | null;
	/** Null for a token that lasts until revoked. */
	expiresAt: number | null;
}

/** A browser someone is signed in on. */
export interface AuthSessionView {
	id: string;
	createdAt: number;
	lastSeenAt: number;
	userAgent: string | null;
	ip: string | null;
	/** The browser asking. */
	current: boolean;
}

/** A link that lets someone make an account. */
export interface InviteView {
	id: string;
	role: UserRole;
	canUsePaid: boolean;
	canTrain: boolean;
	monthlyLimitUsd: number | null;
	expiresAt: number;
	createdAt: number;
	usedAt: number | null;
}

/** How much a redrawn picture changes when nobody said. */
export const DEFAULT_STRENGTH = 0.7;
/**
 * The same for a marked part: less leaves what was asked for out, and more
 * tends to grow a second subject inside the mark.
 */
export const DEFAULT_MASK_STRENGTH = 0.85;

/**
 * What a guide picture shows for a new picture to follow: its outlines, the
 * pose of a person (a skeleton), or how far each part is (a depth map).
 */
export const GUIDE_KINDS = ["outlines", "pose", "depth"] as const;
export type GuideKind = (typeof GUIDE_KINDS)[number];

/** How a model follows a guide picture. */
export interface GuideSupport {
	/** The kinds of guide it follows. */
	kinds: GuideKind[];
	/**
	 * The kinds whose map it makes itself from any picture; the others need
	 * a picture that already is the map, e.g. a pose skeleton.
	 */
	makesMaps: GuideKind[];
	/** How closely it follows the guide unasked, 0 to 1. */
	strength: number;
}

/** Whether a model with `guide` can follow a guide of this kind, as given. */
export function followsGuide(
	guide: GuideSupport | undefined,
	asked: { kind: GuideKind; ready: boolean },
): boolean {
	if (!guide?.kinds.includes(asked.kind)) return false;
	return asked.ready || guide.makesMaps.includes(asked.kind);
}

/** A LoRA's id: also its file's name, and safe inside `<lora:id:1>`. */
export const LORA_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** LoRAs one picture can use at once: each costs memory and time. */
export const MAX_LORAS = 4;

/**
 * The family of models a LoRA was trained on; it works only with those.
 * `sd1` is Stable Diffusion 1.x, `sdxl` SDXL and its turbo and fine-tunes.
 */
export const LORA_BASES = ["sd1", "sdxl", "flux", "wan", "z-image"] as const;
export type LoraBase = (typeof LORA_BASES)[number];

/** A LoRA kept in the models folder. */
export interface LoraInfo {
	/** Also its file's name, and how prompts name it: `<lora:id:1>`. */
	id: string;
	name: string;
	base: LoraBase;
	/** The word its trainer put in every caption, which calls it up. */
	trigger: string | null;
	size: number;
	addedAt: number;
	/** Set when the file is in another app's folder, used where it is. */
	linked?: LinkedFrom;
}

/** What a library entry keeps: a character to draw again, or a style. */
export const LIBRARY_KINDS = ["character", "style"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/** Pictures one library entry keeps, as models follow only a few. */
export const MAX_LIBRARY_PICTURES = 4;

export const libraryInputSchema = z.object({
	kind: z.enum(LIBRARY_KINDS),
	name: z
		.string()
		.trim()
		.min(1)
		.max(60)
		// Plain names: tools and prompts write them as `<style:name>`.
		.regex(/^[^<>:]+$/, "A name cannot have <, > or :"),
	/** Pictures of the character, or in the style, by asset id. */
	pictureIds: z.array(z.string()).max(MAX_LIBRARY_PICTURES).default([]),
	loras: z
		.array(
			z.object({
				id: z.string().regex(LORA_ID),
				weight: z.number().min(-2).max(2).default(1),
				/** The word that calls the LoRA up, added to prompts without it. */
				trigger: z.string().trim().max(60).nullable().default(null),
			}),
		)
		.max(MAX_LORAS)
		.default([]),
	/**
	 * Words added to every prompt: what the character looks like, or the
	 * style's own words.
	 */
	prompt: z.string().trim().max(1000).nullable().default(null),
	/** The person's own notes; never sent to a model. */
	notes: z.string().trim().max(1000).nullable().default(null),
	seed: z.number().int().nonnegative().nullable().default(null),
	aspectRatio: z
		.string()
		.regex(/^\d+:\d+$/)
		.nullable()
		.default(null),
	/** The model used when none is chosen. */
	modelId: z.string().nullable().default(null),
});
export type LibraryInput = z.input<typeof libraryInputSchema>;

/** A character or a style a person keeps, to use again by name. */
export type LibraryEntry = z.infer<typeof libraryInputSchema> & {
	id: string;
	createdAt: number;
	updatedAt: number;
};

/** The families of single-file models that can be added by hand. */
export const CHECKPOINT_BASES = ["sd1", "sdxl"] as const;
export type CheckpointBase = (typeof CHECKPOINT_BASES)[number];

/**
 * A whole model in one file, added by hand: a community fine-tune of a
 * family Hatchlight runs. It is offered as `local/ckpt-<id>`.
 */
export interface CheckpointInfo {
	id: string;
	name: string;
	base: CheckpointBase;
	/** How it is run; fine-tunes often want other values than their family. */
	steps: number;
	cfgScale: number;
	/** Text encoder layers to skip at the end; 2 for Pony and anime models. */
	clipSkip: number | null;
	size: number;
	addedAt: number;
	/** Set when the file is in another app's folder, used where it is. */
	linked?: LinkedFrom;
}

/** Apps whose models folders Hatchlight knows how to read. */
export const MODEL_FOLDER_APPS = [
	"comfyui",
	"a1111",
	"stabilityMatrix",
] as const;
/** `a1111` stands for AUTOMATIC1111 and Forge, which share a layout. */
export type ModelFolderApp = (typeof MODEL_FOLDER_APPS)[number];

/** Where a model found in another app's folder comes from. */
export interface LinkedFrom {
	/** The linked folder's id. */
	folder: string;
	/** The app whose layout the folder has; null for a plain folder. */
	app: ModelFolderApp | null;
}

/**
 * A folder of another app (ComfyUI, AUTOMATIC1111, Forge, Stability
 * Matrix) whose checkpoints and LoRAs Hatchlight uses where they are.
 */
export interface ModelFolder {
	id: string;
	/** Left out for people who may not change the folders, on a server. */
	path?: string;
	/** The layout found; null when the folder was read as a plain folder. */
	app: ModelFolderApp | null;
	/** False when the folder was not there at the last look (a drive unplugged). */
	available: boolean;
	checkpoints: number;
	loras: number;
	/** Files that are not used, by why. */
	skipped: {
		/** A family or kind of file Hatchlight does not run. */
		unknown: number;
		/** Not a safetensors file that can be read. */
		unreadable: number;
		tooLarge: number;
	};
	/** More files than are looked at: the rest were left out. */
	truncated: boolean;
	addedAt: number;
	scannedAt: number | null;
}

/** An install of another app found on this computer, not linked yet. */
export interface ModelFolderSuggestion {
	path: string;
	app: ModelFolderApp;
}

/** Where the LoRA trainer is: not installed, being installed, or ready. */
export type TrainerState = "missing" | "installing" | "ready";

/** What an install of the trainer is doing. */
export type TrainerInstallStep =
	| "uv"
	| "scripts"
	| "python"
	| "packages"
	| "checking";

/** What a training is doing, in words every platform says the same way. */
export type TrainingStage =
	| "waitingGpu"
	| "loading"
	| "caching"
	| "training"
	| "saving";

/** A LoRA being trained, or the last one that was. */
export interface TrainingView {
	id: string;
	name: string;
	trigger: string;
	/** Who started it, on a server; null on a personal install. */
	startedBy: { userId: string; name: string } | null;
	state: "running" | "done" | "failed" | "canceled";
	stage: TrainingStage;
	step: number;
	steps: number;
	/** At the pace so far; null until the steps have started. */
	secondsLeft: number | null;
	startedAt: number;
	finishedAt: number | null;
	/** System memory still free, watched so training never freezes the computer. */
	freeMemoryBytes: number | null;
	/** The LoRA it made, on the shelf. */
	loraId: string | null;
	/**
	 * Pictures the LoRA made along the way, the latest last, each named by
	 * the step it was made at: they show whether it is learning.
	 */
	samples: number[];
	/** The latest step whose LoRA is saved: training can stop there and keep it. */
	savedStep: number | null;
	/** The step it was stopped at to keep what it had learned, if it was. */
	keptStep: number | null;
	error: {
		message: string;
		code: string | null;
		params: ErrorParams | null;
	} | null;
}

export interface TrainerStatus {
	state: TrainerState;
	install: {
		step: TrainerInstallStep;
		/** Bytes of the current download, when the step is one. */
		receivedBytes: number | null;
		totalBytes: number | null;
	} | null;
	/** Why the last install failed, until the next one. */
	error: {
		message: string;
		code: string | null;
		params: ErrorParams | null;
	} | null;
	/** About what an install downloads, to tell people before they start. */
	downloadBytes: number;
	training: TrainingView | null;
}

/** The trainer changed: an install moved on, or a training did. */
export interface TrainerEvent {
	type: "trainer.changed";
	trainer: TrainerStatus;
}

export const generationParamsSchema = z.object({
	prompt: z.string().trim().min(1),
	aspectRatio: z
		.string()
		.regex(/^\d+:\d+$/)
		.optional(),
	seed: z.number().int().nonnegative().optional(),
	count: z.number().int().min(1).max(8).default(1),
	/** Length of a video. Ignored by image models. */
	durationSeconds: z.number().int().min(1).max(120).optional(),
	referenceAssetIds: z.array(z.string()).default([]),
	/**
	 * How much a model that redraws a reference picture changes it: near 0
	 * keeps it, 1 keeps only its colors and layout. Ignored by other models.
	 */
	strength: z.number().min(0.05).max(1).optional(),
	/**
	 * A picture the size of the reference marking what to redraw: white is
	 * redrawn, black is kept. Only for models that take a mask.
	 */
	maskAssetId: z.string().optional(),
	/**
	 * A picture whose outlines, pose or depth the new picture follows. Only
	 * for models that take a guide.
	 */
	guide: z
		.object({
			assetId: z.string(),
			kind: z.enum(GUIDE_KINDS),
			/** The picture already is the map (edges, a skeleton, depth). */
			ready: z.boolean().default(false),
			/** How closely it is followed, 0 to 1; unasked, the model's own. */
			strength: z.number().min(0).max(1).optional(),
		})
		.optional(),
	/**
	 * LoRAs to add to the model, each with how strongly: 1 as trained, less
	 * to soften it. Only for models that take LoRAs of their family.
	 */
	loras: z
		.array(
			z.object({
				id: z.string().regex(LORA_ID),
				weight: z.number().min(-2).max(2).default(1),
			}),
		)
		// Each model takes at most MAX_LORAS of its own family.
		.max(MAX_LORAS * LORA_BASES.length)
		.optional(),
	/**
	 * A character and a style from the person's library, by id: their
	 * pictures, LoRAs, words and settings are added to these.
	 */
	characterId: z.string().optional(),
	styleId: z.string().optional(),
	/** Model-specific parameters, passed through to the provider untouched. */
	extras: z.record(z.string(), z.unknown()).default({}),
});

export type GenerationParams = z.infer<typeof generationParamsSchema> & {
	/**
	 * The prompt as sent, in English, when the model reads only English and
	 * the prompt was in another language. Set by Hatchlight, never asked for:
	 * `prompt` stays as written.
	 */
	translatedPrompt?: string;
	/**
	 * Set by Hatchlight when a character or style was used: the prompt as
	 * written, before their words were added, and their names then.
	 */
	library?: { prompt: string; character?: string; style?: string };
};
export type GenerationParamsInput = z.input<typeof generationParamsSchema>;

export interface ModelCapabilities {
	/** Supported ratios such as "16:9". Empty means the model has no ratio control. */
	aspectRatios: string[];
	seed: boolean;
	maxCount: number;
	/** 0 means the model cannot take reference images. */
	maxReferenceImages: number;
	/**
	 * Set when the model redraws its reference picture, by `strength`,
	 * instead of following it as an example: the strength it uses unasked.
	 */
	strength?: number;
	/**
	 * Set when the model can redraw only part of its reference, marked by a
	 * mask: the strength it uses there unasked.
	 */
	mask?: number;
	/**
	 * Set for a model that only makes its reference larger and sharper: how
	 * many times. It takes no words, and makes nothing from words alone.
	 */
	upscale?: number;
	/**
	 * Video lengths in seconds the model can produce, ascending. Absent or empty
	 * means the length cannot be chosen.
	 */
	durations?: number[];
	/**
	 * Set when the model reads prompts well only in English (its text
	 * encoder is CLIP or T5): a prompt in another language is translated
	 * before it is sent.
	 */
	englishPrompts?: boolean;
	/** Set for a model that takes LoRAs: the family they must be for. */
	loraBase?: LoraBase;
	/** Set for a model that follows a guide picture. */
	guide?: GuideSupport;
	/**
	 * Set for a model that makes nothing from words alone: it needs a
	 * reference, e.g. the person to keep in a new picture.
	 */
	needsReference?: boolean;
}

/** What a model is good at, shown as tags; the interface translates each. */
export type BestFor =
	| "speed"
	| "drafts"
	| "photo"
	| "text"
	| "illustration"
	| "editing"
	| "instructions"
	| "detail"
	| "motion"
	| "cinema"
	| "sound";

/**
 * How a model compares with others, so people can choose without knowing
 * model names. Curated by the project, not reported by providers.
 */
export interface ModelProfile {
	/**
	 * The same model reached through different services shares a family, so
	 * it is shown once, e.g. Nano Banana through Google, fal and OpenRouter.
	 */
	family: string;
	/** The family's name as people know it. */
	name: string;
	/** Who made the model. */
	author: string;
	/** 1 slow to 3 fast, relative to other models of the same media. */
	speed: 1 | 2 | 3;
	/** 1 basic to 3 best, relative to other models of the same media. */
	quality: 1 | 2 | 3;
	/** Writes legible words inside pictures. */
	text: boolean;
	bestFor: BestFor[];
	/**
	 * A picture of the shared comparison prompt made with this model, by its
	 * file name among the interface's samples.
	 */
	sample?: string;
}

export interface ModelSpec {
	/** Globally unique: `${providerId}/${providerModelId}`. */
	id: string;
	providerId: string;
	providerModelId: string;
	name: string;
	media: Media;
	operations: Operation[];
	capabilities: ModelCapabilities;
	/** Used to estimate a job's cost when the provider does not report one. */
	pricing?: {
		usdPerOutput?: number;
		usdPerSecond?: number;
		/** Per picture when following a guide, when that costs otherwise. */
		usdPerGuidedOutput?: number;
	};
	/** Absent for models the project has not described yet. */
	profile?: ModelProfile;
	/** Set for a model found in another app's folder. */
	linked?: LinkedFrom;
}

export type JobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "canceled";

export const TERMINAL_STATUSES: readonly JobStatus[] = [
	"succeeded",
	"failed",
	"canceled",
];

export interface Session {
	id: string;
	userId: string;
	title: string;
	createdAt: number;
	updatedAt: number;
}

export interface Turn {
	id: string;
	sessionId: string;
	userId: string;
	prompt: string;
	referenceAssetIds: string[];
	createdAt: number;
}

export interface Job {
	id: string;
	turnId: string;
	/** Order within the turn, matching the order the models were chosen in. */
	position: number;
	userId: string;
	providerId: string;
	modelId: string;
	/** The parameters actually sent, after adapting to the model's capabilities. */
	params: GenerationParams;
	status: JobStatus;
	/** Provider-side reference used to re-attach after a restart. */
	handle: unknown | null;
	error: string | null;
	/** Lets the interface say `error` in the reader's language. */
	errorCode: string | null;
	errorParams: ErrorParams | null;
	costUsd: number | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	/** The API token that asked for it, by its `ref`; held to its limits. */
	tokenId?: string | null;
}

export type AssetKind = "output" | "upload";

export interface Asset {
	id: string;
	userId: string;
	kind: AssetKind;
	/** Null for uploads, and for outputs whose session was deleted. */
	jobId: string | null;
	hash: string;
	mime: string;
	size: number;
	/** What produced an output. Stored here so it outlives the session. */
	prompt: string | null;
	modelId: string | null;
	params: GenerationParams | null;
	createdAt: number;
}

export interface JobView extends Job {
	assets: Asset[];
}

export interface TurnView extends Turn {
	jobs: JobView[];
	/** The result the person chose as the best of the comparison, if any. */
	pickedAssetId?: string | null;
}

/**
 * Kinds of prompt a ranking can be narrowed to, told by words in the prompt
 * (and editing by the pictures given). A prompt may be of several kinds.
 */
export const PROMPT_KINDS = [
	"portrait",
	"landscape",
	"text",
	"product",
	"illustration",
	"photo",
	"editing",
] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

export const RANKING_PERIODS = ["30d", "all"] as const;
export type RankingPeriod = (typeof RANKING_PERIODS)[number];

export interface RankingQuery {
	media?: Media;
	/** Unset, all time. */
	period?: RankingPeriod;
	/** Unset, every kind of prompt. */
	kind?: PromptKind;
}

/** How one model fared in a person's comparisons on this computer. */
export interface ModelRank {
	modelId: string;
	name: string;
	media: Media;
	/** Comparisons it was in that the person picked a best of. */
	comparisons: number;
	/** Of those, how many it won. */
	wins: number;
	winRate: number;
	/**
	 * What the list is sorted by: the lower bound of the win rate's 95%
	 * Wilson interval, so 1 win of 1 does not top 8 of 10.
	 */
	score: number;
	/** Too few comparisons to say much. */
	few: boolean;
	/** Median time per picture or video, or null when none was timed. */
	msPerOutput: number | null;
	/** Median cost per picture or video: 0 when free, null when unknown. */
	usdPerOutput: number | null;
	/** The latest picture it won with, to show as an example. */
	exampleAssetId: string | null;
}

export interface Ranking {
	models: ModelRank[];
	/** Comparisons counted, with a pick. */
	comparisons: number;
	/** Below this many comparisons a model is marked `few`. */
	minComparisons: number;
}

/** At most this many pictures show what a character must look like. */
export const MAX_CHARACTER_REFERENCES = 3;
/** The longest description of a character's traits a check takes. */
export const MAX_TRAITS_LENGTH = 500;
/** From this score up, a picture shows the character well enough. */
export const CONSISTENT_SCORE = 70;

/** Whether a picture shows the same character as its references. */
export interface ConsistencyCheck {
	/** The picture to check. */
	assetId: string;
	/** One to three pictures of the character as it must look. */
	referenceAssetIds: string[];
	/** What must stay the same, in words, such as "green coat, red scarf". */
	traits?: string;
	/** The language to write the differences in, such as "pt-BR". */
	language?: string;
}

export const CONSISTENCY_VERDICTS = ["same", "close", "different"] as const;
export type ConsistencyVerdict = (typeof CONSISTENCY_VERDICTS)[number];

export interface ConsistencyResult {
	/** 0 to 100: how much the character looks like its references. */
	score: number;
	/** What is off, each in a few words: "coat is blue, should be green". */
	differences: string[];
	verdict: ConsistencyVerdict;
}

export type GalleryItem = Asset & {
	/**
	 * Made in a comparison of models whose best result is not picked yet:
	 * its model is not shown while the person hides names until a pick.
	 */
	unpicked?: boolean;
	/** The session that made it, while that session is kept. */
	sessionId?: string | null;
};

export interface CreateTurnInput extends GenerationParamsInput {
	/** Omit to start a new session. */
	sessionId?: string;
	/** One job is created per model; more than one makes a comparison. */
	modelIds: string[];
}

export interface ProviderStatus {
	id: string;
	name: string;
	requiresKey: boolean;
	/** A key the person can use now. */
	hasKey: boolean;
	/** On a server: whether the person has a key of their own, and the server one. */
	keys?: { personal: boolean; server: boolean };
}

export type EngineEvent =
	| { type: "job.updated"; job: JobView }
	| {
			type: "job.progress";
			jobId: string;
			fraction?: number;
			message?: string;
			stage?: ProgressStage;
			position?: number;
			step?: number;
			steps?: number;
			/** Graphics memory other programs hold, when it is too little. */
			busyBytes?: number;
			/**
			 * Counts the pictures shown while generating; the latest is fetched
			 * from the job's preview, so events stay small.
			 */
			preview?: number;
	  };

export type GpuVendor = "nvidia" | "amd" | "apple" | "intel";

export interface Gpu {
	vendor: GpuVendor;
	name: string;
	/** Memory the GPU can use. On Apple silicon it shares the system's. */
	memoryBytes: number;
	/** Memory not held by any program right now, when the driver says. */
	freeBytes?: number;
	/** The NVIDIA driver version, which decides the CUDA versions it runs. */
	driver?: string;
}

export interface Hardware {
	os: "linux" | "darwin" | "win32" | "other";
	arch: "x64" | "arm64" | "other";
	/** Linux under Windows: the GPU is reached through the Windows driver. */
	wsl: boolean;
	memoryBytes: number;
	gpus: Gpu[];
}

/** How an engine reaches the hardware. */
export type Backend = "cuda" | "rocm" | "metal" | "vulkan" | "cpu";

/** How well a variant of a model runs on this machine. */
export type Fit =
	/** On the GPU, at full speed. */
	| "gpu"
	/** On the GPU, moving weights in from system memory: slower. */
	| "offload"
	/** On the CPU: much slower. */
	| "cpu"
	/** Not at all: it does not fit in this machine's memory. */
	| "none";

/** A file to download, checked by its hash after downloading. */
export interface LocalModelFile {
	/** The name the file is known by, unique within its variant or build. */
	name: string;
	/** Where to download it from. Pinned to a revision, so it never changes. */
	url: string;
	size: number;
	/** Files with the same hash are stored once. */
	sha256: string;
	/** What the engine uses it for, e.g. "vae". */
	role?: string;
}

/** What is needed to pick a build for a machine. */
export interface EngineBuildSpec {
	id: string;
	engine: string;
	backend: Backend;
	os: "linux" | "darwin" | "win32";
	arch: "x64" | "arm64";
	/** The oldest NVIDIA driver it runs on, as `major.minor`. */
	minNvidiaDriver?: string;
}

/** One downloadable build of an engine, for one platform and backend. */
export interface EngineBuild extends EngineBuildSpec {
	version: string;
	/** Zip or tar.gz archives, extracted together into the build's folder. */
	files: LocalModelFile[];
	/** The program to run, relative to the build's folder. */
	executable: string;
}

/** A program that runs local models. */
export interface LocalEngineSpec {
	id: string;
	name: string;
	homepage: string;
	license: string;
	builds: EngineBuild[];
}

/** What is needed to pick a variant for a machine. */
export interface VariantSpec {
	id: string;
	/** What sets it apart, e.g. "4-bit". */
	label: string;
	engine: string;
	/** GPU memory to run at full speed, without offloading. */
	memoryBytes: number;
}

/** One way to run a model: its weights at one precision, for one engine. */
export interface LocalModelVariant extends VariantSpec {
	files: LocalModelFile[];
}

/** A sample of what a model produces, published by its authors. */
export interface LocalModelDemo {
	url: string;
	media: Media;
	caption?: string;
}

/** How a local model is run when the request does not say otherwise. */
export interface LocalModelDefaults {
	/** The longer side of the output, in pixels; the other follows the ratio. */
	size: number;
	aspectRatios: string[];
	steps: number;
	cfgScale: number;
	sampler?: string;
	/** Tells the model what to avoid; some models are trained to expect one. */
	negativePrompt?: string;
	/** Shift of the noise schedule, for flow models such as Wan. */
	flowShift?: number;
	/** Video models: frames per second, and the lengths they can make. */
	fps?: number;
	durations?: number[];
	/**
	 * How the model takes pictures: as references to follow (`ref`, for
	 * editing models) or as a picture to start from (`init`: the first frame
	 * of image-to-video, the picture image-to-image redraws). Absent when it
	 * only works from words.
	 */
	references?: { as: "ref" | "init"; max: number };
	/** More engine options this model needs, e.g. `["--diffusion-fa"]`. */
	engineArgs?: string[];
	/**
	 * Runs the model in pieces that fit a share of the GPU's memory. Without
	 * a budget the engine puts all of the model on the GPU and, when the rest
	 * of the job does not fit beside it, makes no picture (ERNIE-Image at its
	 * full size on a 12 GB card).
	 */
	vramBudget?: boolean;
	/**
	 * False when showing the picture as it forms does not fit in memory
	 * while the model follows a picture.
	 */
	previewsWhileFollowing?: boolean;
	/** Upscalers: how many times larger the picture comes out. */
	upscale?: number;
	/**
	 * Set for a model that follows a guide picture, through a file with the
	 * `control_net` role.
	 */
	guide?: GuideSupport;
}

/** What a local model makes, and from what. */
export type LocalModelTask =
	/** A picture from words. */
	| "text-to-image"
	/** A changed picture, from a picture and words. */
	| "image-edit"
	/** A picture redrawn from another, as much as asked, and words. */
	| "image-to-image"
	/** A picture made larger and sharper, without words. */
	| "upscale"
	/** A video from words. */
	| "text-to-video"
	/** A video that starts from a picture. */
	| "image-to-video"
	/** A prompt put into English, for the models that read only English. */
	| "prompt-translation"
	/** Words about a picture, for an assistant that cannot see. */
	| "picture-description";

/** What a model's license allows, in the terms people choose by. */
export type CommercialUse =
	/** Any use, paid work included. */
	| { kind: "allowed" }
	/** Paid work only below an annual revenue, in US dollars. */
	| { kind: "limited"; revenueUsd: number }
	/** Personal and research use only. */
	| { kind: "none" };

/** A model that can be downloaded and kept on this machine. */
export interface LocalModelSpec {
	id: string;
	name: string;
	author: string;
	/**
	 * What it makes. A text model helps the others (it puts prompts into
	 * English) and is not offered for generating.
	 */
	media: Media | "text";
	/** What it does, the first being what it is mainly for. */
	tasks: LocalModelTask[];
	summary: string;
	/** The license's name, e.g. "Apache 2.0". */
	license: string;
	/** Where the license's full text is. */
	licenseUrl: string;
	commercial: CommercialUse;
	/** The model's page, for its full description and license terms. */
	homepage: string;
	/** Best quality first. */
	variants: LocalModelVariant[];
	demos: LocalModelDemo[];
	defaults: LocalModelDefaults;
	profile?: ModelProfile;
	/** Reads prompts well only in English; see `ModelCapabilities`. */
	englishPrompts?: boolean;
	/**
	 * Takes LoRAs of this family. Set only once a LoRA was seen working with
	 * the model on a real GPU.
	 */
	loraBase?: LoraBase;
	/** Set for a checkpoint found in another app's folder. */
	linked?: LinkedFrom;
}

export type LocalModelState =
	| "available"
	| "queued"
	| "downloading"
	| "verifying"
	| "installed";

export interface LocalVariantStatus extends VariantSpec {
	fit: Fit;
	/** What its files take on disk. */
	size: number;
	files: { name: string; size: number; present: boolean }[];
}

export interface LocalModelStatus
	extends Omit<LocalModelSpec, "variants" | "demos" | "defaults"> {
	state: LocalModelState;
	variants: LocalVariantStatus[];
	/**
	 * The variant installed, or being installed, or the one an install would
	 * pick for this machine. Null when no variant runs here.
	 */
	variant: string | null;
	/** Whether `variant` is installed, rather than proposed. */
	installed: boolean;
	/** Installed with its engine, so it can run. */
	ready: boolean;
	/** What installing `variant` downloads: its files and, if missing, its engine. */
	size: number;
	/** How much of `size` is on disk now, counting interrupted downloads. */
	receivedBytes: number;
	/** What deleting it frees: files other installed models use stay. */
	reclaimableBytes: number;
	/** Demos are fetched through the server, by their position in this list. */
	demos: Omit<LocalModelDemo, "url">[];
	/** Why the last install stopped, if it failed. */
	error?: string;
	/** Lets the interface say `error` in the reader's language. */
	errorCode?: string;
	errorParams?: ErrorParams;
}

/** The build of an engine this machine would run. */
export interface LocalEngineStatus {
	engine: string;
	name: string;
	build: string;
	version: string;
	backend: Backend;
	/** Run from WSL as a Windows program, to reach the GPU. */
	throughWindows: boolean;
	installed: boolean;
	/** What it takes to download. */
	size: number;
	/** Installed models that run on it. It is deleted with the last one. */
	usedBy: string[];
}

export interface LocalModelsView {
	hardware: Hardware;
	engines: LocalEngineStatus[];
	models: LocalModelStatus[];
	disk: {
		/** Where models and engines are stored. */
		path: string;
		freeBytes: number;
		/** Taken by models and engines, including interrupted downloads. */
		usedBytes: number;
		/** Whether another folder can be chosen (not when set from outside). */
		changeable: boolean;
		/** While the models move to another folder, how far that is. */
		moving: { to: string; movedBytes: number; totalBytes: number } | null;
		/** Why the last move failed; the models stayed where they were. */
		moveError: {
			message: string;
			code: string | null;
			params: ErrorParams | null;
		} | null;
	};
}

export type LocalModelEvent =
	/** A model was installed, deleted, or its install started or stopped. */
	| { type: "models.changed" }
	/** A LoRA was added or deleted. */
	| { type: "loras.changed" }
	/** The models are moving to another folder. */
	| {
			type: "models.moving";
			to: string;
			movedBytes: number;
			totalBytes: number;
	  }
	| {
			type: "model.progress";
			id: string;
			state: LocalModelState;
			receivedBytes: number;
			size: number;
			bytesPerSecond: number;
	  }
	/** A file from Hugging Face is being downloaded into the models. */
	| {
			type: "hub.progress";
			repo: string;
			file: string;
			receivedBytes: number;
			size: number;
	  }
	/** A file from Hugging Face was added to the checkpoints or LoRAs. */
	| { type: "hub.done"; repo: string; file: string; added: HubAdded }
	/** A download from Hugging Face failed; nothing of it was kept. */
	| {
			type: "hub.failed";
			repo: string;
			file: string;
			message: string;
			code: string | null;
			params: ErrorParams | null;
	  }
	/** A download from Hugging Face was stopped; nothing of it was kept. */
	| { type: "hub.canceled"; repo: string; file: string };

/** What a file downloaded from Hugging Face became. */
export type HubAdded =
	| { kind: "checkpoint"; item: CheckpointInfo }
	| { kind: "lora"; item: LoraInfo };

/**
 * What puts prompts into English for the models that read only English: the
 * model on this computer, a service reached with the person's key (it costs
 * a fraction of a cent per prompt), or nothing.
 */
export const TRANSLATE_WITH = [
	"local",
	"openai",
	"google",
	"openrouter",
	"off",
] as const;
export type TranslateWith = (typeof TRANSLATE_WITH)[number];

export function isTranslateWith(value: unknown): value is TranslateWith {
	return (TRANSLATE_WITH as readonly unknown[]).includes(value);
}

/**
 * What writes a fuller prompt from a short idea: "auto" takes the model on
 * this computer when it is installed (free), else the service chosen for
 * translation; or one of them, always.
 */
export const IMPROVE_WITH = [
	"auto",
	"local",
	"openai",
	"google",
	"openrouter",
] as const;
export type ImproveWith = (typeof IMPROVE_WITH)[number];

export function isImproveWith(value: unknown): value is ImproveWith {
	return (IMPROVE_WITH as readonly unknown[]).includes(value);
}

/** Choices a person makes that the server acts on. */
export interface Settings {
	translateWith: TranslateWith;
	improveWith: ImproveWith;
	/** What the assistant thinks with: same choices as improving. */
	assistantWith: ImproveWith;
	/**
	 * Whether other apps, through the OpenAI and AUTOMATIC1111 image APIs,
	 * may use paid models. Off, they use only free ones.
	 */
	otherAppsPaid: boolean;
	/**
	 * The model other apps get when they name none they can use, as chosen
	 * through the AUTOMATIC1111 API; null for the best one installed.
	 */
	otherAppsModel: string | null;
	/** Hide which model made which result of a comparison until one is picked. */
	blindPicks: boolean;
	/**
	 * The model on this computer that translates, improves prompts and
	 * thinks for the assistant; null for the first one installed.
	 */
	writerModel: string | null;
	/**
	 * The model on this computer that looks at pictures; null for the first
	 * one installed.
	 */
	eyesModel: string | null;
}

/**
 * Which model on this computer does a job: the one chosen while it is
 * installed, else the first candidate installed (the catalog's order), else
 * none. A chosen model that was deleted falls back, it does not stop the job.
 */
export function chooseLocalModel(
	candidates: readonly string[],
	chosen: string | null,
	ready: (id: string) => boolean,
): string | null {
	if (chosen && candidates.includes(chosen) && ready(chosen)) return chosen;
	return candidates.find(ready) ?? null;
}

/**
 * One entry of a session's conversation with the assistant. `message` is
 * what its language model sees; the rest is for the person.
 */
export interface AssistantEntryBody {
	message: import("./chat").ChatMessage;
	/** A tool call that made pictures: the turn they are in. */
	turnId?: string;
	/** A paid generation waiting for the person's yes. */
	confirm?: AssistantConfirm;
	/** A question to the person, with answers to pick from. */
	question?: AssistantQuestion;
	/** The assistant stopped on this; the code says it in the reader's language. */
	error?: { message: string; code: string | null };
	/** Something said to the person only, never to the language model. */
	note?: "stopped" | "tooManySteps";
}

export interface AssistantConfirm {
	/** The generate call to run on a yes. */
	arguments: Record<string, unknown>;
	modelNames: string[];
	usd: number;
	state: "asked" | "approved" | "declined";
}

/**
 * What the assistant asked before making a picture. The answer, picked or
 * written, comes as the person's next message.
 */
export interface AssistantQuestion {
	text: string;
	/** Short answers to pick from; the person may write another. */
	options: string[];
	state: "asked" | "answered";
}

export interface AssistantEntry extends AssistantEntryBody {
	id: string;
	sessionId: string;
	createdAt: number;
}

/** A session's conversation, and whether the assistant is working on it. */
export interface AssistantView {
	entries: AssistantEntry[];
	busy: boolean;
	/** The turn a tool is making now, to show it while it develops. */
	turnId: string | null;
	/** Spent on paid models in this conversation, and its limit. */
	spentUsd: number;
	limitUsd: number;
}
