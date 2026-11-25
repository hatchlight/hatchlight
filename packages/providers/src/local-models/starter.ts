import type { LocalModelSpec } from "@hatchlight/core";
import { PROFILES } from "../profiles";
import {
	ALL_RATIOS,
	APACHE_2,
	file,
	GB,
	hf,
	openRail,
	type Repo,
	SHARED,
	WAN_NEGATIVE,
} from "./shared";

/** Repositories and the revision each is pinned to. */
const REPO = {
	sdxlTurbo: [
		"stabilityai/sdxl-turbo",
		"71153311d3dbb46851df1931d3ca6e939de83304",
	],
	sdxl: [
		"stabilityai/stable-diffusion-xl-base-1.0",
		"462165984030d82259a11f4367a4eed129e94a7b",
	],
	fluxGguf: [
		"city96/FLUX.1-schnell-gguf",
		"f495746ed9c5efcf4661f53ef05401dceadc17d2",
	],
	comfyZImage: [
		"Comfy-Org/Z-Image-Turbo",
		"6fc90a3b1b653e935a0d175e260736de25b84df5",
	],
	zImageGguf: [
		"leejet/Z-Image-Turbo-GGUF",
		"c61c0e422dc8b541b7548cf33a4ef8302b0f8085",
	],
	zImage: [
		"Tongyi-MAI/Z-Image-Turbo",
		"f332072aa78be7aecdf3ee76d5c247082da564a6",
	],
	comfyWan: ["Comfy-Org/Wan-2.1", "123acf1cc74bccbb9bfff8ac1ee72edc08c2341d"],
	zImageControl: [
		"alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1",
		"5155fc56d17821007d6f62ac192c09e0f0e72016",
	],
} as const satisfies Record<string, Repo>;

/** Z-Image Turbo's own weights, shared by its guided entry. */
const Z_IMAGE_TURBO = {
	q8: file(
		REPO.zImageGguf,
		"z_image_turbo-Q8_0.gguf",
		6_577_440_704,
		"df1c5baa86d1398c979495a6072dbcee79444fdb884a2445582ba0769c44e9a1",
		"diffusion_model",
	),
	q4: file(
		REPO.zImageGguf,
		"z_image_turbo-Q4_K.gguf",
		3_864_250_304,
		"14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd",
		"diffusion_model",
	),
	/**
	 * The Fun ControlNet Union 2.1, lite: outlines, pose and depth in one
	 * file. The engine loads only this 2.1 layout (33 control channels), not
	 * the first Union's.
	 */
	control: file(
		REPO.zImageControl,
		"Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors",
		2_016_627_488,
		"3ea098db9bd145be525c7e2366920b6d76c5ffd46b3d7aa8169bbc943fdaee35",
		"control_net",
	),
};

/**
 * The first models Hatchlight offered, the ones verified on real hardware.
 */
