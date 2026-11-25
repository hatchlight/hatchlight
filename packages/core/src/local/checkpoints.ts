import { ValidationError } from "../errors";
import {
	CHECKPOINT_BASES,
	type CheckpointBase,
	type CheckpointInfo,
} from "../types";
import { baseFromMetadata } from "./loras";
import {
	nameOf,
	type SafetensorsHeader,
	Shelf,
	type ShelfKind,
	type ShelfOptions,
} from "./shelf";

/**
 * A checkpoint is a whole model in one file: a community fine-tune of SDXL
 * or SD 1.5 that is good at one thing (a style, photos, anime). The engine
 * reads it as it reads the base model it was tuned from.
 */

/** SDXL in 32-bit is about 13 GB. */
export const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024 * 1024;

/** How each family is run unless the person sets otherwise. */
export const CHECKPOINT_DEFAULTS: Record<
	CheckpointBase,
	{ steps: number; cfgScale: number }
> = {
	sdxl: { steps: 30, cfgScale: 7 },
	sd1: { steps: 20, cfgScale: 7 },
};

/** How a distilled model (Lightning, Turbo, Hyper, LCM) is run. */
export const FEW_STEPS = { steps: 6, cfgScale: 2 };

/** The catalog model a checkpoint's family is run like. */
export const CHECKPOINT_TEMPLATES: Record<CheckpointBase, string> = {
	sdxl: "sdxl-base",
	sd1: "sd-1.5",
};

/** How a checkpoint is offered among the models. */
export const checkpointModelId = (id: string) => `ckpt-${id}`;
export const checkpointOf = (modelId: string): string | null =>
	modelId.startsWith("ckpt-") ? modelId.slice(5) : null;

/**
 * The family of a whole model in one file, or null when it is not one the
 * engine can run from that file alone: it needs the denoiser, the text
 * encoders and the VAE together.
 */
export function checkpointBaseOf(
	header: SafetensorsHeader,
): CheckpointBase | null {
	const named = baseFromMetadata(header.metadata);
	if (named !== null && named !== "sdxl" && named !== "sd1") return null;
	const has = (prefix: string) => header.keys.some((k) => k.startsWith(prefix));
	if (!has("model.diffusion_model.") || !has("first_stage_model.")) {
		return null;
	}
	if (has("conditioner.embedders.1.")) return "sdxl";
	// SD 2 has an OpenCLIP encoder under cond_stage_model.model instead.
	if (has("cond_stage_model.transformer.")) return "sd1";
	return null;
}

function setting(
	value: unknown,
	min: number,
	max: number,
	integer: boolean,
): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (integer && !Number.isInteger(value)) return null;
	return value >= min && value <= max ? value : null;
}

/** What a whole model in one file is, and how it is checked. */
export const CHECKPOINT_KIND: ShelfKind<CheckpointInfo> = {
	folder: "checkpoints",
	maxBytes: MAX_CHECKPOINT_BYTES,
	errors: {
		missing: "checkpointMissing",
		tooLarge: "checkpointTooLarge",
		unreadable: "checkpointUnreadable",
		invalid: "checkpointSettingsInvalid",
	},
	inspect(header, fileName) {
		const base = checkpointBaseOf(header);
		if (!base) {
			throw new ValidationError(
				"This file is not a whole SDXL or SD 1.5 model with its VAE",
				"checkpointUnknownBase",
			);
		}
		const name = nameOf(header.metadata, fileName, "Model");
		return {
			name,
			base,
			// Distilled models make a picture in a few steps, with low guidance.
			...(/lightning|turbo|hyper|lcm/i.test(`${name} ${fileName}`)
				? FEW_STEPS
				: CHECKPOINT_DEFAULTS[base]),
			// Pony and the models tuned from it are trained to skip one.
			clipSkip: /pony/i.test(`${name} ${fileName}`) ? 2 : null,
		};
	},
	parse(notes) {
		const { name, base } = notes;
		const steps = setting(notes.steps, 1, 150, true);
		const cfgScale = setting(notes.cfgScale, 0, 30, false);
		const clipSkip =
			notes.clipSkip == null ? null : setting(notes.clipSkip, 1, 12, true);
		if (
			typeof name !== "string" ||
			!name.trim() ||
			name.length > 80 ||
			!CHECKPOINT_BASES.includes(base as CheckpointBase) ||
			steps == null ||
			cfgScale == null ||
			(notes.clipSkip != null && clipSkip == null)
		) {
			return null;
		}
		return {
			name: name.trim(),
			base: base as CheckpointBase,
			steps,
			cfgScale,
			clipSkip,
		};
	},
};

/** The checkpoints kept in the models folder, each a file and its notes. */
export class CheckpointShelf extends Shelf<CheckpointInfo> {
	constructor(options: ShelfOptions<CheckpointInfo>) {
		super(CHECKPOINT_KIND, options);
	}
}
