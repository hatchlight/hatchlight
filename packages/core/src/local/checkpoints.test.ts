import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalModelSpec } from "../types";
import {
	CheckpointShelf,
	checkpointBaseOf,
	checkpointModelId,
	checkpointOf,
} from "./checkpoints";
import { checkpointSpec } from "./provider";
import { safetensors } from "./testing";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

/** The names a whole SDXL model has, as in sd_xl_base_1.0.safetensors. */
const SDXL = [
	"model.diffusion_model.input_blocks.0.0.weight",
	"conditioner.embedders.0.transformer.text_model.embeddings.position_ids",
	"conditioner.embedders.1.model.ln_final.weight",
	"first_stage_model.decoder.conv_in.weight",
];
const SD1 = [
	"model.diffusion_model.input_blocks.0.0.weight",
	"cond_stage_model.transformer.text_model.embeddings.position_ids",
	"first_stage_model.decoder.conv_in.weight",
];

describe("telling a checkpoint's family", () => {
	const base = (keys: string[], metadata: Record<string, string> = {}) =>
		checkpointBaseOf({ keys, metadata });

	test("SDXL and SD 1.5 are told by their text encoders", () => {
		expect(base(SDXL)).toBe("sdxl");
		expect(base(SD1)).toBe("sd1");
	});

	test("a file without its VAE, its denoiser, or of another family is refused", () => {
		expect(base(SDXL.filter((k) => !k.startsWith("first_stage")))).toBeNull();
		expect(base(SDXL.filter((k) => !k.startsWith("model.")))).toBeNull();
		// SD 2 has an OpenCLIP encoder instead.
		expect(
			base([
				"model.diffusion_model.input_blocks.0.0.weight",
				"cond_stage_model.model.ln_final.weight",
				"first_stage_model.decoder.conv_in.weight",
			]),
		).toBeNull();
		// Named as a family Hatchlight does not run, whatever the names say.
		expect(
			base(SDXL, { "modelspec.architecture": "stable-diffusion-v3-medium" }),
		).toBeNull();
		// A LoRA is not a model.
		expect(base(["lora_unet_input_blocks_4_1_proj_in.alpha"])).toBeNull();
	});

	test("a checkpoint is offered under an id of its own", () => {
		expect(checkpointModelId("juggernaut")).toBe("ckpt-juggernaut");
		expect(checkpointOf("ckpt-juggernaut")).toBe("juggernaut");
		expect(checkpointOf("sdxl-base")).toBeNull();
	});
});

