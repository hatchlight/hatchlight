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
	comfyQwenImage: [
		"Comfy-Org/Qwen-Image",
		"1f12b17be14c89b026c51a91d67c32f84bb047bc",
	],
	qwenImageGguf: [
		"QuantStack/Qwen-Image-GGUF",
		"257f261fa92593bed760aa6fa3f7921a49fea00f",
	],
	qwenImageEditGguf: [
		"unsloth/Qwen-Image-Edit-2511-GGUF",
		"52838251db242ddd8e8d0118de36c71006d7c397",
	],
	qwenVlGguf: [
		"mradermacher/Qwen2.5-VL-7B-Instruct-GGUF",
		"cfa2baa09946b211c107e6e104948987a64dd2c1",
	],
	comfyLongCat: [
		"Comfy-Org/LongCat-Image",
		"d49457a376940fa670ac73f4e21763c56638f19c",
	],
	longCatGguf: [
		"vantagewithai/LongCat-Image-GGUF",
		"22f38d64150ed3a99454e5e3a3bbfcf639969b05",
	],
	longCatEditGguf: [
		"vantagewithai/LongCat-Image-Edit-GGUF",
		"8bfeb76dd77f783aecbe99bcc32f22ee1a45e222",
	],
	longCat: [
		"meituan-longcat/LongCat-Image",
		"d2ea50b79a930074c37b9b97ce45e3b2ea8cf4d8",
	],
	longCatEdit: [
		"meituan-longcat/LongCat-Image-Edit",
		"7b54ef423aa7854be7861600024be5c56ab7875a",
	],
	longCatEditTurbo: [
		"meituan-longcat/LongCat-Image-Edit-Turbo",
		"6a7262de5549f0bf0ec54c08ef7d283ef41f3214",
	],
	comfyOvis: [
		"Comfy-Org/Ovis-Image",
		"b7d0cb855e82448c28936c9907a143bf319c80a0",
	],
	ovisGguf: [
		"leejet/Ovis-Image-7B-GGUF",
		"0e0e56e1d63bf3c57282cf11846211e683f68871",
	],
} as const satisfies Record<string, Repo>;

/** Qwen2.5-VL 7B Instruct, the text encoder of Qwen-Image and LongCat-Image. */
export const QWEN_VL = {
	q8: file(
		REPO.qwenVlGguf,
		"Qwen2.5-VL-7B-Instruct.Q8_0.gguf",
		8_098_524_160,
		"577bfb3e41f93f00414e594c56a38bbe91207b3b636ab7faf343e34a20aa73ca",
		"llm",
	),
	q4: file(
		REPO.qwenVlGguf,
		"Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf",
		4_683_072_512,
		"0f00a930ba3108b6861ddadf74d8ebbd82e257c63eba728e62c3e8970f5eed94",
		"llm",
	),
	/** The vision part, which editing needs to see the given pictures. */
	vision: file(
		REPO.qwenVlGguf,
		"Qwen2.5-VL-7B-Instruct.mmproj-Q8_0.gguf",
		853_119_712,
		"2185ca0adf339f96845318c7b666f5d242f86bbace5657a89cb834785d0cea57",
		"llm_vision",
	),
};

/** The image decoder of Qwen-Image and Qwen-Image-Edit. */
const QWEN_IMAGE_VAE = file(
	REPO.comfyQwenImage,
	"split_files/vae/qwen_image_vae.safetensors",
	253_806_246,
	"a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
	"vae",
);

/** Ovis 2.5 2B, the text encoder of Ovis-Image. */
const OVIS_TEXT_ENCODER = file(
	REPO.comfyOvis,
	"split_files/text_encoders/ovis_2.5.safetensors",
	5_140_950_080,
	"f453ee5e7a25cb23cf2adf7aae3e5b405f22097cb67f2cfcca029688cb3f740d",
	"llm",
);

/**
 * Qwen-Image and the models that share its text encoder: LongCat-Image from
 * Meituan, and Ovis-Image from Alibaba's AIDC.
 */
