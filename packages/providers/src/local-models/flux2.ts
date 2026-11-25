import type { LocalModelSpec } from "@hatchlight/core";
import {
	ALL_RATIOS,
	APACHE_2,
	file,
	GB,
	hf,
	type Repo,
	SHARED,
} from "./shared";

/** Repositories and the revision each is pinned to. */
const REPO = {
	klein: [
		"black-forest-labs/FLUX.2-klein-4B",
		"e7b7dc27f91deacad38e78976d1f2b499d76a294",
	],
	kleinBase: [
		"black-forest-labs/FLUX.2-klein-base-4B",
		"a3b4f4849157f664bdbc776fd7453c2783562f4d",
	],
	kleinGguf: [
		"leejet/FLUX.2-klein-4B-GGUF",
		"3b1f5a9dc3abb32238b053aeb3d823c30afdacbd",
	],
	kleinBaseGguf: [
		"leejet/FLUX.2-klein-base-4B-GGUF",
		"d12671125306ca6b5f6db1b33ed4c80c8511a53f",
	],
	comfyKlein: [
		"Comfy-Org/Flux-2-Klein-4B",
		"5b3abca5c0dc1ecd4eaf3340868d09063fc1c965",
	],
	qwen3Gguf: [
		"unsloth/Qwen3-4B-GGUF",
		"22c9fc8a8c7700b76a1789366280a6a5a1ad1120",
	],
	fluxEncoders: [
		"comfyanonymous/flux_text_encoders",
		"6af2a98e3f615bdfa612fbd85da93d1ed5f69ef5",
	],
	chromaHd: [
		"lodestones/Chroma1-HD",
		"0e0c60ece1e82b17cb7f77342d765ba5024c40c0",
	],
	chromaHdGguf: [
		"silveroxides/Chroma1-HD-GGUF",
		"d3b77bf4eb5b84c0b50e9a1e83f6e8074ed85f82",
	],
	radianceGguf: [
		"silveroxides/Chroma1-Radiance-GGUF",
		"a36b30f072739f69615ef6a36a7ef046ad0f9f9b",
	],
} as const satisfies Record<string, Repo>;

/** The FLUX.2 image decoder, shared by every FLUX.2 model. */
const flux2Vae = file(
	REPO.comfyKlein,
	"split_files/vae/flux2-vae.safetensors",
	336_211_292,
	"868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
	"vae",
);

/** Qwen3 4B (not the 2507 Instruct), the text encoder of FLUX.2 klein 4B. */
const qwen3Q8 = file(
	REPO.qwen3Gguf,
	"Qwen3-4B-Q8_0.gguf",
	4_280_405_792,
	"eed555233267a33c7e8ee31682762cc7751b3f6d224039086e0e846f05fffa5d",
	"llm",
);
const qwen3Q4 = file(
	REPO.qwen3Gguf,
	"Qwen3-4B-Q4_K_M.gguf",
	2_497_281_312,
	"f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a",
	"llm",
);

/** T5-XXL at 16 bits, the text encoder the Chroma models are run with. */
const t5Fp16 = file(
	REPO.fluxEncoders,
	"t5xxl_fp16.safetensors",
	9_787_841_024,
	"6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635",
	"t5xxl",
);

/** The negative prompt Chroma's authors publish with their example. */
const CHROMA_NEGATIVE =
	"low quality, ugly, unfinished, out of focus, deformed, disfigure, blurry, smudged, restricted palette, flat colors";

/**
 * FLUX.2 klein 4B and the Chroma models, the FLUX-family image models whose
 * licenses allow any use.
 */
