import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES } from "@hatchlight/core/errors";
import { checkCatalog } from "@hatchlight/i18n";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import ptBR from "./locales/pt-BR.json";

const sourceDir = import.meta.dir;

/** Every key the app's source passes to `t("...")`. */
function usedKeys(): Set<string> {
	const keys = new Set<string>();
	const files = readdirSync(sourceDir, { recursive: true, encoding: "utf8" });
	for (const file of files) {
		if (!/\.tsx?$/.test(file) || file.endsWith(".test.ts")) continue;
		const text = readFileSync(join(sourceDir, file), "utf8");
		for (const match of text.matchAll(/\bt\(\s*"([^"]+)"/g)) {
			keys.add(match[1] as string);
		}
	}
	return keys;
}

describe("catalogs", () => {
	test("the Portuguese catalog matches the English one", () => {
		expect(checkCatalog(en, ptBR)).toEqual([]);
	});

	test("the French catalog matches the English one", () => {
		expect(checkCatalog(en, fr)).toEqual([]);
	});

	test("every key the app uses exists in English", () => {
		const missing = [...usedKeys()].filter((key) => !(key in en));
		expect(missing).toEqual([]);
	});

	test("every English key is used by the app", () => {
		const used = usedKeys();
		// Errors and progress stages are looked up by the code the server sends,
		// and model summaries by the model's id.
		const byCode = (key: string) =>
			key.startsWith("errors.") ||
			key.startsWith("progress.") ||
			key.startsWith("models.summary.");
		const unused = Object.keys(en).filter(
			(key) => !used.has(key) && !byCode(key),
		);
		expect(unused).toEqual([]);
	});

	test("every error the server can send has a message", () => {
		const missing = ERROR_CODES.filter((code) => !(`errors.${code}` in en));
		expect(missing).toEqual([]);
		const unknown = Object.keys(en)
			.filter((key) => key.startsWith("errors."))
			.filter(
				(key) => !(ERROR_CODES as readonly string[]).includes(key.slice(7)),
			);
		expect(unknown).toEqual([]);
	});

	test("every progress stage has a message", () => {
		const stages = [
			"queued",
			"queuedAt",
			"retrying",
			"translating",
			"waitingGpu",
			"starting",
			"loading",
			"lowMemory",
			"generating",
		];
		expect(stages.filter((stage) => !(`progress.${stage}` in en))).toEqual([]);
	});
});
