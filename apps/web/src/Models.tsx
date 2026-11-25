import type {
	CommercialUse,
	Fit,
	LocalEngineStatus,
	LocalModelStatus,
	LocalModelsView,
	LocalModelTask,
} from "@hatchlight/core/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, SparklesIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { useCan } from "./Accounts";
import { api, demoUrl, useServerMode } from "./api";
import { CheckpointShelf } from "./Checkpoints";
import { remaining } from "./format";
import { type I18n, isMessageKey, useI18n } from "./i18n";
import { LoraShelf } from "./Loras";
import { useFolderMove, useModelProgress } from "./live";
import { ModelFolders } from "./ModelFolders";
import {
	categoryOf,
	filterLocal,
	type LocalCategory,
	type LocalFilter,
	localFit,
	recommendedLocal,
	sortLocal,
} from "./recommend";
import { Bar, ConfirmButton, LABEL, SECTION } from "./Training";

/** The top of a page: what it is about, its name and a few words on it. */
export function PageHeader({
	eyebrow,
	title,
	intro,
}: {
	eyebrow: string;
	title: string;
	intro: string;
}) {
	return (
		<header className="flex flex-col gap-3">
			<p className={LABEL}>{eyebrow}</p>
			<h1 className="font-display text-4xl leading-none font-extrabold tracking-tight sm:text-5xl">
				{title}
			</h1>
			<p className="max-w-2xl text-[15px] leading-relaxed text-dim">{intro}</p>
		</header>
	);
}

type Demo = LocalModelStatus["demos"][number] & { src: string; large: string };