export function qwenModels(): LocalModelSpec[] {
	return [
		{
			id: "qwen-image",
			profile: {
				family: "qwen-image",
				name: "Qwen-Image",
				author: "Qwen (Alibaba)",
				speed: 1,
				quality: 3,
				text: true,
				bestFor: ["text", "detail", "instructions"],
			},
			name: "Qwen-Image",
			author: "Qwen (Alibaba)",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"A large 20B model that follows long prompts closely and writes long passages of text in English and Chinese. It needs a lot of memory.",
			...APACHE_2,
			homepage: "https://huggingface.co/Qwen/Qwen-Image",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 25 * GB,
					files: [
						file(
							REPO.qwenImageGguf,
							"Qwen_Image-Q8_0.gguf",
							21_761_817_120,
							"43142b32778dc0568c27395abc6f8291ac53f1de0b98eed919712cf161f248de",
							"diffusion_model",
						),
						QWEN_VL.q8,
						QWEN_IMAGE_VAE,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 16 * GB,
					files: [
						file(
							REPO.qwenImageGguf,
							"Qwen_Image-Q4_K_M.gguf",
							13_065_746_976,
							"645473886d7dbb0103f84c563c798f7b0867293d919752d4d6be6a432b0bc988",
							"diffusion_model",
						),
						QWEN_VL.q4,
						QWEN_IMAGE_VAE,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 20,
				cfgScale: 2.5,
				sampler: "euler",
				flowShift: 3,
			},
			demos: [],
		},
		{
			id: "qwen-image-edit-2511",
			profile: {
				family: "qwen-image-edit",
				name: "Qwen-Image-Edit",
				author: "Qwen (Alibaba)",
				speed: 1,
				quality: 3,
				text: true,
				bestFor: ["editing", "instructions", "text"],
			},
			name: "Qwen-Image-Edit 2511",
			author: "Qwen (Alibaba)",
			media: "image",
			tasks: ["image-edit"],
			summary:
				"Changes pictures from written instructions, keeping people and objects consistent, and can combine up to three pictures. It can also edit the text inside a picture.",
			...APACHE_2,
			homepage: "https://huggingface.co/Qwen/Qwen-Image-Edit-2511",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 25 * GB,
					files: [
						file(
							REPO.qwenImageEditGguf,
							"qwen-image-edit-2511-Q8_0.gguf",
							22_354_590_304,
							"0bf71797bf27dac40e3d8c1dc344309cb53f2a08beed6a96120dd77164b3806f",
							"diffusion_model",
						),
						QWEN_VL.q8,
						QWEN_VL.vision,
						QWEN_IMAGE_VAE,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 16 * GB,
					files: [
						file(
							REPO.qwenImageEditGguf,
							"qwen-image-edit-2511-Q4_K_M.gguf",
							12_842_830_432,
							"07951f61941a81e236cbd4a9b6f250d49626b3ba518f260135bf2e01a87cf1c8",
							"diffusion_model",
						),
						QWEN_VL.q4,
						QWEN_VL.vision,
						QWEN_IMAGE_VAE,
					],
				},
			],
			defaults: {
				// Its smallest weights (12.8 GB) are larger than a 12 GB card: it
				// runs in pieces, within a memory budget.
				vramBudget: true,
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 20,
				cfgScale: 2.5,
				sampler: "euler",
				flowShift: 3,
				references: { as: "ref", max: 3 },
				engineArgs: ["--model-args", "qwen_image_zero_cond_t=true"],
			},
			demos: [],
		},
		{
			id: "longcat-image",
			profile: {
				family: "longcat-image",
				name: "LongCat-Image",
				author: "Meituan",
				speed: 2,
				quality: 2,
				text: true,
				bestFor: ["photo", "text"],
			},
			name: "LongCat-Image",
			author: "Meituan",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"A 6B model for photorealistic images that writes the words you put in quotes, in English and Chinese.",
			...APACHE_2,
			homepage: "https://huggingface.co/meituan-longcat/LongCat-Image",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 15 * GB,
					files: [
						file(
							REPO.comfyLongCat,
							"split_files/diffusion_models/longcat_image_bf16.safetensors",
							12_541_383_144,
							"7c83c314a3d879d43e5700072033256000f46a56900ae48b209a77ac1921488b",
							"diffusion_model",
						),
						QWEN_VL.q8,
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
							REPO.longCatGguf,
							"comfy/LongCat-Image-Q8_0.gguf",
							6_705_361_120,
							"e45928b01712af742ccec57ac515d54c97ba276e6f86b825022e866ae4f329a5",
							"diffusion_model",
						),
						QWEN_VL.q8,
						SHARED.fluxVae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 6 * GB,
					files: [
						file(
							REPO.longCatGguf,
							"comfy/LongCat-Image-Q4_K_M.gguf",
							3_661_869_280,
							"8231f4f177bcb5422cd76028ce740183eda5541fc1b09f5aa6e95bd4fba6992c",
							"diffusion_model",
						),
						QWEN_VL.q4,
						SHARED.fluxVae,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 20,
				cfgScale: 5,
				sampler: "euler",
				flowShift: 3,
			},
			demos: [
				{
					url: hf(...REPO.longCat, "assets/gallery.jpeg"),
					media: "image",
					caption: "Samples from the model card",
				},
			],
		},
		{
			id: "longcat-image-edit",
			profile: {
				family: "longcat-image-edit",
				name: "LongCat-Image-Edit",
				author: "Meituan",
				speed: 2,
				quality: 2,
				text: true,
				bestFor: ["editing", "instructions"],
			},
			name: "LongCat-Image-Edit",
			author: "Meituan",
			media: "image",
			tasks: ["image-edit"],
			summary:
				"Changes a picture from written instructions in English or Chinese, leaving the parts you did not mention as they were.",
			...APACHE_2,
			homepage: "https://huggingface.co/meituan-longcat/LongCat-Image-Edit",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 15 * GB,
					files: [
						file(
							REPO.comfyLongCat,
							"split_files/diffusion_models/longcat_image_edit_bf16.safetensors",
							12_541_383_144,
							"8e65ba6ab2f6b323c1619347cd681e4ff78a017b608c82c7bf30f1d125925fab",
							"diffusion_model",
						),
						QWEN_VL.q8,
						QWEN_VL.vision,
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
							REPO.longCatEditGguf,
							"LongCat-Image-Edit-Q8_0.gguf",
							6_725_439_840,
							"a998d17d51943ab15bf3ba3ca1a509be3792987395c3bcb8d6bcbfafa7030a42",
							"diffusion_model",
						),
						QWEN_VL.q8,
						QWEN_VL.vision,
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
							REPO.longCatEditGguf,
							"LongCat-Image-Edit-Q4_K_M.gguf",
							3_867_152_736,
							"104cd11e357a43c5fab60e16e8c8517f8e6b7df596004042b507556145fd4f63",
							"diffusion_model",
						),
						QWEN_VL.q4,
						QWEN_VL.vision,
						SHARED.fluxVae,
					],
				},
			],
			defaults: {
				// On a 12 GB card its 8-bit weights (6.7 GB), the encoder and the
				// pictures it follows are about what made FLUX.2 klein and the
				// guided Z-Image Turbo run out: within a memory budget instead.
				vramBudget: true,
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 20,
				cfgScale: 4.5,
				sampler: "euler",
				flowShift: 3,
				references: { as: "ref", max: 1 },
			},
			demos: [
				{
					url: hf(...REPO.longCatEdit, "assets/image_edit_gallery.jpg"),
					media: "image",
					caption: "Edits from the model card",
				},
			],
		},
		{
			id: "longcat-image-edit-turbo",
			profile: {
				family: "longcat-image-edit-turbo",
				name: "LongCat-Image-Edit Turbo",
				author: "Meituan",
				speed: 3,
				quality: 2,
				text: true,
				bestFor: ["editing", "speed"],
			},
			name: "LongCat-Image-Edit Turbo",
			author: "Meituan",
			media: "image",
			tasks: ["image-edit"],
			summary:
				"A distilled LongCat-Image-Edit that changes a picture from written instructions in eight steps.",
			...APACHE_2,
			homepage:
				"https://huggingface.co/meituan-longcat/LongCat-Image-Edit-Turbo",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 15 * GB,
					files: [
						file(
							REPO.comfyLongCat,
							"split_files/diffusion_models/longcat_image_edit_turbo_bf16.safetensors",
							12_541_383_144,
							"985119e16854831d1f75d9d141ab4e5af4a643b35abc396593a95654e0b4cd3d",
							"diffusion_model",
						),
						QWEN_VL.q8,
						QWEN_VL.vision,
						SHARED.fluxVae,
					],
				},
			],
			defaults: {
				// Its only weights (12.5 GB) are larger than a 12 GB card: it runs
				// in pieces, within a memory budget.
				vramBudget: true,
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 8,
				cfgScale: 1,
				sampler: "euler",
				flowShift: 3,
				references: { as: "ref", max: 1 },
			},
			demos: [
				{
					url: hf(...REPO.longCatEditTurbo, "assets/image_edit_gallery.jpg"),
					media: "image",
					caption: "Edits from the model card",
				},
			],
		},
		{
			id: "ovis-image-7b",
			profile: {
				family: "ovis-image",
				name: "Ovis-Image",
				author: "AIDC-AI (Alibaba)",
				speed: 2,
				quality: 2,
				text: true,
				bestFor: ["text", "illustration"],
			},
			name: "Ovis-Image 7B",
			author: "AIDC-AI (Alibaba)",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"A 7B model made to write text inside pictures, such as posters, banners and logos, while staying small enough for one graphics card.",
			...APACHE_2,
			homepage: "https://huggingface.co/AIDC-AI/Ovis-Image-7B",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 18 * GB,
					files: [
						file(
							REPO.comfyOvis,
							"split_files/diffusion_models/ovis_image_bf16.safetensors",
							14_740_943_536,
							"eb3d9e1b201412b3b527472cf82a2c5add6b5a40a37e94d99f11c381f18a9e2b",
							"diffusion_model",
						),
						OVIS_TEXT_ENCODER,
						SHARED.fluxVae,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 11 * GB,
					files: [
						file(
							REPO.ovisGguf,
							"ovis_image-Q8_0.gguf",
							7_866_528_480,
							"df9eb46ba49c392c6acd2b5762d11b508506a8f378ea8c231d3aec65a8b9c678",
							"diffusion_model",
						),
						OVIS_TEXT_ENCODER,
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
							REPO.ovisGguf,
							"ovis_image-Q4_0.gguf",
							4_200_182_496,
							"59832ca60a34671579fdc95b48dd772c6014b793b497b4bdadf1f3017d1a0125",
							"diffusion_model",
						),
						OVIS_TEXT_ENCODER,
						SHARED.fluxVae,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 20,
				cfgScale: 5,
			},
			demos: [],
		},
	];
}
