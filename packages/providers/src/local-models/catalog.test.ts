import { describe, expect, test } from "bun:test";
import { chooseVariant, roleOption } from "@hatchlight/core";
import en from "../../../../apps/web/src/locales/en.json";
import ptBR from "../../../../apps/web/src/locales/pt-BR.json";
import { builtinLocalModels } from "./index";

const models = builtinLocalModels();
const PINNED =
	/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/\S+$/;

describe("the local models catalog", () => {
	test("ids are unique", () => {
		const ids = models.map((m) => m.id);
		expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
	});

	test("every file is pinned to a commit and has a hash and a size", () => {
		for (const model of models) {
			for (const variant of model.variants) {
				for (const file of variant.files) {
					const where = `${model.id}/${variant.id}/${file.name}`;
					expect(file.url, where).toMatch(PINNED);
					expect(file.sha256, where).toMatch(/^[0-9a-f]{64}$/);
					expect(file.size, where).toBeGreaterThan(0);
				}
			}
		}
	});

	test("every file goes to an engine option, once per variant", () => {
		for (const model of models) {
			for (const variant of model.variants) {
				const roles = variant.files.map((f) => f.role ?? "");
				const names = variant.files.map((f) => f.name);
				const where = `${model.id}/${variant.id}`;
				expect(new Set(roles).size, where).toBe(roles.length);
				expect(new Set(names).size, where).toBe(names.length);
				for (const role of roles) expect(() => roleOption(role)).not.toThrow();
			}
		}
	});

	test("a model that takes pictures says how, and one that says how takes them", () => {
		for (const model of models) {
			const takes = model.tasks.some(
				(t) =>
					t === "image-edit" ||
					t === "image-to-video" ||
					t === "image-to-image" ||
					t === "upscale",
			);
			expect(Boolean(model.defaults.references), model.id).toBe(takes);
			// Redrawing and animating start from the picture; editing follows it.
			if (
				model.tasks.includes("image-to-video") ||
				model.tasks.includes("image-to-image") ||
				model.tasks.includes("upscale")
			) {
				expect(model.defaults.references?.as, model.id).toBe("init");
			}
		}
	});

	test("tasks match the media", () => {
		for (const model of models) {
			const video = model.tasks.some((t) => t.endsWith("video"));
			expect(model.media === "video", model.id).toBe(video);
			expect(model.tasks.length, model.id).toBeGreaterThan(0);
		}
	});

	test("variants come best first and need more memory than they download", () => {
		for (const model of models) {
			expect(model.variants.length, model.id).toBeGreaterThan(0);
			const memory = model.variants.map((v) => v.memoryBytes);
			expect(memory, model.id).toEqual(memory.toSorted((a, b) => b - a));
			// Weights converted while loading (`--type`) can take less than the file.
			if (model.defaults.engineArgs?.includes("--type")) continue;
			for (const variant of model.variants) {
				const diffusion = variant.files.find(
					(f) => f.role === "diffusion_model" || f.role === "model",
				);
				expect(
					variant.memoryBytes,
					`${model.id}/${variant.id}`,
				).toBeGreaterThan(diffusion?.size ?? 0);
			}
		}
	});

	test("every model links its license and says what paid work it allows", () => {
		for (const model of models) {
			expect(model.licenseUrl, model.id).toStartWith("https://");
			expect(model.homepage, model.id).toStartWith("https://");
			expect(["allowed", "limited", "none"]).toContain(model.commercial.kind);
		}
	});

	test("the app says every model's summary, in English and Portuguese", () => {
		const catalogs = [en, ptBR] as Record<string, unknown>[];
		for (const model of models) {
			const key = `models.summary.${model.id}`;
			expect((en as Record<string, unknown>)[key], key).toBe(model.summary);
			for (const catalog of catalogs) expect(catalog[key], key).toBeString();
		}
	});
});

describe("Z-Image Turbo, guided", () => {
	const plain = models.find((m) => m.id === "z-image-turbo");
	const guided = models.find((m) => m.id === "z-image-turbo-guided");

	test("adds only the control file to Z-Image Turbo's, pinned and hashed", () => {
		expect(guided?.variants.map((v) => v.id)).toEqual(["q8", "q4"]);
		for (const variant of guided?.variants ?? []) {
			const same = plain?.variants.find((v) => v.id === variant.id);
			// Files with the same hash are stored once: only one is new.
			const shared = variant.files.filter((f) =>
				same?.files.some((o) => o.sha256 === f.sha256 && o.size === f.size),
			);
			expect(shared).toEqual(same?.files ?? []);
			const added = variant.files.filter((f) => !shared.includes(f));
			expect(added).toEqual([
				{
					name: "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors",
					url: "https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1/resolve/5155fc56d17821007d6f62ac192c09e0f0e72016/Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors",
					size: 2_016_627_488,
					sha256:
						"3ea098db9bd145be525c7e2366920b6d76c5ffd46b3d7aa8169bbc943fdaee35",
					role: "control_net",
				},
			]);
			expect(roleOption("control_net")).toBe("--control-net");
			expect(variant.memoryBytes).toBeGreaterThan(same?.memoryBytes ?? 0);
		}
	});

	test("follows outlines it finds, and pose or depth from a map", () => {
		expect(guided?.defaults.guide).toEqual({
			kinds: ["outlines", "pose", "depth"],
			makesMaps: ["outlines"],
			strength: 0.75,
		});
		// Its weights are Apache 2.0, like Z-Image Turbo's.
		expect(guided?.license).toBe("Apache 2.0");
		expect(guided?.commercial).toEqual({ kind: "allowed" });
		expect(plain?.defaults.guide).toBeUndefined();
	});
});

describe("variants chosen for a card", () => {
	test("FLUX.2 klein is 8-bit on a 12 GB card: 16-bit runs out when editing", () => {
		const gpu = {
			vendor: "nvidia" as const,
			name: "RTX 4070 SUPER",
			memoryBytes: 12_282 * 2 ** 20,
		};
		const hardware = {
			os: "win32" as const,
			arch: "x64" as const,
			wsl: false,
			memoryBytes: 32 * 2 ** 30,
			gpus: [gpu],
		};
		for (const id of ["flux-2-klein-4b", "flux-2-klein-base-4b"]) {
			const model = models.find((m) => m.id === id);
			const choice = chooseVariant(model?.variants ?? [], hardware, () => ({
				build: {} as never,
				gpu,
				throughWindows: false,
			}));
			expect(choice?.variant.id).toBe("q8");
			expect(choice?.fit).toBe("gpu");
			// A 24 GB card keeps the 16-bit one.
			const big = { ...gpu, memoryBytes: 24 * 2 ** 30 };
			const roomy = chooseVariant(
				model?.variants ?? [],
				{ ...hardware, gpus: [big] },
				() => ({ build: {} as never, gpu: big, throughWindows: false }),
			);
			expect(roomy?.variant.id).toBe("bf16");
		}
	});
});