function DemoViewer({ demo, onClose }: { demo: Demo; onClose(): void }) {
	const { t } = useI18n();
	// If the large picture fails, the card's one is better than nothing.
	const [src, setSrc] = useState(demo.large);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				showCloseButton={false}
				className="w-auto max-w-[96vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[96vw]"
			>
				<img
					src={src}
					alt={demo.caption ?? t("models.demo.sample")}
					decoding="async"
					onError={() => setSrc(demo.src)}
					className="max-h-[84vh] max-w-full bg-black object-contain"
				/>
				<div className="flex items-center justify-between gap-4 p-3 pl-4">
					<DialogTitle
						className={cn(
							"text-sm font-normal text-dim",
							!demo.caption && "sr-only",
						)}
					>
						{demo.caption ?? t("models.demo.sample")}
					</DialogTitle>
					<DialogClose render={<Button variant="outline" />}>
						{t("common.close")}
					</DialogClose>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** What the model's authors show it can do. */
function Demos({ model }: { model: LocalModelStatus }) {
	const { t } = useI18n();
	const [index, setIndex] = useState(0);
	const [open, setOpen] = useState(false);
	const [failed, setFailed] = useState<number[]>([]);
	// The shimmer repaints every frame: it stops once the picture is in.
	const [loaded, setLoaded] = useState<number[]>([]);
	const demos: Demo[] = model.demos.map((demo, i) => ({
		...demo,
		src: demoUrl(model.id, i, "card"),
		large: demoUrl(model.id, i, "large"),
	}));
	const demo = demos[index];
	if (!demo) {
		return (
			<div className="flex aspect-video items-center justify-center bg-bg text-sm text-dim">
				{t("models.demo.none")}
			</div>
		);
	}
	return (
		<div>
			<div className="aspect-video overflow-hidden bg-black">
				{failed.includes(index) ? (
					<div className="flex h-full items-center justify-center px-6 text-center text-sm text-dim">
						{t("models.demo.failed")}
					</div>
				) : demo.media === "video" ? (
					// biome-ignore lint/a11y/useMediaCaption: demo reels come without a transcript
					<video
						key={demo.src}
						src={demo.src}
						controls
						preload="none"
						playsInline
						onError={() => setFailed((current) => [...current, index])}
						className="h-full w-full object-contain"
					/>
				) : (
					<button
						type="button"
						onClick={() => setOpen(true)}
						aria-label={t("models.demo.enlarge", {
							caption: demo.caption ?? t("models.demo.sampleShort"),
						})}
						className={`block h-full w-full cursor-zoom-in outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset ${
							loaded.includes(index) ? "" : "developing"
						}`}
					>
						<img
							key={demo.src}
							src={demo.src}
							alt={
								demo.caption ??
								t("models.demo.sampleFrom", { model: model.name })
							}
							loading="lazy"
							decoding="async"
							onLoad={() => setLoaded((current) => [...current, index])}
							onError={() => setFailed((current) => [...current, index])}
							className="h-full w-full object-cover"
						/>
					</button>
				)}
			</div>
			{(demo.caption || demos.length > 1) && (
				<div className="flex items-start justify-between gap-3 px-5 pt-3">
					<p className="pt-2.5 text-xs leading-relaxed text-dim">
						{demo.media === "video" && `${t("models.demo.video")} · `}
						{demo.caption}
					</p>
					{demos.length > 1 && (
						<div className="flex shrink-0 gap-1">
							{demos.map((other, i) => (
								<Button
									key={other.src}
									variant="ghost"
									size="icon"
									onClick={() => setIndex(i)}
									aria-label={t("models.demo.position", {
										index: i + 1,
										total: demos.length,
									})}
									aria-pressed={i === index}
									className="font-mono text-xs text-dim aria-pressed:bg-panel-2 aria-pressed:text-ink"
								>
									{i + 1}
								</Button>
							))}
						</div>
					)}
				</div>
			)}
			{open && demo.media === "image" && (
				<DemoViewer demo={demo} onClose={() => setOpen(false)} />
			)}
		</div>
	);
}

function Progress({ model }: { model: LocalModelStatus }) {
	const i18n = useI18n();
	const { t, bytes } = i18n;
	const live = useModelProgress(model.id);
	const received = Math.max(live?.receivedBytes ?? 0, model.receivedBytes);
	const state = live?.state ?? model.state;
	const speed = live?.bytesPerSecond ?? 0;
	const percent = Math.min(100, (received / model.size) * 100);
	const detail =
		state === "queued"
			? t("models.progress.queued")
			: state === "verifying"
				? t("models.progress.verifying")
				: [
						t("models.progress.received", {
							received: bytes(received),
							total: bytes(model.size),
						}),
						speed > 0 && t("models.progress.speed", { speed: bytes(speed) }),
						speed > 0 && remaining(i18n, (model.size - received) / speed),
					]
						.filter(Boolean)
						.join(" · ");
	return (
		<div className="flex flex-col gap-2">
			<Bar
				value={percent}
				label={t("models.progress.label", { model: model.name })}
			/>
			<p className="font-mono text-xs text-dim">
				{Math.floor(percent)}% · {detail}
			</p>
		</div>
	);
}

export function fitText(t: I18n["t"], fit: Fit): string {
	switch (fit) {
		case "gpu":
			return t("models.fit.gpu");
		case "offload":
			return t("models.fit.offload");
		case "cpu":
			return t("models.fit.cpu");
		case "none":
			return t("models.fit.none");
	}
}

/** What the model does, in the reader's language, from the catalog when it has it. */
function summaryOf(t: I18n["t"], model: LocalModelStatus): string {
	const key = `models.summary.${model.id}`;
	return isMessageKey(key) ? t(key) : model.summary;
}

function taskText(t: I18n["t"], task: LocalModelTask): string {
	switch (task) {
		case "text-to-image":
			return t("models.task.textToImage");
		case "image-edit":
			return t("models.task.imageEdit");
		case "image-to-image":
			return t("models.task.imageToImage");
		case "upscale":
			return t("models.task.upscale");
		case "text-to-video":
			return t("models.task.textToVideo");
		case "image-to-video":
			return t("models.task.imageToVideo");
		case "prompt-translation":
			return t("models.task.promptTranslation");
		case "picture-description":
			return t("models.task.pictureDescription");
	}
}

export function commercialText(i18n: I18n, commercial: CommercialUse): string {
	switch (commercial.kind) {
		case "allowed":
			return i18n.t("models.commercial.allowed");
		case "limited":
			return i18n.t("models.commercial.limited", {
				revenue: i18n.number(commercial.revenueUsd, {
					style: "currency",
					currency: "USD",
					notation: "compact",
				}),
			});
		case "none":
			return i18n.t("models.commercial.none");
	}
}

const COMMERCIAL_STYLE: Record<CommercialUse["kind"], string> = {
	allowed: "border-good/30 text-good",
	limited: "border-warn/30 text-warn",
	none: "border-danger/30 text-danger",
};

const FIT_BADGE: Record<Fit, string> = {
	gpu: "bg-good/12 text-good",
	offload: "bg-warn/12 text-warn",
	cpu: "bg-warn/12 text-warn",
	none: "bg-danger/12 text-danger",
};

/** How the model runs here, in a few words: the first thing to choose by. */
function FitBadge({
	model,
	recommended,
}: {
	model: LocalModelStatus;
	recommended: boolean;
}) {
	const { t } = useI18n();
	const fit = localFit(model);
	if (recommended) {
		return (
			<Badge variant="outline" className="h-6 border-gold/40 px-2.5 text-gold">
				<SparklesIcon aria-hidden="true" />
				{t("models.badge.recommended")}
			</Badge>
		);
	}
	// Language models are made to run on the processor: that is no warning.
	const writes = model.media === "text" && fit === "cpu";
	const text = writes
		? t("models.badge.cpuText")
		: fit === "gpu"
			? t("models.badge.great")
			: fit === "offload"
				? t("models.badge.slow")
				: fit === "cpu"
					? t("models.badge.cpu")
					: t("models.badge.none");
	return (
		<Badge
			className={cn("h-6 px-2.5 font-normal", FIT_BADGE[writes ? "gpu" : fit])}
		>
			<span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
			{text}
		</Badge>
	);
}

export function ModelCard({
	model,
	engine,
	freeBytes,
	recommended,
	focused,
	badges,
	actions,
}: {
	model: LocalModelStatus;
	engine: LocalEngineStatus | undefined;
	freeBytes: number;
	recommended: boolean;
	/** Opened from a link: brought into view and marked. */
	focused: boolean;
	/** More to say at the top, beside how it runs here. */
	badges?: ReactNode;
	/** More to do, beside installing and deleting. */
	actions?: ReactNode;
}) {
	const i18n = useI18n();
	const { t, bytes, explain } = i18n;
	const install = useMutation({
		mutationFn: (variant?: string) => api.installModel(model.id, variant),
	});
	const cancel = useMutation({ mutationFn: () => api.cancelModel(model.id) });
	const remove = useMutation({ mutationFn: () => api.deleteModel(model.id) });
	const can = useCan();
	const error = install.error ?? cancel.error ?? remove.error;

	const installed = model.state === "installed";
	const active = !installed && model.state !== "available";
	/** A language model on the processor runs as it is meant to. */
	const writes = (fit: Fit) => model.media === "text" && fit === "cpu";
	const variant = model.variants.find((v) => v.id === model.variant);
	const engineToFetch =
		engine && !engine.installed && !installed ? engine.size : 0;
	const toDownload = model.size - model.receivedBytes;
	const shared = (variant?.files ?? [])
		.filter((file) => file.present)
		.reduce((sum, file) => sum + file.size, 0);
	const partial = model.receivedBytes - shared;
	const fits = toDownload <= freeBytes;
	const others = model.variants.filter(
		(v) => v.id !== model.variant && v.fit !== "none",
	);

	const note = installed
		? model.reclaimableBytes < model.size
			? t("models.note.installedShared", {
					size: bytes(model.reclaimableBytes),
				})
			: t("models.note.installed")
		: [
				shared > 0
					? t("models.note.sharedDownload", {
							size: bytes(toDownload),
							shared: bytes(shared),
						})
					: partial > 0
						? t("models.note.leftToDownload", { size: bytes(toDownload) })
						: t("models.note.toDownload"),
				engineToFetch > 0 &&
					t("models.note.withEngine", { size: bytes(engineToFetch) }),
			]
				.filter(Boolean)
				.join(" · ");

	return (
		<li id={`model-${model.id}`} className="flex scroll-mt-8">
			<Card
				className={cn(
					"w-full gap-0 rounded-2xl py-0 ring-line",
					focused && "ring-2 ring-gold",
				)}
			>
				{/* Language models write: they have no pictures to show. */}
				{model.media !== "text" && <Demos model={model} />}
				<div className="flex flex-1 flex-col gap-4 p-5">
					<div className="flex flex-wrap gap-1.5">
						{badges}
						<FitBadge model={model} recommended={recommended} />
						<Badge
							variant="outline"
							className={cn(
								"h-6 px-2.5 font-normal",
								COMMERCIAL_STYLE[model.commercial.kind],
							)}
						>
							{commercialText(i18n, model.commercial)}
						</Badge>
					</div>
					<div>
						<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
							<h3 className="font-display text-xl font-bold tracking-tight">
								{model.name}
							</h3>
							<span
								className={`font-mono text-xs ${installed ? "text-good" : "text-dim"}`}
							>
								{installed
									? t("models.installed")
									: model.media === "video"
										? t("models.media.video")
										: model.media === "text"
											? t("models.media.text")
											: t("models.media.image")}
							</span>
						</div>
						<p className="mt-1 text-xs text-dim">
							{model.author} ·{" "}
							<a
								href={model.licenseUrl}
								target="_blank"
								rel="noreferrer"
								className="py-1.5 underline underline-offset-2 hover:text-ink"
							>
								{model.license}
							</a>{" "}
							·{" "}
							<a
								href={model.homepage}
								target="_blank"
								rel="noreferrer"
								className="py-1.5 underline underline-offset-2 hover:text-ink"
							>
								{t("models.page")}
							</a>
						</p>
					</div>
					<p className="text-sm leading-relaxed text-soft">
						{summaryOf(t, model)}
					</p>
					<ul
						aria-label={t("models.task.label")}
						className="flex flex-wrap gap-1.5"
					>
						{model.tasks.map((task) => (
							<li
								key={task}
								className="rounded-md bg-panel-2 px-2 py-0.5 font-mono text-[11px] text-dim"
							>
								{taskText(t, task)}
							</li>
						))}
					</ul>

					{variant ? (
						<div className="flex flex-col gap-1 border-t border-line pt-4">
							<p>
								<span className="font-mono text-lg">{bytes(model.size)}</span>{" "}
								<span className="text-sm text-dim">{note}</span>
							</p>
							<p className="text-sm">
								<span className="font-medium">{variant.label}</span>{" "}
								<span
									className={
										variant.fit === "gpu" || writes(variant.fit)
											? "text-dim"
											: "text-danger"
									}
								>
									·{" "}
									{writes(variant.fit)
										? t("models.fit.cpuText")
										: fitText(t, variant.fit)}
								</span>
							</p>
							<Collapsible className="text-xs text-dim">
								<CollapsibleTrigger className="group -ml-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50">
									{t("models.files", { count: variant.files.length })}
									{model.variants.length > 1 &&
										` · ${t("models.versions", { count: model.variants.length })}`}
									<ChevronDownIcon
										aria-hidden="true"
										className="size-3.5 transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none"
									/>
								</CollapsibleTrigger>
								<CollapsibleContent>
									<ul className="flex flex-col gap-1 font-mono">
										{variant.files.map((file) => (
											<li
												key={file.name}
												className="flex justify-between gap-4"
											>
												<span className="min-w-0 truncate" title={file.name}>
													{file.name}
												</span>
												<span className="shrink-0">
													{bytes(file.size)}
													{file.present && ` · ${t("models.onDisk")}`}
												</span>
											</li>
										))}
									</ul>
									{model.variants.length > 1 && (
										<ul className="mt-3 flex flex-col gap-2">
											{model.variants.map((other) => (
												<li
													key={other.id}
													className="flex flex-wrap items-center justify-between gap-2"
												>
													<span>
														<span className="text-ink">{other.label}</span> ·{" "}
														{bytes(other.size)} ·{" "}
														{writes(other.fit)
															? t("models.fit.cpuText")
															: fitText(t, other.fit)}
														{other.id === model.variant &&
															` · ${installed ? t("models.variantInstalled") : t("models.recommended")}`}
													</span>
													{can.admin &&
														!installed &&
														!active &&
														others.includes(other) && (
															<Button
																variant="outline"
																onClick={() => install.mutate(other.id)}
																disabled={install.isPending}
															>
																{t("models.installVersion")}
															</Button>
														)}
												</li>
											))}
										</ul>
									)}
								</CollapsibleContent>
							</Collapsible>
						</div>
					) : (
						<p className="text-sm text-danger">{t("models.noVersion")}</p>
					)}

					{installed && !model.ready && !active && (
						<p className="text-sm text-danger">{t("models.engineMissing")}</p>
					)}
					{active && <Progress model={model} />}
					{model.error && !active && (
						<p className="text-sm text-danger">
							{t("models.installStopped", {
								error: explain({
									message: model.error,
									code: model.errorCode,
									params: model.errorParams,
								}),
							})}
						</p>
					)}
					{error && <p className="text-sm text-danger">{explain(error)}</p>}
					{variant && !installed && !active && !fits && (
						<p className="text-sm text-danger">
							{t("models.notEnoughSpace", {
								needed: bytes(toDownload),
								free: bytes(freeBytes),
							})}
						</p>
					)}

					{!can.admin && !installed && !active && (
						<p className="mt-auto pt-1 text-sm text-dim">
							{t("models.askAdmin")}
						</p>
					)}
					<div
						className={cn(
							"mt-auto flex flex-wrap gap-2 pt-1",
							!can.admin && "hidden",
						)}
					>
						{installed && !model.ready && !active && (
							<Button
								variant="aurora"
								onClick={() => install.mutate(undefined)}
								disabled={install.isPending}
							>
								{t("models.installEngine")}
							</Button>
						)}
						{variant && !installed && !active && (
							<Button
								variant="aurora"
								onClick={() => install.mutate(undefined)}
								disabled={!fits || install.isPending}
							>
								{partial > 0 ? t("models.resume") : t("models.install")}
							</Button>
						)}
						{active && (
							<Button
								variant="outline"
								onClick={() => cancel.mutate()}
								disabled={cancel.isPending}
							>
								{model.state === "queued"
									? t("common.cancel")
									: t("models.pause")}
							</Button>
						)}
						{(installed || partial > 0) && !active && (
							<ConfirmButton
								label={installed ? t("models.delete") : t("models.discard")}
								question={
									installed
										? t("models.deleteConfirm", {
												model: model.name,
												size: bytes(model.reclaimableBytes),
											})
										: t("models.discardConfirm", {
												model: model.name,
												size: bytes(partial),
											})
								}
								confirm={installed ? t("models.delete") : t("models.discard")}
								disabled={remove.isPending}
								onConfirm={() => remove.mutate()}
							/>
						)}
					</div>
					{actions}
				</div>
			</Card>
		</li>
	);
}

const BACKEND_NAMES: Record<
	Exclude<LocalEngineStatus["backend"], "cpu">,
	string
> = {
	cuda: "CUDA",
	rocm: "ROCm",
	metal: "Metal",
	vulkan: "Vulkan",
};

/** What Hatchlight found on this computer, what it runs models with, and where it keeps them. */
function Machine({ view }: { view: LocalModelsView }) {
	const can = useCan();
	const { t, bytes } = useI18n();
	const { hardware, engines, disk } = view;
	const gpu = hardware.gpus.toSorted(
		(a, b) => b.memoryBytes - a.memoryBytes,
	)[0];
	return (
		<Card className={SECTION}>
			<CardContent>
				<dl className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_1fr_1fr]">
					<div className="flex flex-col gap-2">
						<dt className={LABEL}>{t("models.machine.computer")}</dt>
						<dd className="text-sm leading-relaxed">
							{gpu
								? `${gpu.name} · ${bytes(gpu.memoryBytes)}`
								: t("models.machine.noGpu")}
							<span className="text-dim">
								{" "}
								·{" "}
								{t("models.machine.memory", {
									size: bytes(hardware.memoryBytes),
								})}
								{hardware.wsl && " · WSL"}
							</span>
						</dd>
					</div>
					<div className="flex flex-col gap-2">
						<dt className={LABEL}>{t("models.machine.engine")}</dt>
						<dd className="text-sm leading-relaxed">
							{engines.length === 0 ? (
								<span className="text-danger">
									{t("models.machine.noEngine")}
								</span>
							) : (
								engines.map((engine) => (
									<span key={engine.engine} className="block">
										{engine.name} ·{" "}
										{engine.backend === "cpu"
											? t("models.machine.cpu")
											: BACKEND_NAMES[engine.backend]}
										{engine.throughWindows && ` ${t("models.machine.windows")}`}
										<span className="text-dim">
											{" "}
											·{" "}
											{engine.installed
												? t("models.machine.engineInstalled", {
														size: bytes(engine.size),
													})
												: t("models.machine.engineLater", {
														size: bytes(engine.size),
													})}
										</span>
									</span>
								))
							)}
						</dd>
					</div>
					<div className="flex flex-col gap-2">
						<dt className={LABEL}>{t("models.disk.used")}</dt>
						<dd className="font-mono text-lg">
							{disk.usedBytes > 0
								? bytes(disk.usedBytes)
								: t("models.disk.nothing")}
						</dd>
					</div>
					<div className="flex flex-col gap-2">
						<dt className={LABEL}>{t("models.disk.free")}</dt>
						<dd className="font-mono text-lg">{bytes(disk.freeBytes)}</dd>
					</div>
					{/* Where the server keeps its files is for those who run it. */}
					{can.admin && <Folder disk={disk} />}
				</dl>
			</CardContent>
		</Card>
	);
}