describe("the checkpoint shelf", () => {
	async function setup() {
		const root = await mkdtemp(join(tmpdir(), "hatchlight-ckpt-"));
		dirs.push(root);
		return new CheckpointShelf({ root: () => root });
	}

	test("a model is kept with its family's settings; Pony skips two text layers", async () => {
		const shelf = await setup();
		const xl = await shelf.add(
			new Blob([safetensors(SDXL, { "modelspec.title": "Juggernaut XL" })]),
			"juggernautXL_v9.safetensors",
		);
		expect(xl).toMatchObject({
			id: "juggernaut-xl",
			name: "Juggernaut XL",
			base: "sdxl",
			steps: 30,
			cfgScale: 7,
			clipSkip: null,
		});
		const pony = await shelf.add(
			new Blob([safetensors(SDXL)]),
			"ponyDiffusionV6XL.safetensors",
		);
		expect(pony.clipSkip).toBe(2);
		const sd1 = await shelf.add(
			new Blob([safetensors(SD1)]),
			"dreamshaper_8.safetensors",
		);
		expect(sd1).toMatchObject({ base: "sd1", steps: 20 });
		expect(await shelf.list()).toHaveLength(3);
	});

	test("a Lightning, Turbo, Hyper or LCM model gets few steps and low guidance", async () => {
		const shelf = await setup();
		for (const name of [
			"dreamshaperXL_lightningDPMSDE.safetensors",
			"sdxl_turbo.safetensors",
			"Hyper-SD15.safetensors",
			"LCM_Dreamshaper_v7.safetensors",
		]) {
			const model = await shelf.add(new Blob([safetensors(SDXL)]), name);
			expect(model).toMatchObject({ steps: 6, cfgScale: 2 });
		}
		// The same guess for a model found in another app's folder.
		const { CHECKPOINT_KIND } = await import("./checkpoints");
		expect(
			CHECKPOINT_KIND.inspect(
				{ keys: SDXL, metadata: {} },
				"juggernautXL_lightning.safetensors",
			),
		).toMatchObject({ steps: 6, cfgScale: 2 });
	});

	test("settings can be changed, within what makes sense", async () => {
		const shelf = await setup();
		const { id } = await shelf.add(
			new Blob([safetensors(SDXL)]),
			"m.safetensors",
		);
		expect(
			await shelf.update(id, { steps: 6, cfgScale: 1.5, clipSkip: 2 }),
		).toMatchObject({ steps: 6, cfgScale: 1.5, clipSkip: 2 });
		for (const change of [
			{ steps: 0 },
			{ steps: 2.5 },
			{ cfgScale: 99 },
			{ clipSkip: 40 },
			{ name: "" },
		]) {
			await expect(shelf.update(id, change)).rejects.toMatchObject({
				code: "checkpointSettingsInvalid",
			});
		}
		expect(await shelf.update(id, { clipSkip: null })).toMatchObject({
			clipSkip: null,
			steps: 6,
		});
	});

	test("a file that is not a whole model is refused, saying why", async () => {
		const shelf = await setup();
		await expect(
			shelf.add(
				new Blob([safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"])]),
				"x.safetensors",
			),
		).rejects.toMatchObject({ code: "checkpointUnknownBase" });
		await expect(
			shelf.add(new Blob([new Uint8Array(10)]), "x.safetensors"),
		).rejects.toMatchObject({ code: "checkpointUnreadable" });
	});

	test("settings are not changed while the folder moves", async () => {
		const root = await mkdtemp(join(tmpdir(), "hatchlight-ckpt-"));
		dirs.push(root);
		let moving = false;
		const shelf = new CheckpointShelf({
			root: () => root,
			check: () => {
				if (moving) throw new Error("moving");
			},
		});
		const { id } = await shelf.add(
			new Blob([safetensors(SDXL)]),
			"m.safetensors",
		);
		moving = true;
		await expect(shelf.update(id, { steps: 5 })).rejects.toThrow("moving");
		moving = false;
		expect((await shelf.get(id)).steps).toBe(30);
	});

	test("deleting lets go of a loaded model first", async () => {
		const root = await mkdtemp(join(tmpdir(), "hatchlight-ckpt-"));
		dirs.push(root);
		const order: string[] = [];
		const shelf = new CheckpointShelf({
			root: () => root,
			release: async () => {
				order.push("released");
			},
			changed: () => order.push("changed"),
		});
		const { id } = await shelf.add(
			new Blob([safetensors(SDXL)]),
			"m.safetensors",
		);
		order.length = 0;
		await shelf.remove(id);
		expect(order).toEqual(["released", "changed"]);
		await expect(shelf.get(id)).rejects.toMatchObject({
			code: "checkpointMissing",
		});
	});
});

describe("a checkpoint as a model", () => {
	const TEMPLATE: LocalModelSpec = {
		id: "sdxl-base",
		name: "Stable Diffusion XL",
		author: "Stability AI",
		media: "image",
		tasks: ["text-to-image", "image-to-image"],
		summary: "x",
		license: "OpenRAIL++",
		licenseUrl: "https://license.example",
		commercial: { kind: "allowed" },
		homepage: "https://models.example",
		englishPrompts: true,
		loraBase: "sdxl",
		variants: [
			{
				id: "fp16",
				label: "16-bit",
				engine: "sd-cpp",
				memoryBytes: 9,
				files: [],
			},
		],
		demos: [],
		defaults: {
			size: 1024,
			aspectRatios: ["1:1"],
			steps: 30,
			cfgScale: 7,
			references: { as: "init", max: 1 },
		},
	};

	test("it runs like its family's model, with its own name and settings", () => {
		const spec = checkpointSpec(
			{
				id: "pony",
				name: "Pony Diffusion",
				base: "sdxl",
				steps: 25,
				cfgScale: 6,
				clipSkip: 2,
				size: 1,
				addedAt: 1,
			},
			TEMPLATE,
		);
		expect(spec).toMatchObject({
			id: "ckpt-pony",
			name: "Pony Diffusion",
			loraBase: "sdxl",
			englishPrompts: true,
			variants: [{ engine: "sd-cpp", memoryBytes: 9, files: [] }],
			defaults: {
				size: 1024,
				steps: 25,
				cfgScale: 6,
				engineArgs: ["--clip-skip", "2"],
				references: { as: "init", max: 1 },
			},
		});
		// The catalog's text about the base model is not about this one, nor
		// is its license.
		expect([spec.summary, spec.homepage, spec.demos]).toEqual(["", "", []]);
		expect([spec.license, spec.commercial]).toEqual(["", { kind: "none" }]);
	});

	test("a model in 32-bit takes more memory than its family's 16-bit file", () => {
		const template = {
			...TEMPLATE,
			variants: [
				{
					id: "fp16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 9,
					files: [
						{ name: "m", url: "https://x.example/m", size: 7, sha256: "a" },
					],
				},
			],
		};
		const info = {
			id: "big",
			name: "Big",
			base: "sdxl" as const,
			steps: 30,
			cfgScale: 7,
			clipSkip: null,
			addedAt: 1,
		};
		expect(
			checkpointSpec({ ...info, size: 14 }, template).variants[0]?.memoryBytes,
		).toBe(18);
		expect(
			checkpointSpec({ ...info, size: 7 }, template).variants[0]?.memoryBytes,
		).toBe(9);
	});
});
