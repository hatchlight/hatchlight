import type { LocalModelFile, LocalModelSpec } from "@hatchlight/core";
import { QWEN_VL } from "./qwen";
import { APACHE_2, file, GB, type Repo, SHARED } from "./shared";

/** Qwen's own GGUF builds of Qwen3-VL, at the revision each is pinned to. */
const QWEN3_VL_REPO = {
	small: [
		"Qwen/Qwen3-VL-4B-Instruct-GGUF",
		"1cd86afb9a95c410a6038ab3b40d8b578c892266",
	],
	large: [
		"Qwen/Qwen3-VL-8B-Instruct-GGUF",
		"f982a07559d4a2f6c8744d840bf6fccab30eea96",
	],
} as const satisfies Record<string, Repo>;

const QWEN3_VL_4B = {
	q8: file(
		QWEN3_VL_REPO.small,
		"Qwen3VL-4B-Instruct-Q8_0.gguf",
		4_280_406_144,
		"054721f478bc5fa6beffb7f38eae575d45298f88cbb8d2f83ef675a727863eb1",
		"model",
	),
	q4: file(
		QWEN3_VL_REPO.small,
		"Qwen3VL-4B-Instruct-Q4_K_M.gguf",
		2_497_281_664,
		"66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a",
		"model",
	),
	vision: file(
		QWEN3_VL_REPO.small,
		"mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",
		453_974_304,
		"30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d",
		"llm_vision",
	),
};

const QWEN3_VL_8B = {
	q4: file(
		QWEN3_VL_REPO.large,
		"Qwen3VL-8B-Instruct-Q4_K_M.gguf",
		5_027_784_800,
		"67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
		"model",
	),
	vision: file(
		QWEN3_VL_REPO.large,
		"mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",
		752_289_728,
		"c6ba85508d82f42590e6eb77d5340369ab6fecf107a7561d809523d8aa5f3bfd",
		"llm_vision",
	),
};

/** One of Z-Image's files, as the model the translator runs. */
const asModel = (file: LocalModelFile): LocalModelFile => ({
	...file,
	role: "model",
});

/**
 * Models that help the others rather than make pictures: set up in
 * Settings, never offered for generating.
 */
export function textModels(): LocalModelSpec[] {
	return [
		{
			// Smaller ones (Qwen2.5 1.5B, Qwen3 1.7B) were tried: they turned
			// "laranja" into "yellow", "roxos" into "red", "romãs" into
			// "oranges". This one gets colors and most words right.
			id: "qwen3-4b-instruct",
			name: "Qwen3 4B Instruct",
			author: "Qwen (Alibaba)",
			media: "text",
			tasks: ["prompt-translation"],
			summary:
				"A language model that puts prompts into English, for the models that read only English. It runs on the processor, in a few seconds per prompt, and is the same file Z-Image reads prompts with: with Z-Image installed, nothing more is downloaded.",
			...APACHE_2,
			homepage: "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "llama-cpp",
					// In the computer's memory: it runs on the processor.
					memoryBytes: 6 * GB,
					files: [asModel(SHARED.qwen3InstructQ8)],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "llama-cpp",
					memoryBytes: 4 * GB,
					files: [asModel(SHARED.qwen3InstructQ4)],
				},
			],
			// A text model makes no pictures: these are never read.
			defaults: { size: 0, aspectRatios: [], steps: 0, cfgScale: 0 },
			demos: [],
		},
		{
			// It sees well but calls tools badly (the same call seven times,
			// model names for ids), so the assistant on this computer keeps
			// thinking with Qwen3 4B and asks this one what pictures show.
			id: "qwen2.5-vl-7b",
			name: "Qwen2.5-VL 7B Instruct",
			author: "Qwen (Alibaba)",
			media: "text",
			tasks: ["picture-description"],
			summary:
				"A language model that looks at pictures, so the assistant on this computer can tell whether what it made matches what was asked. It runs on the processor, about half a minute per picture. Qwen-Image and LongCat-Image read prompts with the same file.",
			...APACHE_2,
			homepage: "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct",
			variants: [
				{
					// 4-bit only: on the processor, 8-bit doubles the wait.
					id: "q4",
					label: "4-bit",
					engine: "llama-cpp",
					// In the computer's memory: it runs on the processor.
					memoryBytes: 7 * GB,
					files: [
						{ ...QWEN_VL.q4, role: "model" },
						{ ...QWEN_VL.vision, role: "llm_vision" },
					],
				},
			],
			defaults: { size: 0, aspectRatios: [], steps: 0, cfgScale: 0 },
			demos: [],
		},
		{
			// Newer than Qwen2.5-VL and in Qwen's own builds. Listed after it,
			// so what looks at pictures by default does not change for those
			// who have Qwen2.5-VL already.
			id: "qwen3-vl-8b",
			name: "Qwen3-VL 8B Instruct",
			author: "Qwen (Alibaba)",
			media: "text",
			tasks: ["picture-description"],
			summary:
				"A newer language model that looks at pictures, for the assistant on this computer and for captions of training pictures. It runs on the processor, about half a minute per picture.",
			...APACHE_2,
			homepage: "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct",
			variants: [
				{
					id: "q4",
					label: "4-bit",
					engine: "llama-cpp",
					// In the computer's memory: it runs on the processor.
					memoryBytes: 7 * GB,
					files: [QWEN3_VL_8B.q4, QWEN3_VL_8B.vision],
				},
			],
			defaults: { size: 0, aspectRatios: [], steps: 0, cfgScale: 0 },
			demos: [],
		},
		{
			id: "qwen3-vl-4b",
			name: "Qwen3-VL 4B Instruct",
			author: "Qwen (Alibaba)",
			media: "text",
			tasks: ["picture-description"],
			summary:
				"A small language model that looks at pictures: the lightest download for the assistant on this computer to see what it made. It runs on the processor, in less time per picture than the larger ones.",
			...APACHE_2,
			homepage: "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "llama-cpp",
					memoryBytes: 6 * GB,
					files: [QWEN3_VL_4B.q8, QWEN3_VL_4B.vision],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "llama-cpp",
					memoryBytes: 4 * GB,
					files: [QWEN3_VL_4B.q4, QWEN3_VL_4B.vision],
				},
			],
			defaults: { size: 0, aspectRatios: [], steps: 0, cfgScale: 0 },
			demos: [],
		},
	];
}