export function flux2Models(): LocalModelSpec[] {
	return [
		{
			id: "flux-2-klein-4b",
			profile: {
				family: "flux-2-klein-4b",
				name: "FLUX.2 klein 4B",
				author: "Black Forest Labs",
				speed: 3,
				quality: 2,
				text: true,
				bestFor: ["speed", "editing", "photo"],
			},
			name: "FLUX.2 klein 4B",
			author: "Black Forest Labs",
			media: "image",
			tasks: ["text-to-image", "image-edit"],
			summary:
				"A small, step-distilled FLUX.2 that makes 1024px images in four steps and edits pictures from one or more references.",
			...APACHE_2,
			homepage: "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B",
			variants: [
				// Memory: the files, all on the GPU, and about 1.75 GB to work
				// in. Measured on a 12 GB card: 8-bit edits at 1024 px every time
				// (8.3 GB loaded); 16-bit runs out when it follows a picture.
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 17 * GB,
					files: [
						file(
							REPO.klein,
							"flux-2-klein-4b.safetensors",
							7_751_105_712,
							"ec3d4e733a771f61c052fb4856c48b336c55eaf2c65487c2a1faeb9bbda7a343",
							"diffusion_model",
						),
						SHARED.qwen3InstructBf16,
						flux2Vae,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 11 * GB,
					files: [
						file(
							REPO.kleinGguf,
							"flux-2-klein-4b-Q8_0.gguf",
							4_300_629_440,
							"0bba6951258ec8f92d51114a8fa13e66828297bfff58a738f52729b3ef66fa28",
							"diffusion_model",
						),
						qwen3Q8,
						flux2Vae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 7 * GB,
					files: [
						file(
							REPO.kleinGguf,
							"flux-2-klein-4b-Q4_0.gguf",
							2_460_378_560,
							"d1023499ef3f2f82ff7c50e6778495195c1b6cc34835741778868428111f9ff4",
							"diffusion_model",
						),
						qwen3Q4,
						flux2Vae,
					],
				},
			],
			defaults: {
				// Measured on a 12 GB card with the engine pinned now: following a
				// picture at 1024 px no longer fits beside the model without a
				// memory budget (20 s with it).
				vramBudget: true,
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 4,
				cfgScale: 1,
				sampler: "euler",
				references: { as: "ref", max: 4 },
				// Following a picture at 1024 px fits a 12 GB card only with
				// flash attention, and without showing the picture as it forms.
				engineArgs: ["--flash-attn", "off,diffusion=on"],
				previewsWhileFollowing: false,
			},
			demos: [
				{
					url: hf(...REPO.klein, "realism.jpg"),
					media: "image",
					caption: "Photorealistic samples from the model card",
				},
				{
					url: hf(...REPO.klein, "editing.jpg"),
					media: "image",
					caption: "Editing samples from the model card",
				},
			],
		},
		{
			id: "flux-2-klein-base-4b",
			profile: {
				family: "flux-2-klein-base-4b",
				name: "FLUX.2 klein Base 4B",
				author: "Black Forest Labs",
				speed: 1,
				quality: 2,
				text: true,
				bestFor: ["detail", "editing"],
			},
			name: "FLUX.2 klein Base 4B",
			author: "Black Forest Labs",
			media: "image",
			tasks: ["text-to-image", "image-edit"],
			summary:
				"The undistilled FLUX.2 klein 4B: slower, with more varied results, and the one to pair with fine-tunes and LoRAs.",
			...APACHE_2,
			homepage: "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4B",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 17 * GB,
					files: [
						file(
							REPO.kleinBase,
							"flux-2-klein-base-4b.safetensors",
							7_751_105_712,
							"9c5fed22b76baea749d88fc2abe3ad53245e7b21a0d353a762665eea00043b92",
							"diffusion_model",
						),
						SHARED.qwen3InstructBf16,
						flux2Vae,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 11 * GB,
					files: [
						file(
							REPO.kleinBaseGguf,
							"flux-2-klein-base-4b-Q8_0.gguf",
							4_300_629_440,
							"197fbc64147d4f0a0ddf4c9e667b05a3790a73ed12f92d391f0f4d286ee30fe8",
							"diffusion_model",
						),
						qwen3Q8,
						flux2Vae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 7 * GB,
					files: [
						file(
							REPO.kleinBaseGguf,
							"flux-2-klein-base-4b-Q4_0.gguf",
							2_460_378_560,
							"c3a2854510677b7aa37dd7547d908c54889a76c6d6aa3ffe902fcaa092d1328b",
							"diffusion_model",
						),
						qwen3Q4,
						flux2Vae,
					],
				},
			],
			defaults: {
				// The same files as FLUX.2 klein 4B, which follows a picture on a
				// 12 GB card only within a memory budget.
				vramBudget: true,
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 20,
				cfgScale: 4,
				references: { as: "ref", max: 4 },
				// Following a picture at 1024 px fits a 12 GB card only with
				// flash attention, and without showing the picture as it forms.
				engineArgs: ["--flash-attn", "off,diffusion=on"],
				previewsWhileFollowing: false,
			},
			demos: [
				{
					url: hf(...REPO.kleinBase, "realism.jpg"),
					media: "image",
					caption: "Samples of the FLUX.2 klein family from the model card",
				},
			],
		},
		{
			id: "chroma1-hd",
			englishPrompts: true,
			profile: {
				family: "chroma1-hd",
				name: "Chroma1-HD",
				author: "lodestones",
				speed: 1,
				quality: 2,
				text: true,
				bestFor: ["illustration", "photo"],
			},
			name: "Chroma1-HD",
			author: "lodestones",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"An 8.9B model rebuilt from FLUX.1 schnell, with a wide range of styles and real negative prompts. Made as a base for fine-tuning.",
			...APACHE_2,
			homepage: "https://huggingface.co/lodestones/Chroma1-HD",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 21 * GB,
					files: [
						file(
							REPO.chromaHd,
							"Chroma1-HD.safetensors",
							17_800_038_288,
							"d446d9695d08276f61e53653e025289dd96f7a489c27982a1fa54ecabc06642a",
							"diffusion_model",
						),
						t5Fp16,
						SHARED.fluxVae,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 13 * GB,
					files: [
						file(
							REPO.chromaHdGguf,
							"Chroma1-HD-Q8_0.gguf",
							9_735_409_824,
							"8c8d66177bfc584573dd21584399ebc1f00bde60acbbc48ac3cc8f58f10c6094",
							"diffusion_model",
						),
						t5Fp16,
						SHARED.fluxVae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 8 * GB,
					files: [
						file(
							REPO.chromaHdGguf,
							"Chroma1-HD-Q4_K_M.gguf",
							5_566_533_792,
							"086f561e371d442b82b2c3689149da75046754c62a35293932cda397fc2bf9d2",
							"diffusion_model",
						),
						t5Fp16,
						SHARED.fluxVae,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 40,
				cfgScale: 4,
				sampler: "euler",
				negativePrompt: CHROMA_NEGATIVE,
				engineArgs: ["--model-args", "chroma_use_dit_mask=false"],
			},
			demos: [
				{
					url: hf(...REPO.chromaHd, "ComfyUI_Chroma1-HD_T2I-sample.png"),
					media: "image",
					caption: "A sample from the model card",
				},
			],
		},
		{
			id: "chroma1-radiance",
			englishPrompts: true,
			profile: {
				family: "chroma1-radiance",
				name: "Chroma1-Radiance",
				author: "lodestones",
				speed: 1,
				quality: 2,
				text: false,
				bestFor: ["detail", "photo"],
			},
			name: "Chroma1-Radiance",
			author: "lodestones",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"A Chroma that draws pixels directly instead of going through an image decoder, which keeps fine detail. Still in training; this is its v0.4 release.",
			...APACHE_2,
			homepage: "https://huggingface.co/lodestones/Chroma1-Radiance",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 14 * GB,
					files: [
						file(
							REPO.radianceGguf,
							"Chroma1-Radiance-v0.4/Chroma1-Radiance-v0.4-Q8_0.gguf",
							10_386_601_952,
							"a92bb87e5241cbc876d8e40052cd78b5f7bc851c8a45a66c8fe06ab2082cb0b1",
							"diffusion_model",
						),
						t5Fp16,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 20,
				cfgScale: 4,
				sampler: "euler",
			},
			demos: [],
		},
	];
}
