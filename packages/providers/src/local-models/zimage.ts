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
	zImage: ["Tongyi-MAI/Z-Image", "04cc4abb7c5069926f75c9bfde9ef43d49423021"],
	comfyZImage: [
		"Comfy-Org/Z-Image",
		"94d47a468ec820d29a5dc09d4642539d76d49542",
	],
	zImageGguf: [
		"unsloth/Z-Image-GGUF",
		"a84a5f4e7dcff6bc446c0a54a477a4a21aa800b0",
	],
	l2p: ["zhen-nan/L2P", "df14648875b75b880a639ba715e9b3ea2aaf2b4f"],
	comfyErnie: [
		"Comfy-Org/ERNIE-Image",
		"50509a88bc4fb9e89583a98605f4c81dc221eb8c",
	],
	ernieGguf: [
		"unsloth/ERNIE-Image-GGUF",
		"7b6dfaae7389b463d7fb4669e33c560d36ad108c",
	],
	ernieTurboGguf: [
		"unsloth/ERNIE-Image-Turbo-GGUF",
		"a38270280633a5d318a9f51c18ef95eefb07c423",
	],
	ministralGguf: [
		"unsloth/Ministral-3-3B-Instruct-2512-GGUF",
		"7564922f37fa5bbb62b87f09a55c12f1f91d7a6a",
	],
	mossSft: [
		"OpenMOSS-Team/MOSS-Image-SFT",
		"f972bd4b4b9e3852133cc5da954d87bc32cd8fb9",
	],
	comfyMoss: [
		"Comfy-Org/MOSS-Image",
		"2929efe3cdd506c0a430bcfca70a9a8d805cc095",
	],
	mossSftGguf: [
		"leejet/MOSS-Image-SFT-GGUF",
		"2df0cb525ccf55467c6f8a9ee52fa8310db23b34",
	],
	qwen35Gguf: [
		"unsloth/Qwen3.5-9B-GGUF",
		"3885219b6810b007914f3a7950a8d1b469d598a5",
	],
} as const satisfies Record<string, Repo>;

/** Files both ERNIE-Image models use. */
const ERNIE = {
	/** The FLUX.2 image decoder, as Comfy-Org packs it for ERNIE-Image. */
	vae: file(
		REPO.comfyErnie,
		"vae/flux2-vae.safetensors",
		336_213_556,
		"d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5",
		"vae",
	),
	/** Ministral 3 3B, the text encoder. */
	llmBf16: file(
		REPO.comfyErnie,
		"text_encoders/ministral-3-3b.safetensors",
		7_717_637_511,
		"49a750a128863854eac7d85e1a277a7b44bf6ec3646405b84686dfeeca3708ca",
		"llm",
	),
	llmQ8: file(
		REPO.ministralGguf,
		"Ministral-3-3B-Instruct-2512-Q8_0.gguf",
		3_651_679_520,
		"920163471715241a9d99367d507e2ad94d1ebc34d0d169d25e5d97a49ec72556",
		"llm",
	),
	llmQ4: file(
		REPO.ministralGguf,
		"Ministral-3-3B-Instruct-2512-Q4_K_M.gguf",
		2_146_497_824,
		"fd46fc371ff0509bfa8657ac956b7de8534d7d9baaa4947975c0648c3aa397f4",
		"llm",
	),
} as const;

/** Files every MOSS-Image variant uses. */
const MOSS = {
	/** The FLUX.2 image decoder, as Comfy-Org packs it for MOSS-Image. */
	vae: file(
		REPO.comfyMoss,
		"vae/flux2-vae.safetensors",
		336_211_292,
		"868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
		"vae",
	),
	/** Qwen3.5's vocabulary, which differs from the one the engine embeds. */
	tokenizer: file(
		REPO.mossSft,
		"tokenizer/tokenizer.json",
		19_989_325,
		"06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523",
		"tokenizer",
	),
	/** Qwen3.5 9B, the text encoder. */
	llmQ8: file(
		REPO.qwen35Gguf,
		"Qwen3.5-9B-Q8_0.gguf",
		9_527_502_048,
		"809626574d0cb43d4becfa56169980da2bb448f2299270f7be443cb89d0a6ae4",
		"llm",
	),
	llmQ4: file(
		REPO.qwen35Gguf,
		"Qwen3.5-9B-Q4_K_M.gguf",
		5_680_522_464,
		"03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
		"llm",
	),
} as const;

/**
 * Z-Image's undistilled base model, its pixel-space L2P variant, and the
 * single-stream image models that followed it: ERNIE-Image and MOSS-Image.
 */
