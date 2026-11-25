import type {
	Media,
	PromptKind,
	Ranking as RankingData,
	RankingPeriod,
} from "@hatchlight/core/types";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCopy, ImageDown } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, assetUrl } from "./api";
import { type I18n, useI18n } from "./i18n";
import { PageHeader } from "./Models";
import {
	type RankRow,
	rankingMarkdown,
	rankRows,
	type ShareFacts,
	shareSubtitle,
} from "./share";
import { LABEL, SECTION } from "./Training";

const CHOICE =
	"h-10 rounded-xl px-3.5 aria-pressed:border-transparent aria-pressed:bg-ink aria-pressed:text-bg";

type KindChoice = PromptKind | "all";

function kindNames(t: I18n["t"]): Record<KindChoice, string> {
	return {
		all: t("ranking.kind.all"),
		portrait: t("ranking.kind.portrait"),
		landscape: t("ranking.kind.landscape"),
		text: t("ranking.kind.text"),
		product: t("ranking.kind.product"),
		illustration: t("ranking.kind.illustration"),
		photo: t("ranking.kind.photo"),
		editing: t("ranking.kind.editing"),
	};
}

/** Loads a picture to draw, or null when it cannot be had. */
function loadImage(src: string): Promise<HTMLImageElement | null> {
	return new Promise((done) => {
		const image = new Image();
		image.onload = () => done(image);
		image.onerror = () => done(null);
		image.src = src;
	});
}

/** Draws a picture filling a square, cut to fit, with round corners. */
function drawCover(
	ctx: CanvasRenderingContext2D,
	image: HTMLImageElement,
	x: number,
	y: number,
	side: number,
) {
	const scale = Math.max(side / image.width, side / image.height);
	const w = side / scale;
	const h = side / scale;
	ctx.save();
	ctx.beginPath();
	ctx.roundRect(x, y, side, side, 14);
	ctx.clip();
	ctx.drawImage(
		image,
		(image.width - w) / 2,
		(image.height - h) / 2,
		w,
		h,
		x,
		y,
		side,
		side,
	);
	ctx.restore();
}

/**
 * The ranking as a picture to share: model names, numbers, the GPU and the
 * date, and the person's picked pictures only when they asked for them.
 */
async function rankingCard(
	i18n: I18n,
	ranking: RankingData,
	facts: ShareFacts,
	examples: boolean,
): Promise<Blob | null> {
	const { t } = i18n;
	const rows = rankRows(i18n, ranking).slice(0, 10);
	const pictures = examples
		? await Promise.all(
				ranking.models
					.slice(0, 10)
					.map((m) =>
						m.exampleAssetId
							? loadImage(assetUrl(m.exampleAssetId))
							: Promise.resolve(null),
					),
			)
		: [];
	const style = getComputedStyle(document.documentElement);
	const color = (name: string) => style.getPropertyValue(name).trim();
	const sans = style.getPropertyValue("--font-sans").trim() || "sans-serif";
	const display = style.getPropertyValue("--font-display").trim() || sans;
	const mono = style.getPropertyValue("--font-mono").trim() || "monospace";

	const width = 1200;
	const rowHeight = examples ? 112 : 72;
	const top = 220;
	const height = top + rows.length * rowHeight + 110;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;

	ctx.fillStyle = color("--bg") || "#09090b";
	ctx.fillRect(0, 0, width, height);
	const aurora = ctx.createLinearGradient(0, 0, width, 0);
	aurora.addColorStop(0, color("--pink") || "#ff3d8b");
	aurora.addColorStop(0.55, color("--orange") || "#ff8a3d");
	aurora.addColorStop(1, color("--gold") || "#ffc861");
	ctx.fillStyle = aurora;
	ctx.fillRect(0, 0, width, 8);

	ctx.textBaseline = "alphabetic";
	ctx.fillStyle = color("--ink") || "#fafafa";
	ctx.font = `800 56px ${display}`;
	ctx.fillText(t("ranking.shareTitle"), 64, 116);
	ctx.fillStyle = color("--dim") || "#8b8b94";
	ctx.font = `500 24px ${sans}`;
	ctx.fillText(shareSubtitle(i18n, facts), 64, 162);

	const columns = { rate: 700, time: 860, cost: 1000 };
	// Each heading kept within its column, however long it is translated.
	ctx.font = `500 14px ${mono}`;
	for (const [key, x, end] of [
		["ranking.winRate", columns.rate, columns.time],
		["ranking.time", columns.time, columns.cost],
		["ranking.cost", columns.cost, width - 64],
	] as const) {
		ctx.fillText(
			t(key).toLocaleUpperCase(i18n.locale),
			x,
			top - 16,
			end - x - 16,
		);
	}

	rows.forEach((row: RankRow, i) => {
		const y = top + i * rowHeight;
		const middle = y + rowHeight / 2;
		ctx.fillStyle = color("--line") || "#27272a";
		ctx.fillRect(64, y, width - 128, 1);
		let x = 64;
		ctx.fillStyle = color("--dim") || "#8b8b94";
		ctx.font = `600 22px ${mono}`;
		ctx.fillText(i18n.number(i + 1), x, middle + 8);
		x += 52;
		const picture = pictures[i];
		if (examples) {
			if (picture) drawCover(ctx, picture, x, y + 12, rowHeight - 24);
			x += rowHeight;
		}
		ctx.fillStyle = color("--ink") || "#fafafa";
		ctx.font = `700 28px ${sans}`;
		ctx.fillText(row.name, x, middle - 2, columns.rate - x - 24);
		ctx.fillStyle = color("--dim") || "#8b8b94";
		ctx.font = `500 18px ${sans}`;
		ctx.fillText(
			row.few ? `${row.wins} · ${t("ranking.few")}` : row.wins,
			x,
			middle + 26,
			columns.rate - x - 24,
		);
		ctx.fillStyle = color("--ink") || "#fafafa";
		ctx.font = `600 26px ${mono}`;
		ctx.fillText(row.rate, columns.rate, middle + 9);
		ctx.font = `500 22px ${mono}`;
		ctx.fillText(row.time, columns.time, middle + 8);
		ctx.fillText(row.cost, columns.cost, middle + 8, width - 64 - columns.cost);
	});

	ctx.fillStyle = color("--dim") || "#8b8b94";
	ctx.font = `500 18px ${sans}`;
	ctx.fillText(
		t("ranking.sortNote", { count: ranking.minComparisons }),
		64,
		height - 64,
		width - 128 - 160,
	);
	ctx.fillStyle = color("--ink") || "#fafafa";
	ctx.font = `700 22px ${display}`;
	ctx.textAlign = "right";
	ctx.fillText("Hatchlight", width - 64, height - 64);

	return new Promise((done) => canvas.toBlob(done, "image/png"));
}