const NO_FILTER: LocalFilter = {
	category: "all",
	runsWell: false,
	commercial: false,
	installed: false,
};

const CATEGORIES: LocalCategory[] = ["image", "edit", "video"];

function categoryText(t: I18n["t"], category: LocalCategory | "all"): string {
	switch (category) {
		case "all":
			return t("models.filter.all");
		case "image":
			return t("models.category.image");
		case "edit":
			return t("models.category.edit");
		case "video":
			return t("models.category.video");
	}
}

function categoryBody(t: I18n["t"], category: LocalCategory): string {
	switch (category) {
		case "image":
			return t("models.category.imageBody");
		case "edit":
			return t("models.category.editBody");
		case "video":
			return t("models.category.videoBody");
	}
}

/** A pill to narrow the catalog with, filled in while it is on. */
const CHIP =
	"h-10 rounded-full border border-line px-4 font-normal text-dim hover:text-ink aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-bg aria-pressed:hover:bg-ink/90 aria-pressed:hover:text-bg";

const ALL_CATEGORIES = ["all", ...CATEGORIES] as const;

/** Every model, narrowed by what it does and how it suits this computer. */
function Catalog({ view, focus }: { view: LocalModelsView; focus?: string }) {
	const { t } = useI18n();
	const [filter, setFilter] = useState<LocalFilter>(NO_FILTER);
	// A model opened from a link is shown whatever the filters were.
	useEffect(() => {
		if (!focus) return;
		setFilter(NO_FILTER);
		requestAnimationFrame(() =>
			document
				.getElementById(`model-${focus}`)
				?.scrollIntoView({ block: "center", behavior: "smooth" }),
		);
	}, [focus]);
	// The prompt translator is set up in Settings, not offered here.
	const makers = view.models.filter((model) => model.media !== "text");
	const recommended = recommendedLocal(makers);
	const shown = sortLocal(filterLocal(makers, filter));
	const set = (change: Partial<LocalFilter>) =>
		setFilter((current) => ({ ...current, ...change }));
	const count = (category: LocalCategory | "all") =>
		filterLocal(makers, { ...filter, category }).length;
	// All shelves at once group models by their main use; one shelf lists
	// every model that can do its job.
	const shelves =
		filter.category === "all"
			? CATEGORIES.map((category) => ({
					category,
					models: shown.filter((m) => categoryOf(m) === category),
				}))
			: [{ category: filter.category, models: shown }];
	const card = (model: LocalModelStatus) => (
		<ModelCard
			key={model.id}
			model={model}
			engine={view.engines.find((engine) =>
				model.variants.some(
					(v) => v.id === model.variant && v.engine === engine.engine,
				),
			)}
			freeBytes={view.disk.freeBytes}
			recommended={recommended.has(model.id)}
			focused={model.id === focus}
		/>
	);
	const toggles: {
		key: "runsWell" | "commercial" | "installed";
		text: string;
	}[] = [
		{ key: "runsWell", text: t("models.filter.runsWell") },
		{ key: "commercial", text: t("models.filter.commercial") },
		{ key: "installed", text: t("models.filter.installed") },
	];
	return (
		<div className="flex flex-col gap-10 pt-4">
			<fieldset className="flex flex-col gap-3">
				<legend className="sr-only">{t("models.filter.label")}</legend>
				<ToggleGroup
					value={[filter.category]}
					onValueChange={(next) => {
						const category = ALL_CATEGORIES.find((c) => c === next[0]);
						if (category) set({ category });
					}}
					className="flex-wrap"
				>
					{ALL_CATEGORIES.map((category) => (
						<ToggleGroupItem key={category} value={category} className={CHIP}>
							{categoryText(t, category)}
							<span className="font-mono text-xs opacity-60">
								{count(category)}
							</span>
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				<div className="flex flex-wrap gap-2">
					{toggles.map((toggle) => (
						<Toggle
							key={toggle.key}
							pressed={filter[toggle.key]}
							onPressedChange={(pressed) => set({ [toggle.key]: pressed })}
							className={cn(CHIP, "text-xs")}
						>
							{filter[toggle.key] && <CheckIcon aria-hidden="true" />}
							{toggle.text}
						</Toggle>
					))}
				</div>
			</fieldset>
			{shown.length === 0 ? (
				<p className="text-sm text-dim">
					{t("models.filter.none")}{" "}
					<Button
						variant="link"
						onClick={() => setFilter(NO_FILTER)}
						className="h-10 px-1 text-ink underline"
					>
						{t("models.filter.clear")}
					</Button>
				</p>
			) : (
				shelves.map(
					(shelf) =>
						shelf.models.length > 0 && (
							<section
								key={shelf.category}
								aria-label={categoryText(t, shelf.category)}
								className="flex flex-col gap-5"
							>
								<div className="flex flex-col gap-1">
									<h2 className="font-display text-2xl font-bold tracking-tight">
										{categoryText(t, shelf.category)}
									</h2>
									<p className="text-sm text-dim">
										{categoryBody(t, shelf.category)}
									</p>
								</div>
								<ul className="grid gap-5 md:grid-cols-2">
									{shelf.models.map(card)}
								</ul>
							</section>
						),
				)
			)}
		</div>
	);
}

/** Where the models are kept, and a way to move them to another folder. */
function Folder({ disk }: { disk: LocalModelsView["disk"] }) {
	const { t, bytes, explain } = useI18n();
	const live = useFolderMove();
	// A path typed in a browser would name a folder on the server.
	const server = useServerMode();
	const changeable = disk.changeable && !server;
	const moving = live ?? disk.moving;
	const [editing, setEditing] = useState(false);
	const [path, setPath] = useState(disk.path);
	const move = useMutation({
		mutationFn: () => api.moveModels(path),
		onSuccess: () => setEditing(false),
	});
	const percent = moving
		? Math.round((moving.movedBytes / Math.max(moving.totalBytes, 1)) * 100)
		: 0;
	return (
		<div className="flex min-w-0 flex-col gap-2 border-t border-line pt-6 sm:col-span-2 lg:col-span-4">
			<dt className={LABEL}>{t("models.disk.path")}</dt>
			<dd>
				{moving ? (
					<div className="flex flex-col gap-2">
						<p className="truncate text-sm" title={moving.to}>
							{t("models.folder.moving", { path: moving.to })}
						</p>
						<Bar
							value={percent}
							label={t("models.folder.moving", { path: moving.to })}
						/>
						<p className="font-mono text-xs text-dim">
							{t("models.folder.moved", {
								moved: bytes(moving.movedBytes),
								total: bytes(moving.totalBytes),
							})}
						</p>
					</div>
				) : editing ? (
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							move.mutate();
						}}
					>
						<Input
							value={path}
							onChange={(event) => setPath(event.target.value)}
							aria-label={t("models.folder.label")}
							spellCheck={false}
							autoFocus
							className="h-10 font-mono"
						/>
						<p className="text-xs leading-relaxed text-dim">
							{t("models.folder.hint", { size: bytes(disk.usedBytes) })}
						</p>
						{move.error && (
							<p className="text-sm text-danger">{explain(move.error)}</p>
						)}
						<div className="flex flex-wrap gap-2">
							<Button type="submit" disabled={move.isPending || !path.trim()}>
								{t("models.folder.move")}
							</Button>
							<Button
								variant="outline"
								onClick={() => {
									setEditing(false);
									move.reset();
								}}
							>
								{t("common.cancel")}
							</Button>
						</div>
					</form>
				) : (
					<div className="flex min-w-0 items-center gap-3">
						<span
							className="min-w-0 truncate font-mono text-sm"
							title={disk.path}
						>
							{disk.path}
						</span>
						{changeable && (
							<Button
								variant="outline"
								onClick={() => {
									setPath(disk.path);
									setEditing(true);
								}}
							>
								{t("models.folder.change")}
							</Button>
						)}
					</div>
				)}
				{disk.moveError && !moving && !editing && (
					<p className="mt-2 text-sm text-danger">{explain(disk.moveError)}</p>
				)}
			</dd>
		</div>
	);
}

export function Models({ focus }: { focus?: string }) {
	const { t, explain } = useI18n();
	const view = useQuery({
		queryKey: ["local-models"],
		queryFn: api.localModels,
	});
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-[1060px] flex-col gap-6 px-4 py-8 sm:px-8 sm:py-12">
				<PageHeader
					eyebrow={t("models.eyebrow")}
					title={t("models.title")}
					intro={t("models.intro")}
				/>
				{view.error && (
					<p className="text-sm text-danger">{explain(view.error)}</p>
				)}
				{view.data && <Machine view={view.data} />}
				<CheckpointShelf />
				<LoraShelf />
				<ModelFolders />
				{view.data && <Catalog view={view.data} focus={focus} />}
			</div>
		</div>
	);
}