export function zimageModels(): LocalModelSpec[] {
	return [
		{
			id: "z-image",
			profile: {
				family: "z-image",
				name: "Z-Image",
				author: "Tongyi-MAI",
				speed: 1,
				quality: 3,
				text: true,
				bestFor: ["photo", "detail"],
			},
			name: "Z-Image",
			author: "Tongyi-MAI (Alibaba)",
			media: "image",
			tasks: ["text-to-image", "image-to-image"],
			summary:
				"The undistilled base model behind Z-Image Turbo: slower, but more varied, and it follows negative prompts. A good base for fine-tunes and LoRAs.",
			...APACHE_2,
			homepage: "https://huggingface.co/Tongyi-MAI/Z-Image",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 15 * GB,
					files: [
						file(
							REPO.comfyZImage,
							"split_files/diffusion_models/z_image_bf16.safetensors",
							12_309_866_400,
							"996a67d3ff666946b1c25cbc16d1b1918b6cc0ac166309e23fe3b3d830263dee",
							"diffusion_model",
						),
						SHARED.qwen3InstructBf16,
						SHARED.fluxVae,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 10 * GB,
					files: [
						file(
							REPO.zImageGguf,
							"z-image-Q8_0.gguf",
							7_224_707_136,
							"a51d4e36f84caa972e0eff65e8bd2961add14374d8a7038a51eefea2fe45f2c9",
							"diffusion_model",
						),
						SHARED.qwen3InstructQ8,
						SHARED.fluxVae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 7 * GB,
					files: [
						file(
							REPO.zImageGguf,
							"z-image-Q4_K_M.gguf",
							3_850_115_136,
							"e7fe0cd70917d8f266df936672210b5397bca8092a22608cf2c1fdc266f78a8c",
							"diffusion_model",
						),
						SHARED.qwen3InstructQ4,
						SHARED.fluxVae,
					],
				},
			],
			defaults: {
				references: { as: "init", max: 1 },
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 28,
				cfgScale: 5,
			},
			demos: [
				{
					url: hf(...REPO.zImage, "teaser.jpg"),
					media: "image",
					caption: "Samples from the model card",
				},
			],
		},
		{
			id: "z-image-l2p",
			profile: {
				family: "z-image-l2p",
				name: "Z-Image L2P",
				author: "NJU PCALab",
				speed: 1,
				quality: 2,
				text: false,
				bestFor: ["detail"],
			},
			name: "Z-Image L2P",
			author: "NJU PCALab",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"Z-Image Turbo moved to pixel space: it draws pixels directly, with no image decoder. A research model that comes close to the original's prompt following.",
			...APACHE_2,
			homepage: "https://huggingface.co/zhen-nan/L2P",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 14 * GB,
					files: [
						file(
							REPO.l2p,
							"model-1k-merge.safetensors",
							19_569_401_798,
							"e785acf53a336bb2c10640a640116fd0bb770ffc7e84d2440b8ad6e7b420c666",
							"diffusion_model",
						),
						SHARED.qwen3InstructBf16,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 30,
				cfgScale: 2,
				sampler: "euler",
				engineArgs: ["--type", "bf16"],
			},
			demos: [],
		},
		{
			id: "ernie-image-turbo",
			profile: {
				family: "ernie-image-turbo",
				name: "ERNIE-Image Turbo",
				author: "Baidu",
				speed: 2,
				quality: 3,
				text: true,
				bestFor: ["text", "illustration"],
			},
			name: "ERNIE-Image Turbo",
			author: "Baidu",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"Images in eight steps that follow detailed instructions and render text well, suited to posters, comics and multi-panel layouts.",
			...APACHE_2,
			homepage: "https://huggingface.co/baidu/ERNIE-Image-Turbo",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 19 * GB,
					files: [
						file(
							REPO.comfyErnie,
							"diffusion_models/ernie-image-turbo.safetensors",
							16_067_025_480,
							"741a4cc0467d4b9f04490d7faa9a5869ff4aa97eb2914927a1df9abb070e8e52",
							"diffusion_model",
						),
						ERNIE.llmBf16,
						ERNIE.vae,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 12 * GB,
					files: [
						file(
							REPO.ernieTurboGguf,
							"ernie-image-turbo-Q8_0.gguf",
							8_694_907_584,
							"c90af9c9a2cf6f7d0404c3fb17e84391c59b240362284f702168f8d71cfeba5d",
							"diffusion_model",
						),
						ERNIE.llmQ8,
						ERNIE.vae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 9 * GB,
					files: [
						file(
							REPO.ernieTurboGguf,
							"ernie-image-turbo-UD-Q4_K_M.gguf",
							5_778_817_728,
							"b55c6a0104d7635097665527267bbd934d5fa43c00722ef6c42dd1e6470d64c4",
							"diffusion_model",
						),
						ERNIE.llmQ4,
						ERNIE.vae,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 8,
				cfgScale: 1,
				// The 8-bit model and a full-size picture do not fit a 12 GB card at once.
				vramBudget: true,
			},
			demos: [],
		},
		{
			id: "ernie-image",
			profile: {
				family: "ernie-image",
				name: "ERNIE-Image",
				author: "Baidu",
				speed: 1,
				quality: 3,
				text: true,
				bestFor: ["text", "instructions"],
			},
			name: "ERNIE-Image",
			author: "Baidu",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"The full ERNIE-Image model: slower than Turbo, with stronger instruction following and text rendering for posters, comics and structured layouts.",
			...APACHE_2,
			homepage: "https://huggingface.co/baidu/ERNIE-Image",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 19 * GB,
					files: [
						file(
							REPO.comfyErnie,
							"diffusion_models/ernie-image.safetensors",
							16_067_025_480,
							"94a35abaa0899cccc34d2e37310abf74a0a714256526117bba782c7eb4eb91c7",
							"diffusion_model",
						),
						ERNIE.llmBf16,
						ERNIE.vae,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 12 * GB,
					files: [
						file(
							REPO.ernieGguf,
							"ernie-image-Q8_0.gguf",
							8_694_907_584,
							"dc6ed503a2b66e01a86edbda7c557141a95ad4c262a5ee6cad90c41559e0a499",
							"diffusion_model",
						),
						ERNIE.llmQ8,
						ERNIE.vae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 9 * GB,
					files: [
						file(
							REPO.ernieGguf,
							"ernie-image-UD-Q4_K_M.gguf",
							5_774_754_496,
							"62c7ab59ad9dfcf4333a5a6bf4bfe7304bb184b8be347bae90ecb626dd419a1c",
							"diffusion_model",
						),
						ERNIE.llmQ4,
						ERNIE.vae,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 50,
				cfgScale: 5,
				// The 8-bit model and a full-size picture do not fit a 12 GB card at once.
				vramBudget: true,
			},
			demos: [],
		},
		{
			id: "moss-image",
			profile: {
				family: "moss-image",
				name: "MOSS-Image",
				author: "OpenMOSS",
				speed: 1,
				quality: 2,
				text: true,
				bestFor: ["text", "instructions"],
			},
			name: "MOSS-Image",
			author: "OpenMOSS",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"A 5B model, fine-tuned for clean layouts and legible text. It reads plain prompts, tag lists and JSON layouts that place text and objects.",
			...APACHE_2,
			homepage: "https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 13 * GB,
					files: [
						file(
							REPO.comfyMoss,
							"diffusion_models/moss_image_sft_bf16.safetensors",
							10_164_655_808,
							"f96738d8116d78b7316b57c663d8c98591ddafab7488f48e3099b7655e34ab6f",
							"diffusion_model",
						),
						MOSS.llmQ8,
						MOSS.tokenizer,
						MOSS.vae,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 9 * GB,
					files: [
						file(
							REPO.mossSftGguf,
							"MOSS-Image-SFT-Q8_0.gguf",
							5_705_571_168,
							"740040af6492ae5f951d5b7a8cb56927c1a02e64696f4bd4bd124bb798ce5635",
							"diffusion_model",
						),
						MOSS.llmQ8,
						MOSS.tokenizer,
						MOSS.vae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 6 * GB,
					files: [
						file(
							REPO.mossSftGguf,
							"MOSS-Image-SFT-Q4_K.gguf",
							3_327_400_800,
							"902dbb0364d8b313cd91792b3cfe7c87b987386f0c5414986f3f1027b82b2225",
							"diffusion_model",
						),
						MOSS.llmQ4,
						MOSS.tokenizer,
						MOSS.vae,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 50,
				cfgScale: 3,
			},
			demos: [
				{
					url: hf(...REPO.mossSft, "assets/teaser.webp"),
					media: "image",
					caption: "Samples from the model card",
				},
				{
					url: hf(...REPO.mossSft, "assets/showcase/text-rendering.webp"),
					media: "image",
					caption: "Text rendering samples from the model card",
				},
			],
		},
	];
}