function download(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** How the models a person compared rank by the results they picked. */
export function Ranking() {
	const i18n = useI18n();
	const { t } = i18n;
	const id = useId();
	const [media, setMedia] = useState<Media>("image");
	const [period, setPeriod] = useState<RankingPeriod>("all");
	const [kind, setKind] = useState<KindChoice>("all");
	const [examples, setExamples] = useState(false);
	const [copied, setCopied] = useState(false);
	// The Markdown to copy by hand when the clipboard cannot be written.
	const [manual, setManual] = useState<string | null>(null);
	const [drawing, setDrawing] = useState(false);
	const ranking = useQuery({
		queryKey: ["ranking", media, period, kind],
		queryFn: () =>
			api.ranking({
				media,
				period,
				kind: kind === "all" ? undefined : kind,
			}),
	});
	// The GPU the times were measured on, for what is shared.
	const machine = useQuery({
		queryKey: ["local-models"],
		queryFn: api.localModels,
	});
	const gpu =
		machine.data?.hardware.gpus.toSorted(
			(a, b) => b.memoryBytes - a.memoryBytes,
		)[0]?.name ?? null;
	const kinds = kindNames(t);
	const facts = (): ShareFacts => ({
		gpu,
		date: Date.now(),
		filters: [
			media === "image" ? t("ranking.images") : t("ranking.videos"),
			period === "30d" ? t("ranking.last30") : t("ranking.allTime"),
			kinds[kind],
		].join(" · "),
	});
	const data = ranking.data;
	const rows = data ? rankRows(i18n, data) : [];

	const copy = () => {
		if (!data) return;
		const markdown = rankingMarkdown(i18n, data, facts());
		// Browsers keep the clipboard from pages on plain http, such as a
		// server reached by its address: the text is then shown to copy.
		if (!navigator.clipboard) {
			setManual(markdown);
			return;
		}
		navigator.clipboard.writeText(markdown).then(
			() => {
				setManual(null);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			},
			() => setManual(markdown),
		);
	};
	const save = async () => {
		if (!data) return;
		setDrawing(true);
		try {
			const blob = await rankingCard(i18n, data, facts(), examples);
			if (blob) download(blob, "hatchlight-ranking.png");
		} finally {
			setDrawing(false);
		}
	};

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-[1060px] flex-col gap-6 px-4 py-8 sm:px-8 sm:py-12">
				<PageHeader
					eyebrow={t("ranking.eyebrow")}
					title={t("ranking.title")}
					intro={t("ranking.intro")}
				/>
				<Card className={SECTION}>
					<CardContent className="flex flex-wrap items-end gap-x-6 gap-y-4">
						<div className="flex flex-col gap-2">
							<span id={`${id}-media`} className={LABEL}>
								{t("ranking.media")}
							</span>
							<ToggleGroup
								aria-labelledby={`${id}-media`}
								value={[media]}
								onValueChange={([which]) => {
									if (which === "image" || which === "video") setMedia(which);
								}}
							>
								<ToggleGroupItem
									value="image"
									variant="outline"
									className={CHOICE}
								>
									{t("ranking.images")}
								</ToggleGroupItem>
								<ToggleGroupItem
									value="video"
									variant="outline"
									className={CHOICE}
								>
									{t("ranking.videos")}
								</ToggleGroupItem>
							</ToggleGroup>
						</div>
						<div className="flex flex-col gap-2">
							<span id={`${id}-period`} className={LABEL}>
								{t("ranking.period")}
							</span>
							<ToggleGroup
								aria-labelledby={`${id}-period`}
								value={[period]}
								onValueChange={([which]) => {
									if (which === "30d" || which === "all") setPeriod(which);
								}}
							>
								<ToggleGroupItem
									value="30d"
									variant="outline"
									className={CHOICE}
								>
									{t("ranking.last30")}
								</ToggleGroupItem>
								<ToggleGroupItem
									value="all"
									variant="outline"
									className={CHOICE}
								>
									{t("ranking.allTime")}
								</ToggleGroupItem>
							</ToggleGroup>
						</div>
						<div className="flex flex-col gap-2">
							<label htmlFor={`${id}-kind`} className={LABEL}>
								{t("ranking.kind")}
							</label>
							<Select
								items={Object.entries(kinds).map(([value, label]) => ({
									value,
									label,
								}))}
								value={kind}
								onValueChange={(next: string | null) => {
									if (next && next in kinds) setKind(next as KindChoice);
								}}
							>
								<SelectTrigger
									id={`${id}-kind`}
									className="min-w-52 data-[size=default]:h-10"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(kinds).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</CardContent>
				</Card>

				<Card className={SECTION}>
					<CardContent className="flex flex-col gap-5">
						{ranking.error && (
							<p className="text-sm text-danger">
								{i18n.explain(ranking.error)}
							</p>
						)}
						{data && rows.length === 0 && (
							<p className="text-sm leading-relaxed text-dim">
								{t("ranking.empty")}
							</p>
						)}
						{rows.length > 0 && (
							<>
								<div className="overflow-x-auto">
									<table className="w-full min-w-[560px] border-collapse text-left text-sm">
										<caption className="sr-only">{t("ranking.title")}</caption>
										<thead>
											<tr className={LABEL}>
												<th scope="col" className="w-10 py-2 font-medium">
													{t("ranking.rank")}
												</th>
												<th scope="col" className="py-2 font-medium">
													{t("ranking.model")}
												</th>
												<th scope="col" className="py-2 font-medium">
													{t("ranking.wins")}
												</th>
												<th scope="col" className="py-2 font-medium">
													{t("ranking.winRate")}
												</th>
												<th scope="col" className="py-2 font-medium">
													{t("ranking.time")}
												</th>
												<th scope="col" className="py-2 font-medium">
													{t("ranking.cost")}
												</th>
											</tr>
										</thead>
										<tbody>
											{rows.map((row, i) => (
												<tr
													key={data?.models[i]?.modelId ?? row.name}
													className="border-t border-line"
												>
													<td className="py-3 font-mono text-dim tabular-nums">
														{i18n.number(i + 1)}
													</td>
													<th scope="row" className="py-3 pr-4 font-medium">
														<span className="flex flex-col items-start gap-1">
															{row.name}
															{row.few && (
																<Badge
																	variant="outline"
																	className="font-mono text-[10px] tracking-[0.12em] text-dim uppercase"
																>
																	{t("ranking.few")}
																</Badge>
															)}
														</span>
													</th>
													<td className="py-3 pr-4 font-mono whitespace-nowrap tabular-nums">
														{row.wins}
													</td>
													<td className="py-3 font-mono tabular-nums">
														{row.rate}
													</td>
													<td className="py-3 font-mono tabular-nums">
														{row.time}
													</td>
													<td className="py-3 font-mono tabular-nums">
														{row.cost}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
								<p className="text-xs leading-relaxed text-dim">
									{t("ranking.sortNote", {
										count: data?.minComparisons ?? 0,
									})}{" "}
									{t("ranking.timeNote")}
								</p>
								<div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
									<Button variant="outline" onClick={copy}>
										<ClipboardCopy aria-hidden="true" />
										{copied ? t("ranking.copied") : t("ranking.copyMarkdown")}
									</Button>
									<Button
										variant="outline"
										disabled={drawing}
										onClick={() => void save()}
									>
										<ImageDown aria-hidden="true" />
										{t("ranking.downloadImage")}
									</Button>
									<Label className="min-h-10 gap-3 font-normal">
										<Checkbox
											checked={examples}
											onCheckedChange={(checked) => setExamples(checked)}
										/>
										{t("ranking.includeExamples")}
									</Label>
								</div>
								<p
									className="text-xs leading-relaxed text-dim"
									aria-live="polite"
								>
									{copied ? t("ranking.copiedNote") : t("ranking.shareNote")}
								</p>
								{manual != null && (
									<div className="flex flex-col gap-2">
										<label
											htmlFor={`${id}-markdown`}
											className="text-sm text-danger"
										>
											{t("ranking.copyByHand")}
										</label>
										<textarea
											id={`${id}-markdown`}
											readOnly
											value={manual}
											rows={8}
											onFocus={(event) => event.currentTarget.select()}
											className="rounded-xl border border-line bg-bg p-3 font-mono text-xs"
										/>
									</div>
								)}
							</>
						)}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
