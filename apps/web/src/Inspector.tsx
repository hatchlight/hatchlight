import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { assetUrl } from "./api";
import { useI18n } from "./i18n";
import { itemFacts, type LightboxItem } from "./Lightbox";

interface Props {
	item: LightboxItem | null;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
	/** Makes the picture larger, when an upscaler is installed. */
	upscale?: { factor: number; busy: boolean; run(assetId: string): void };
	/** Goes to the conversation about this session, when there is one. */
	talkHref?: string;
}

/** The picture chosen in the advanced view: what it is, and what to do next. */
export function Inspector({
	item,
	onOpen,
	onUseAsReference,
	upscale,
	talkHref,
}: Props) {
	const i18n = useI18n();
	const { t } = i18n;
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
