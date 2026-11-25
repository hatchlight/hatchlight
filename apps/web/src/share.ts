import type { Ranking } from "@hatchlight/core/types";
import { duration, usd } from "./format";
import type { I18n } from "./i18n";

type Formatter = Pick<I18n, "t" | "number" | "date">;

/** One model of a ranking as it is shown: words and numbers, nothing else. */
export interface RankRow {
	name: string;
	wins: string;
	rate: string;
	time: string;
	cost: string;
	few: boolean;
}

export function rankRows(i18n: Formatter, ranking: Ranking): RankRow[] {
	const { t, number } = i18n;
	return ranking.models.map((m) => ({
		name: m.name,
		wins: t("ranking.winsOf", { wins: m.wins, comparisons: m.comparisons }),
		rate: number(m.winRate, { style: "percent" }),
		time:
			m.msPerOutput == null ? t("ranking.none") : duration(i18n, m.msPerOutput),
		cost:
			m.usdPerOutput == null
				? t("ranking.none")
				: m.usdPerOutput === 0
					? t("picker.free")
					: usd(i18n, m.usdPerOutput),
		few: m.few,
	}));
}

/** What a shared ranking says it is about: the computer, the day, the filters. */
export interface ShareFacts {
	gpu: string | null;
	date: number;
	/** The filters chosen, in words. */
	filters: string;
}

/** A line under the title: on which computer, when, and of what. */
export function shareSubtitle(i18n: Formatter, facts: ShareFacts): string {
	return [
		facts.gpu ?? i18n.t("ranking.noGpu"),
		i18n.date(facts.date, { dateStyle: "medium" }),
		facts.filters,
	].join(" · ");
}

/** A Markdown cell: pipes and line breaks would end it early. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ");

/**
 * The ranking as a Markdown table, to paste anywhere. Only model names and
 * numbers, the GPU and the date: never prompts or pictures.
 */
export function rankingMarkdown(
	i18n: Formatter,
	ranking: Ranking,
	facts: ShareFacts,
): string {
	const { t } = i18n;
	const header = [
		t("ranking.rank"),
		t("ranking.model"),
		t("ranking.wins"),
		t("ranking.winRate"),
		t("ranking.time"),
		t("ranking.cost"),
	];
	const rows = rankRows(i18n, ranking).map((row, i) => [
		i18n.number(i + 1),
		row.few ? `${row.name} (${t("ranking.few")})` : row.name,
		row.wins,
		row.rate,
		row.time,
		row.cost,
	]);
	return [
		`## ${t("ranking.shareTitle")}`,
		"",
		shareSubtitle(i18n, facts),
		"",
		`| ${header.map(cell).join(" | ")} |`,
		`|${header.map(() => " --- ").join("|")}|`,
		...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
		"",
		t("ranking.sortNote", { count: ranking.minComparisons }),
		"",
	].join("\n");
}
