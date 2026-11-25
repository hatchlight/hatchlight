import { expect, test } from "bun:test";
import type { ProviderAdapter } from "@hatchlight/core";

/** Checks every adapter must pass. Call from the adapter's test file. */
export function providerContract(adapter: ProviderAdapter): void {
	test(`${adapter.id}: models are well-formed`, () => {
		const models = adapter.listModels();
		expect(models.length).toBeGreaterThan(0);
		expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
		for (const model of models) {
			expect(model.id).toBe(`${adapter.id}/${model.providerModelId}`);
			expect(model.providerId).toBe(adapter.id);
			expect(model.name).not.toBe("");
			// Only a model that needs a picture makes nothing from words.
			expect(model.operations.includes("generate")).toBe(
				!model.capabilities.needsReference,
			);
			expect(model.capabilities.maxCount).toBeGreaterThanOrEqual(1);
			expect(model.operations.includes("edit")).toBe(
				model.capabilities.maxReferenceImages > 0,
			);
			for (const ratio of model.capabilities.aspectRatios) {
				expect(ratio).toMatch(/^\d+:\d+$/);
			}
		}
	});

	test(`${adapter.id}: a key requirement names its environment variable`, () => {
		if (adapter.requiresKey) expect(adapter.keyEnv).toMatch(/^[A-Z_]+$/);
	});
}