export function starterModels(): LocalModelSpec[] {
	return [
		{
			id: "sdxl-turbo",
			englishPrompts: true,
			// Not `loraBase`: LoRAs trained on SDXL load, but at one step they
			// barely show, and stronger they spoil the picture.
			profile: PROFILES.sdxlTurbo,
			name: "SDXL Turbo",
			author: "Stability AI",
			media: "image",
			tasks: ["text-to-image", "image-to-image"],
			summary:
				"A distilled SDXL that makes a 512px image in a single step. The quickest way to try ideas.",
			license: "Stability AI Community License",
			licenseUrl:
				"https://huggingface.co/stabilityai/sdxl-turbo/blob/main/LICENSE.md",
			commercial: { kind: "limited", revenueUsd: 1_000_000 },
			homepage: "https://huggingface.co/stabilityai/sdxl-turbo",
			variants: [
				{
					id: "fp16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 8 * GB,
					files: [
						file(
							REPO.sdxlTurbo,
							"sd_xl_turbo_1.0_fp16.safetensors",
							6_938_081_905,
							"e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26",
							"model",
						),
					],
				},
			],
			defaults: {
				references: { as: "init", max: 1 },
				size: 512,
				aspectRatios: ALL_RATIOS,
				steps: 1,
				cfgScale: 1,
			},
			demos: [
				{
					url: hf(...REPO.sdxlTurbo, "output_tile.jpg"),
					media: "image",
					caption: "Single-step samples from the model card",
				},
			],
		},
		{
			id: "sdxl-base",
			englishPrompts: true,
			loraBase: "sdxl",
			profile: PROFILES.sdxl,
			name: "Stable Diffusion XL",
			author: "Stability AI",
			media: "image",
			tasks: ["text-to-image", "image-to-image"],
			summary:
				"The 1024px general-purpose model with the largest ecosystem of fine-tunes and LoRAs.",
			...openRail(
				"CreativeML Open RAIL++-M",
				"https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md",
			),
			homepage:
				"https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0",
			variants: [
				{
					id: "fp16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 9 * GB,
					files: [
						file(
							REPO.sdxl,
							"sd_xl_base_1.0.safetensors",
							6_938_078_334,
							"31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b",
							"model",
						),
					],
				},
			],
			defaults: {
				references: { as: "init", max: 1 },
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 30,
				cfgScale: 7,
			},
			demos: [
				{
					url: hf(...REPO.sdxl, "01.png"),
					media: "image",
					caption: "Samples from the model card",
				},
			],
		},
		{
			id: "flux-schnell",
			englishPrompts: true,
			profile: PROFILES.fluxSchnell,
			name: "FLUX.1 schnell",
			author: "Black Forest Labs",
			media: "image",
			tasks: ["text-to-image", "image-to-image"],
			summary:
				"Detailed 1024px images in four steps, with strong prompt following.",
			...APACHE_2,
			homepage: "https://huggingface.co/black-forest-labs/FLUX.1-schnell",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 15 * GB,
					files: [
						file(
							REPO.fluxGguf,
							"flux1-schnell-Q8_0.gguf",
							12_687_821_728,
							"f6694941193b10148dbf1f0f498d4ccd3e9875c127fc53946213b68580c66f10",
							"diffusion_model",
						),
						SHARED.fluxT5,
						SHARED.fluxClip,
						SHARED.fluxVae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 9 * GB,
					files: [
						file(
							REPO.fluxGguf,
							"flux1-schnell-Q4_K_S.gguf",
							6_783_943_712,
							"4fd16477b3a5296d0cf722c4b92a9fd7f30d09ac7495826e4465d8de9c9fd973",
							"diffusion_model",
						),
						SHARED.fluxT5,
						SHARED.fluxClip,
						SHARED.fluxVae,
					],
				},
			],
			defaults: {
				references: { as: "init", max: 1 },
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 4,
				cfgScale: 1,
				sampler: "euler",
			},
			demos: [
				{
					url: "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/f8610f7cd567f4b4e9d76320e8774c8fda061723/templates/flux_schnell-1.webp",
					media: "image",
					caption: "A sample from ComfyUI's FLUX.1 schnell template",
				},
			],
		},
		{
			id: "z-image-turbo",
			profile: PROFILES.zImage,
			name: "Z-Image Turbo",
			author: "Tongyi-MAI (Alibaba)",
			media: "image",
			tasks: ["text-to-image", "image-to-image"],
			summary:
				"Photorealistic images in eight steps, and legible text in English and Chinese.",
			...APACHE_2,
			homepage: "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 15 * GB,
					files: [
						file(
							REPO.comfyZImage,
							"split_files/diffusion_models/z_image_turbo_bf16.safetensors",
							12_309_866_400,
							"2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6",
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
					memoryBytes: 9 * GB,
					files: [Z_IMAGE_TURBO.q8, SHARED.qwen3InstructQ8, SHARED.fluxVae],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 6 * GB,
					files: [Z_IMAGE_TURBO.q4, SHARED.qwen3InstructQ4, SHARED.fluxVae],
				},
			],
			defaults: {
				references: { as: "init", max: 1 },
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 8,
				cfgScale: 1,
			},
			demos: [
				{
					url: hf(...REPO.zImage, "assets/showcase_realistic.png"),
					media: "image",
					caption: "Photorealistic samples from the model card",
				},
				{
					url: hf(...REPO.zImage, "assets/showcase_rendering.png"),
					media: "image",
					caption: "Text rendering samples from the model card",
				},
			],
		},
		{
			id: "z-image-turbo-guided",
			profile: PROFILES.zImageGuided,
			name: "Z-Image Turbo, guided",
			author: "Tongyi-MAI and Alibaba PAI",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"Z-Image Turbo that follows a guide picture: its outlines, or a ready pose or depth map. Adds 2 GB to Z-Image Turbo.",
			...APACHE_2,
			homepage:
				"https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1",
			// Measured on a 12 GB card (RTX 4070 SUPER, the desktop holding
			// about 2.2 GB): the 8-bit model and the control file take about
			// 8.2 GB, and a 1024px picture's workspace about 2 GB more. It runs
			// only within its memory budget (31 s), and 10.5 GB still lets a
			// 12 GB card choose it over the 4-bit one, which is estimated.
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 10.5 * GB,
					files: [
						Z_IMAGE_TURBO.q8,
						SHARED.qwen3InstructQ8,
						SHARED.fluxVae,
						Z_IMAGE_TURBO.control,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 8 * GB,
					files: [
						Z_IMAGE_TURBO.q4,
						SHARED.qwen3InstructQ4,
						SHARED.fluxVae,
						Z_IMAGE_TURBO.control,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 8,
				cfgScale: 1,
				// Without one, the model and the control file fill a 12 GB card
				// and the picture's workspace no longer fits, even at 768px or
				// with --offload-to-cpu.
				vramBudget: true,
				// The engine finds outlines itself; pose and depth come as maps.
				guide: {
					kinds: ["outlines", "pose", "depth"],
					makesMaps: ["outlines"],
					strength: 0.75,
				},
			},
			demos: [
				{
					url: hf(...REPO.zImageControl, "results/pose_lite.png"),
					media: "image",
					caption: "A picture following a pose, from the model card",
				},
				{
					url: hf(...REPO.zImageControl, "results/canny_lite.png"),
					media: "image",
					caption: "A picture following outlines, from the model card",
				},
			],
		},
		{
			id: "wan-2.1-t2v-1.3b",
			profile: PROFILES.wanLocal,
			name: "Wan 2.1 T2V 1.3B",
			author: "Wan-AI (Alibaba)",
			media: "video",
			tasks: ["text-to-video"],
			summary:
				"Short 480p clips from text. The small Wan model, made to run on consumer graphics cards.",
			...APACHE_2,
			homepage: "https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B",
			variants: [
				{
					id: "fp16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 7 * GB,
					files: [
						file(
							REPO.comfyWan,
							"split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors",
							2_838_303_560,
							"be531024cd9018cb5b48c40cfbb6a6191645b1c792eb8bf4f8c1c6e10f924dc5",
							"diffusion_model",
						),
						SHARED.umt5Q8,
						SHARED.wan21Vae,
					],
				},
			],
			defaults: {
				size: 832,
				aspectRatios: ["16:9", "9:16"],
				steps: 30,
				cfgScale: 6,
				sampler: "euler",
				flowShift: 3,
				fps: 16,
				durations: [2, 3, 5],
				negativePrompt: WAN_NEGATIVE,
			},
			demos: [
				{
					url: "https://cloud.video.taobao.com/vod/Jth64Y7wNoPcJki_Bo1ZJTDBvNjsgjlVKsNs05Fqfps.mp4",
					media: "video",
					caption: "The Wan 2.1 demo reel from the model card",
				},
			],
		},
	];
}
