import type { ModelProfile, ProviderAdapter } from "@hatchlight/core";

/**
 * How models compare, so people can choose one without knowing model names.
 * Speed and quality are relative to other models of the same media, judged
 * from each model's documentation and the project's own runs; adjust them
 * when experience says otherwise.
 *
 * `sample` names a picture of the shared comparison prompt ("a red fox
 * curled up in fresh snow, soft morning light") in `apps/web/public/samples`.
 */
export const PROFILES = {
	sdxlTurbo: {
		family: "sdxl-turbo",
		name: "SDXL Turbo",
		author: "Stability AI",
		speed: 3,
		quality: 1,
		text: false,
		bestFor: ["speed", "drafts"],
		sample: "sdxl-turbo.webp",
	},
	sdxl: {
		family: "sdxl",
		name: "Stable Diffusion XL",
		author: "Stability AI",
		speed: 1,
		quality: 2,
		text: false,
		bestFor: ["illustration"],
		sample: "sdxl.webp",
	},
	fluxSchnell: {
		family: "flux-schnell",
		name: "FLUX.1 schnell",
		author: "Black Forest Labs",
		speed: 2,
		quality: 2,
		text: true,
		bestFor: ["photo", "text"],
		sample: "flux-schnell.webp",
	},
	fluxPro: {
		family: "flux-pro",
		name: "FLUX",
		author: "Black Forest Labs",
		speed: 2,
		quality: 3,
		text: true,
		bestFor: ["photo", "detail"],
	},
	zImage: {
		family: "z-image-turbo",
		name: "Z-Image Turbo",
		author: "Tongyi-MAI",
		speed: 2,
		quality: 3,
		text: true,
		bestFor: ["photo"],
		sample: "z-image-turbo.webp",
	},
	zImageGuided: {
		family: "z-image-turbo-guided",
		name: "Z-Image Turbo, guided",
		author: "Tongyi-MAI",
		speed: 2,
		quality: 3,
		text: true,
		bestFor: ["photo"],
	},
	nanoBanana: {
		family: "nano-banana",
		name: "Nano Banana",
		author: "Google",
		speed: 2,
		quality: 3,
		text: true,
		bestFor: ["editing", "text"],
	},
	nanoBananaPro: {
		family: "nano-banana-pro",
		name: "Nano Banana Pro",
		author: "Google",
		speed: 1,
		quality: 3,
		text: true,
		bestFor: ["text", "detail"],
	},
	ideogramCharacter: {
		family: "ideogram-character",
		name: "Ideogram Character",
		author: "Ideogram",
		speed: 2,
		quality: 3,
		text: true,
		bestFor: ["photo", "illustration"],
	},
	gptImage: {
		family: "gpt-image",
		name: "GPT Image",
		author: "OpenAI",
		speed: 1,
		quality: 3,
		text: true,
		bestFor: ["instructions", "text"],
	},
	seedream: {
		family: "seedream",
		name: "Seedream",
		author: "ByteDance",
		speed: 2,
		quality: 3,
		text: true,
		bestFor: ["photo", "detail"],
	},
	qwenImage: {
		family: "qwen-image",
		name: "Qwen Image",
		author: "Alibaba",
		speed: 2,
		quality: 3,
		text: true,
		bestFor: ["text", "illustration"],
	},
	veo: {
		family: "veo",
		name: "Veo",
		author: "Google",
		speed: 2,
		quality: 3,
		text: false,
		bestFor: ["cinema", "sound"],
	},
	kling: {
		family: "kling",
		name: "Kling",
		author: "Kuaishou",
		speed: 2,
		quality: 3,
		text: false,
		bestFor: ["motion"],
	},
	hailuo: {
		family: "hailuo",
		name: "Hailuo",
		author: "MiniMax",
		speed: 2,
		quality: 2,
		text: false,
		bestFor: ["motion"],
	},
	wanCloud: {
		family: "wan",
		name: "Wan",
		author: "Alibaba",
		speed: 2,
		quality: 2,
		text: false,
		bestFor: ["motion"],
	},
	runway: {
		family: "runway",
		name: "Runway",
		author: "Runway",
		speed: 2,
		quality: 3,
		text: false,
		bestFor: ["cinema"],
	},
	wanLocal: {
		family: "wan-local",
		name: "Wan 2.1",
		author: "Alibaba",
		speed: 1,
		quality: 1,
		text: false,
		bestFor: ["motion"],
	},
} satisfies Record<string, ModelProfile>;

