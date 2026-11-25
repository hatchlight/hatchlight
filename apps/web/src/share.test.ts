import { describe, expect, test } from "bun:test";
import type { Ranking } from "@hatchlight/core/types";
import { createTranslator } from "@hatchlight/i18n";
import en from "./locales/en.json";
import ptBR from "./locales/pt-BR.json";
import { rankingMarkdown, rankRows } from "./share";

const RANKING: Ranking = {
	comparisons: 6,
	minComparisons: 5,
	models: [
		{
			modelId: "local/flux",
			name: "FLUX | schnell",
			media: "image",
			comparisons: 6,
			wins: 4,
			winRate: 4 / 6,
			score: 0.3,
			few: false,
			msPerOutput: 4200,
			usdPerOutput: 0,
			exampleAssetId: "ast_secret",
		},
		{
			modelId: "fal/x",
			name: "X",
			media: "image",
			comparisons: 2,
			wins: 2,
			winRate: 1,
			score: 0.2,
			few: true,
			msPerOutput: null,
			usdPerOutput: 0.04,
			exampleAssetId: null,
		},
	],
};
const facts = { gpu: "RTX 4070", date: Date.UTC(2026, 10, 25), filters: "All" };

describe("a shared ranking", () => {
	test("is a Markdown table of names and numbers, the GPU and the date", () => {
		const t = createTranslator("en", en);
		const markdown = rankingMarkdown(t, RANKING, facts);
		expect(markdown).toContain("## Models I prefer");
		expect(markdown).toContain("RTX 4070 · Nov 25, 2026 · All");
		expect(markdown).toContain(
			"| 1 | FLUX \\| schnell | 4 of 6 | 67% | 4.2s | Free |",
		);
		expect(markdown).toContain(
			"| 2 | X (Few comparisons) | 2 of 2 | 100% | — | $0.040 |",
		);
		expect(markdown).not.toContain("ast_");
	});

	test("is in the reader's language", () => {
		const t = createTranslator("pt-BR", en, ptBR);
		const [row] = rankRows(t, RANKING);
		expect(row).toMatchObject({ wins: "4 de 6", cost: "Grátis" });
		expect(rankingMarkdown(t, RANKING, { ...facts, gpu: null })).toContain(
			"Sem GPU",
		);
	});
});
