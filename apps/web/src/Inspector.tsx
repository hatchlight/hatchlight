import type { ConsistencyResult } from "@hatchlight/core/types";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { api, assetUrl } from "./api";
import { useI18n } from "./i18n";
import { DeleteAsset, itemFacts, type LightboxItem } from "./Lightbox";

interface Props {
	item: LightboxItem | null;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
	/** Makes the picture larger, when an upscaler is installed. */
	upscale?: { factor: number; busy: boolean; run(assetId: string): void };
	/** Goes to the conversation about this session, when there is one. */
	talkHref?: string;
	/** After the picture was deleted. */
	onDeleted(): void;
	/**
	 * The character of a series: the pictures this one is compared with,
	 * and choosing it as the character. Absent where nothing can compare.
	 */
	character?: {
		references: string[];
		/** This picture is the character. */
		chosen: boolean;
		choose(assetId: string | null): void;
	};
}

/** The picture chosen in the advanced view: what it is, and what to do next. */
export function Inspector({
	item,
	onOpen,
	onUseAsReference,
	upscale,
	talkHref,
	onDeleted,
	character,
}: Props) {
	const i18n = useI18n();
	const { t } = i18n;
	const check = useMutation({
		mutationFn: async (input: {
			assetId: string;
			references: string[];
		}): Promise<ConsistencyResult & { against: string }> => ({
			against: againstOf(input.assetId, input.references),
			...(await api.checkConsistency({
				assetId: input.assetId,
				referenceAssetIds: input.references,
				language: i18n.language,
			})),
		}),
	});
	if (!item) {
		return (
			<p className="text-sm leading-relaxed text-dim">{t("inspector.empty")}</p>
		);
	}
	const video = item.mime.startsWith("video/");
	return (
		<div className="flex flex-col gap-[18px]">
			<button
				type="button"
				onClick={() => onOpen(item)}
				aria-label={t("inspector.openLarge")}
				className="block overflow-hidden rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
			>
				{video ? (
					<video
						src={assetUrl(item.assetId)}
						muted
						loop
						autoPlay
						playsInline
						className="w-full bg-black"
					/>
				) : (
					<img
						src={assetUrl(item.assetId)}
						alt={item.prompt ?? t("common.generatedImage")}
						className="w-full bg-black object-contain"
					/>
				)}
			</button>
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
				{itemFacts(i18n, item).map(([label, value]) => (
					<div key={label} className="contents">
						<dt className="text-dim">{label}</dt>
						<dd className="min-w-0 truncate font-mono">{String(value)}</dd>
					</div>
				))}
			</dl>
			<div className="flex flex-col gap-2">
				{!video && (
					<Button
						onClick={() => onUseAsReference(item.assetId)}
						className="h-[42px] font-semibold"
					>
						{t("common.useAsReference")}
					</Button>
				)}
				<div className="grid grid-cols-2 gap-2">
					{upscale && !video && (
						<Button
							variant="outline"
							disabled={upscale.busy}
							onClick={() => upscale.run(item.assetId)}
							className="h-[42px]"
						>
							{t("job.upscale", { factor: i18n.number(upscale.factor) })}
						</Button>
					)}
					<Button
						variant="outline"
						onClick={() => onOpen(item)}
						className="h-[42px] [&:only-child]:col-span-2"
					>
						{t("inspector.openLarge")}
					</Button>
				</div>
				{talkHref && (
					<Button
						variant="ghost"
						nativeButton={false}
						render={<a href={talkHref} />}
						className="h-[42px] border border-line text-soft"
					>
						{t("inspector.talk")}
					</Button>
				)}
				{character && !video && (
					<CharacterCheck
						assetId={item.assetId}
						character={character}
						busy={check.isPending}
						// Only for this picture against these references: once
						// either changes, an earlier answer says nothing.
						result={
							check.data?.against ===
							againstOf(item.assetId, character.references)
								? check.data
								: undefined
						}
						error={
							check.error &&
							check.variables &&
							againstOf(check.variables.assetId, check.variables.references) ===
								againstOf(item.assetId, character.references)
								? i18n.explain(check.error)
								: null
						}
						onCompare={() =>
							check.mutate({
								assetId: item.assetId,
								references: character.references,
							})
						}
					/>
				)}
				<DeleteAsset
					assetId={item.assetId}
					onDeleted={onDeleted}
					className="h-[42px]"
				/>
			</div>
			{item.prompt && (
				<Collapsible className="text-xs leading-relaxed text-dim">
					<CollapsibleTrigger className="group flex min-h-8 items-center gap-1 rounded-sm outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50">
						{t("job.details")}
						<ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180" />
					</CollapsibleTrigger>
					<CollapsibleContent>
						<p className="mt-1 whitespace-pre-wrap text-ink">{item.prompt}</p>
						{item.params?.translatedPrompt && (
							<p className="mt-2">
								{t("job.translated")}{" "}
								<span className="text-ink">{item.params.translatedPrompt}</span>
							</p>
						)}
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

/** Which comparison a result answers: a picture against its references. */
const againstOf = (assetId: string, references: string[]) =>
	[assetId, ...references].join(" ");

/** Whether the picture shows the series' character, and what differs. */
function CharacterCheck({
	assetId,
	character,
	busy,
	result,
	error,
	onCompare,
}: {
	assetId: string;
	character: NonNullable<Props["character"]>;
	busy: boolean;
	result?: ConsistencyResult;
	error: string | null;
	onCompare(): void;
}) {
	const i18n = useI18n();
	const { t } = i18n;
	const canCompare = !character.chosen && character.references.length > 0;
	return (
		<div className="flex flex-col gap-2">
			{canCompare && (
				<Button
					variant="outline"
					disabled={busy}
					onClick={onCompare}
					className="h-[42px]"
				>
					{busy ? t("character.comparing") : t("character.compare")}
				</Button>
			)}
			<Button
				variant="ghost"
				onClick={() => character.choose(character.chosen ? null : assetId)}
				className="h-9 text-[13px] text-soft"
			>
				{character.chosen ? t("character.unchoose") : t("character.choose")}
			</Button>
			{error && <p className="text-[13px] text-danger">{error}</p>}
			{result && (
				<div
					aria-live="polite"
					className="flex flex-col gap-2 rounded-xl border border-line p-3 text-[13px]"
				>
					<div className="flex items-center gap-2">
						<Badge
							variant={
								result.verdict === "different" ? "destructive" : "secondary"
							}
						>
							{t("character.score", { score: i18n.number(result.score) })}
						</Badge>
						<span className="text-soft">
							{result.verdict === "same"
								? t("character.verdict.same")
								: result.verdict === "close"
									? t("character.verdict.close")
									: t("character.verdict.different")}
						</span>
					</div>
					{result.differences.length > 0 && (
						<ul className="list-disc space-y-1 pl-4 text-ink">
							{result.differences.map((difference) => (
								<li key={difference}>{difference}</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