/** Each cloud model, by its id, and the family it belongs to. */
const CLOUD: Record<string, ModelProfile> = {
	"fal/fal-ai/flux/schnell": PROFILES.fluxSchnell,
	"replicate/black-forest-labs/flux-schnell": PROFILES.fluxSchnell,
	"fal/fal-ai/flux/dev": PROFILES.fluxPro,
	"replicate/black-forest-labs/flux-1.1-pro": PROFILES.fluxPro,
	"openrouter/black-forest-labs/flux-3-image": PROFILES.fluxPro,
	"fal/fal-ai/nano-banana": PROFILES.nanoBanana,
	"fal/fal-ai/z-image/turbo": PROFILES.zImage,
	"fal/fal-ai/ideogram/character": PROFILES.ideogramCharacter,
	"google/gemini-2.5-flash-image": PROFILES.nanoBanana,
	"openrouter/google/gemini-nano-banana-2.1": PROFILES.nanoBanana,
	"google/gemini-3-pro-image": PROFILES.nanoBananaPro,
	"openai/gpt-image-2.5-sunburst": PROFILES.gptImage,
	"openai/gpt-image-2.5-flare": PROFILES.gptImage,
	"openai/gpt-image-2": PROFILES.gptImage,
	"openrouter/openai/gpt-image-2.6-sunburst": PROFILES.gptImage,
	"openrouter/openai/gpt-image-2.6-flare": PROFILES.gptImage,
	"openrouter/bytedance-seed/seedream-5-5": PROFILES.seedream,
	"openrouter/qwen/qwen-image-3-pro": PROFILES.qwenImage,
	"fal/fal-ai/veo3.1/fast": PROFILES.veo,
	"fal/fal-ai/veo3": PROFILES.veo,
	"replicate/google/veo-3.1-fast": PROFILES.veo,
	"openrouter/google/veo-3.1-fast": PROFILES.veo,
	"openrouter/google/veo-3.1-lite": PROFILES.veo,
	"fal/fal-ai/kling-video/v2.5-turbo/pro/text-to-video": PROFILES.kling,
	"fal/kling/v4/text-to-video": PROFILES.kling,
	"replicate/kwaivgi/kling-v2.5-turbo-pro": PROFILES.kling,
	"openrouter/kwaivgi/kling-v3.0-std": PROFILES.kling,
	"fal/minimax/h3/text-to-video": PROFILES.hailuo,
	"replicate/minimax/hailuo-02": PROFILES.hailuo,
	"openrouter/minimax/hailuo-3": PROFILES.hailuo,
	"fal/alibaba/wan-3.0/text-to-video": PROFILES.wanCloud,
	"replicate/wan-video/wan-2.2-t2v-fast": PROFILES.wanCloud,
	"openrouter/alibaba/wan-3.0": PROFILES.wanCloud,
	"openrouter/runway/gen-4.5": PROFILES.runway,
};

/** The ids of the cloud models that have a profile. */
export function profiledModelIds(): string[] {
	return Object.keys(CLOUD);
}

export function profileFor(modelId: string): ModelProfile | undefined {
	return CLOUD[modelId];
}

/** Makes `adapter` list its models with their profiles. */
export function withProfiles(adapter: ProviderAdapter): ProviderAdapter {
	const list = adapter.listModels.bind(adapter);
	adapter.listModels = () =>
		list().map((model) => {
			const profile = model.profile ?? profileFor(model.id);
			return profile ? { ...model, profile } : model;
		});
	return adapter;
}
