import type { GenerationParams } from "@hatchlight/core/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api, assetUrl, useDemo } from "./api";
import { draftFromPicture, openLibraryDraft } from "./drafts";
import { usd } from "./format";
import { type I18n, useI18n } from "./i18n";
import { useLoras } from "./Loras";

export interface LightboxItem {
	assetId: string;
	mime: string;
	prompt: string | null;
	modelName: string | null;
	params: GenerationParams | null;
	costUsd: number | null;
}

/** What is known about a picture or video made, as label and value. */
export function itemFacts(i18n: I18n, item: LightboxItem): [string, unknown][] {
	const { t } = i18n;
	return (
		[
			[t("lightbox.model"), item.modelName],
			[t("lightbox.ratio"), item.params?.aspectRatio],
			[
				t("lightbox.length"),
				item.params?.durationSeconds &&
					t("format.seconds", { seconds: item.params.durationSeconds }),
			],
			[t("lightbox.seed"), item.params?.seed],
			[t("lightbox.character"), item.params?.library?.character],
			[t("lightbox.style"), item.params?.library?.style],
			[
				t("lightbox.cost"),
				item.costUsd == null
					? null
					: item.costUsd === 0
						? t("picker.free")
						: usd(i18n, item.costUsd),
			],
		] as [string, unknown][]
	).filter(([, value]) => value != null);
}

/**
 * Keeps a picture, and what made it, as a character or a style to use
 * again: the Library opens with them filled in, to name and save.
 */
export function SaveToLibrary({
	item,
	className,
}: {
	item: LightboxItem;
	className?: string;
}) {
	const { t } = useI18n();
	const loras = useLoras();
	// A demo's visitor keeps nothing past their stay.
	const demo = useDemo() !== null;
	if (demo || item.mime.startsWith("video/")) return null;
	const save = (kind: "character" | "style") =>
		openLibraryDraft(draftFromPicture(kind, item, loras.data ?? []));
	return (
		<div className={cn("grid grid-cols-2 gap-2", className)}>
			<Button variant="outline" onClick={() => save("character")}>
				{t("library.saveAsCharacter")}
			</Button>
			<Button variant="outline" onClick={() => save("style")}>
				{t("library.saveAsStyle")}
			</Button>
		</div>
	);
}

interface Props {
	item: LightboxItem;
	onClose(): void;
	onUseAsReference(assetId: string): void;
}

/**
 * Deletes a picture or video, after asking: it leaves the gallery, and the
 * turn that made it keeps its place without it.
 */
export function DeleteAsset({
	assetId,
	onDeleted,
	className,
}: {
	assetId: string;
	onDeleted(): void;
	className?: string;
}) {
	const { t, explain } = useI18n();
	const client = useQueryClient();
	const [asking, setAsking] = useState(false);
	const remove = useMutation({
		mutationFn: () => api.deleteAsset(assetId),
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: ["gallery"] });
			void client.invalidateQueries({ queryKey: ["session"] });
			void client.invalidateQueries({ queryKey: ["account"] });
			onDeleted();
		},
	});
	return (
		<>
			<Button
				variant="outline"
				disabled={remove.isPending}
				onClick={() => setAsking(true)}
				className={cn("text-dim hover:text-danger", className)}
			>
				<Trash2Icon aria-hidden="true" />
				{t("asset.delete")}
			</Button>
			{remove.error && (
				<p className="text-sm text-danger">{explain(remove.error)}</p>
			)}
			<AlertDialog open={asking} onOpenChange={setAsking}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("asset.deleteTitle")}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("asset.deleteBody")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("nav.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								setAsking(false);
								remove.mutate();
							}}
						>
							{t("asset.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

export function Lightbox({ item, onClose, onUseAsReference }: Props) {
	const i18n = useI18n();
	const { t } = i18n;
	const video = item.mime.startsWith("video/");
	const facts = itemFacts(i18n, item);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				showCloseButton={false}
				className="flex h-[92dvh] w-[min(1200px,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl bg-panel p-0 ring-line sm:max-w-none md:flex-row"
			>
				<DialogTitle className="sr-only">
					{video ? t("gallery.generatedVideo") : t("common.generatedImage")}
				</DialogTitle>
				<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-bg">
					{video ? (
						// biome-ignore lint/a11y/useMediaCaption: generated clips have no transcript
						<video
							src={assetUrl(item.assetId)}
							controls
							autoPlay
							loop
							playsInline
							className="max-h-full max-w-full object-contain"
						/>
					) : (
						<img
							src={assetUrl(item.assetId)}
							alt={item.prompt ?? t("common.generatedImage")}
							className="max-h-full max-w-full object-contain"
						/>
					)}
				</div>
				<div className="flex max-h-[45%] w-full shrink-0 flex-col gap-5 overflow-y-auto border-line p-5 max-md:border-t md:max-h-none md:w-80 md:border-l md:p-6">
					<div className="flex items-start justify-between gap-3">
						{item.prompt ? (
							<p className="text-sm leading-relaxed whitespace-pre-wrap">
								{item.prompt}
							</p>
						) : (
							<span />
						)}
						<DialogClose
							render={
								<Button variant="ghost" size="icon" className="-mt-2 -mr-2" />
							}
						>
							<XIcon />
							<span className="sr-only">{t("common.close")}</span>
						</DialogClose>
					</div>
					{facts.length > 0 && (
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
							{facts.map(([label, value]) => (
								<div key={label} className="contents">
									<dt className="text-dim">{label}</dt>
									<dd className="font-mono">{String(value)}</dd>
								</div>
							))}
						</dl>
					)}
					<div className="mt-auto flex flex-col gap-2">
						{!video && (
							<Button
								variant="aurora"
								onClick={() => onUseAsReference(item.assetId)}
							>
								{t("common.useAsReference")}
							</Button>
						)}
						<SaveToLibrary item={item} />
						<a
							href={assetUrl(item.assetId)}
							download={`hatchlight-${item.assetId}`}
							className={buttonVariants({ variant: "outline" })}
						>
							<DownloadIcon aria-hidden="true" />
							{t("lightbox.download")}
						</a>
						<DeleteAsset assetId={item.assetId} onDeleted={onClose} />
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
