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
	| "loading"
	| "generating";
export type Operation = "generate" | "edit";

/** Who an operation runs for. Local installs use a single fixed user. */
export interface UserContext {
	userId: string;
}

export const LOCAL_USER: UserContext = { userId: "local" };

/** How much a redrawn picture changes when nobody said. */
export const DEFAULT_STRENGTH = 0.7;
/**
 * The same for a marked part: less leaves what was asked for out, and more
 * tends to grow a second subject inside the mark.
 */
export const DEFAULT_MASK_STRENGTH = 0.85;

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
}

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
	pricing?: { usdPerOutput?: number; usdPerSecond?: number };
	/** Absent for models the project has not described yet. */
	profile?: ModelProfile;
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
}

export type GalleryItem = Asset;

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
	hasKey: boolean;
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
	/** Zip archives, extracted together into the build's folder. */
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
	  };

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
