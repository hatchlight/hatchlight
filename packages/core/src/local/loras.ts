import { ValidationError } from "../errors";
import { LORA_BASES, type LoraBase, type LoraInfo } from "../types";
import {
	nameOf,
	type SafetensorsHeader,
	Shelf,
	type ShelfKind,
	type ShelfOptions,
	shelfId,
} from "./shelf";

/**
 * A LoRA is a small file that teaches a model a style, a subject or a
 * character. It only works with the family of models it was trained on, so
 * each one is read when added to learn which family that is.
 */

/** Larger files are full models, not LoRAs. */
export const MAX_LORA_BYTES = 4 * 1024 * 1024 * 1024;

/** The family a trainer named, in `modelspec.architecture` or kohya's notes. */
export function baseFromMetadata(
	metadata: Record<string, string>,
): LoraBase | "unknown" | null {
	const named = [
		metadata["modelspec.architecture"],
		metadata.ss_base_model_version,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	if (!named) return null;
	if (/stable-diffusion-xl|sdxl/.test(named)) return "sdxl";
	if (/stable-diffusion-v1|sd_v1|sd-v1/.test(named)) return "sd1";
	if (/flux/.test(named)) return "flux";
	if (/wan/.test(named)) return "wan";
	if (/z-image|zimage/.test(named)) return "z-image";
	// Named, but a family Hatchlight has no model for (SD 2, SD 3…): the
	// tensor names would mistake it for one it has.
	return "unknown";
}

/** The family the tensor names belong to, when the trainer left no note. */
function baseFromKeys(keys: string[]): LoraBase | null {
	const any = (pattern: RegExp) => keys.some((key) => pattern.test(key));
	if (any(/double_blocks|single_blocks|single_transformer_blocks/)) {
		return "flux";
	}
	if (any(/noise_refiner|context_refiner/)) return "z-image";
	if (any(/blocks[._]\d+[._](cross_attn|self_attn)/)) return "wan";
	// SDXL has a second text encoder and names its UNet blocks the SGM way;
	// its attention blocks go deeper than SD 1's two transformer blocks.
	if (
		any(/lora_te2_|text_encoder_2/) ||
		any(/lora_unet_(input_blocks|output_blocks|middle_block)_/) ||
		any(
			/(down|up)_blocks[._]\d+[._]attentions[._]\d+[._]transformer_blocks[._][2-9]/,
		)
	) {
		return "sdxl";
	}
	if (any(/lora_unet_down_blocks_|lora_te_text_model|unet\.down_blocks/)) {
		return "sd1";
	}
	return null;
}

/** Which family of models a LoRA is for, or null when it cannot be told. */
export function loraBaseOf(header: SafetensorsHeader): LoraBase | null {
	const named = baseFromMetadata(header.metadata);
	if (named === "unknown") return null;
	return named ?? baseFromKeys(header.keys);
}

/**
 * The word that calls the LoRA up, when its trainer put one in every
 * caption (kohya counts each caption's tags in `ss_tag_frequency`).
 */
export function triggerOf(metadata: Record<string, string>): string | null {
	try {
		const frequency = JSON.parse(metadata.ss_tag_frequency ?? "null") as Record<
			string,
			Record<string, number>
		> | null;
		if (!frequency || typeof frequency !== "object") return null;
		const dirs = JSON.parse(metadata.ss_dataset_dirs ?? "null") as Record<
			string,
			{ img_count?: number }
		> | null;
		const counts = new Map<string, number>();
		for (const tags of Object.values(frequency)) {
			for (const [tag, count] of Object.entries(tags ?? {})) {
				if (typeof count !== "number") continue;
				counts.set(tag.trim(), (counts.get(tag.trim()) ?? 0) + count);
			}
		}
		const pictures = dirs
			? Object.values(dirs).reduce((sum, dir) => sum + (dir?.img_count ?? 0), 0)
			: Math.max(0, ...counts.values());
		if (pictures < 2) return null;
		// In every caption, and a word rather than a description.
		const [trigger] = [...counts]
			.filter(
				([tag, count]) =>
					count >= pictures &&
					tag.length <= 40 &&
					// Plain words: the engine reads `<…:…>` as an order.
					!/[<>:]/.test(tag),
			)
			.map(([tag]) => tag);
		return trigger || null;
	} catch {
		return null;
	}
}

/** An id the engine can read inside a prompt: `<lora:id:1>`. */
export function loraId(name: string, taken: (id: string) => boolean): string {
	return shelfId(name, taken, "lora");
}

/** What a LoRA file is, and how it is checked. */
export const LORA_KIND: ShelfKind<LoraInfo> = {
	folder: "loras",
	maxBytes: MAX_LORA_BYTES,
	errors: {
		missing: "loraMissing",
		tooLarge: "loraTooLarge",
		unreadable: "loraUnreadable",
		invalid: "loraUnreadable",
	},
	inspect(header, fileName) {
		const base = loraBaseOf(header);
		if (!base) {
			throw new ValidationError(
				"This file does not look like a LoRA for a model Hatchlight knows",
				"loraUnknownBase",
			);
		}
		return {
			name: nameOf(header.metadata, fileName, "LoRA"),
			base,
			trigger: triggerOf(header.metadata),
		};
	},
	parse(notes) {
		const { name, base, trigger } = notes;
		if (typeof name !== "string" || !LORA_BASES.includes(base as LoraBase)) {
			return null;
		}
		return {
			name,
			base: base as LoraBase,
			trigger: typeof trigger === "string" ? trigger : null,
		};
	},
};

/** The LoRAs kept in the models folder, each a file and its notes. */
export class LoraShelf extends Shelf<LoraInfo> {
	constructor(options: ShelfOptions<LoraInfo>) {
		super(LORA_KIND, options);
	}
}
