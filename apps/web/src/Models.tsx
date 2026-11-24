import type {
	CommercialUse,
	Fit,
	LocalEngineStatus,
	LocalModelStatus,
	LocalModelsView,
	LocalModelTask,
} from "@hatchlight/core/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, demoUrl, useServerMode } from "./api";
import { CheckpointShelf } from "./Checkpoints";
import { remaining } from "./format";
import { type I18n, isMessageKey, useI18n } from "./i18n";
import { LoraShelf } from "./Loras";
import { useFolderMove, useModelProgress } from "./live";
import {
	categoryOf,
	filterLocal,
	type LocalCategory,
	type LocalFilter,
	localFit,
	recommendedLocal,
	sortLocal,
} from "./recommend";

type Demo = LocalModelStatus["demos"][number] & { src: string; large: string };

function DemoViewer({ demo, onClose }: { demo: Demo; onClose(): void }) {
	const { t } = useI18n();
	const ref = useRef<HTMLDialogElement>(null);
	// If the large picture fails, the card's one is better than nothing.
	const [src, setSrc] = useState(demo.large);
	useEffect(() => {
		ref.current?.showModal();
	}, []);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop closes; Esc already does so natively
		<dialog
			ref={ref}
			onClose={onClose}
			onClick={(event) => event.target === ref.current && onClose()}
			className="m-auto max-h-[94vh] max-w-[96vw] rounded-lg border border-line bg-panel p-0 text-ink"
		>
			<img
				src={src}
				alt={demo.caption ?? t("models.demo.sample")}
				decoding="async"
				onError={() => setSrc(demo.src)}
				className="max-h-[86vh] max-w-full object-contain"
			/>
			<div className="flex items-center justify-between gap-4 p-3 text-sm">
				<span className="text-dim">{demo.caption}</span>
				<button
					type="button"
					onClick={onClose}
					className="rounded-md px-3 py-1 text-dim hover:text-ink"
				>
					{t("common.close")}
				</button>
			</div>
		</dialog>
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
			<div className="relative aspect-video overflow-hidden bg-black">
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
						className={`block h-full w-full cursor-zoom-in ${
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
				{demos.length > 1 && (
					<div className="absolute right-2 bottom-2 flex gap-1">
						{demos.map((other, i) => (
							<button
								key={other.src}
								type="button"
								onClick={() => setIndex(i)}
								aria-label={t("models.demo.position", {
									index: i + 1,
									total: demos.length,
								})}
								aria-pressed={i === index}
								className={`h-6 min-w-6 rounded bg-black/70 px-1.5 font-mono text-xs ${
									i === index ? "text-white" : "text-white/50 hover:text-white"
								}`}
							>
								{i + 1}
							</button>
						))}
					</div>
				)}
			</div>
			{demo.caption && (
				<p className="px-4 pt-2 text-xs text-dim">
					{demo.media === "video" && `${t("models.demo.video")} · `}
					{demo.caption}
				</p>
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
		<div>
			<div
				role="progressbar"
				aria-label={t("models.progress.label", { model: model.name })}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(percent)}
				className="h-1.5 overflow-hidden rounded-full bg-line"
			>
				<div
					className="h-full rounded-full bg-accent transition-[width] duration-300"
					style={{ width: `${percent}%` }}
				/>
			</div>
			<p className="mt-2 font-mono text-xs text-dim">
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
			<span className="aurora rounded-full px-2.5 py-0.5 text-xs font-semibold">
				{t("models.badge.recommended")}
			</span>
		);
	}
	const text =
		fit === "gpu"
			? t("models.badge.great")
			: fit === "offload"
				? t("models.badge.slow")
				: fit === "cpu"
					? t("models.badge.cpu")
					: t("models.badge.none");
	return (
		<span className={`rounded-full px-2.5 py-0.5 text-xs ${FIT_BADGE[fit]}`}>
			<span aria-hidden="true">● </span>
			{text}
		</span>
	);
}

function ModelCard({
	model,
	engine,
	freeBytes,
	recommended,
}: {
	model: LocalModelStatus;
	engine: LocalEngineStatus | undefined;
	freeBytes: number;
	recommended: boolean;
}) {
	const i18n = useI18n();
	const { t, bytes, explain } = i18n;
	const install = useMutation({
		mutationFn: (variant?: string) => api.installModel(model.id, variant),
	});
	const cancel = useMutation({ mutationFn: () => api.cancelModel(model.id) });
	const remove = useMutation({ mutationFn: () => api.deleteModel(model.id) });
	const error = install.error ?? cancel.error ?? remove.error;

	const installed = model.state === "installed";
	const active = !installed && model.state !== "available";
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
		<li className="flex flex-col overflow-hidden rounded-lg border border-line bg-panel">
			<Demos model={model} />
			<div className="flex flex-1 flex-col gap-3 p-4">
				<div className="flex flex-wrap gap-1.5">
					<FitBadge model={model} recommended={recommended} />
					<span
						className={`rounded-full border px-2.5 py-0.5 text-xs ${COMMERCIAL_STYLE[model.commercial.kind]}`}
					>
						{commercialText(i18n, model.commercial)}
					</span>
				</div>
				<div>
					<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
						<h2 className="font-medium">{model.name}</h2>
						<span
							className={`font-mono text-xs ${installed ? "text-accent" : "text-dim"}`}
						>
							{installed
								? t("models.installed")
								: model.media === "video"
									? t("models.media.video")
									: t("models.media.image")}
						</span>
					</div>
					<p className="mt-0.5 text-xs text-dim">
						{model.author} ·{" "}
						<a
							href={model.licenseUrl}
							target="_blank"
							rel="noreferrer"
							className="underline hover:text-ink"
						>
							{model.license}
						</a>{" "}
						·{" "}
						<a
							href={model.homepage}
							target="_blank"
							rel="noreferrer"
							className="underline hover:text-ink"
						>
							{t("models.page")}
						</a>
					</p>
				</div>
				<p className="text-sm leading-relaxed">{summaryOf(t, model)}</p>
				<ul
					aria-label={t("models.task.label")}
					className="flex flex-wrap gap-1.5"
				>
					{model.tasks.map((task) => (
						<li
							key={task}
							className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-dim"
						>
							{taskText(t, task)}
						</li>
					))}
				</ul>

				{variant ? (
					<div>
						<p>
							<span className="font-mono text-lg">{bytes(model.size)}</span>{" "}
							<span className="text-sm text-dim">{note}</span>
						</p>
						<p className="mt-1 text-sm">
							<span className="font-medium">{variant.label}</span>{" "}
							<span
								className={variant.fit === "gpu" ? "text-dim" : "text-danger"}
							>
								· {fitText(t, variant.fit)}
							</span>
						</p>
						<details className="mt-1 text-xs text-dim">
							<summary className="cursor-pointer hover:text-ink">
								{t("models.files", { count: variant.files.length })}
								{model.variants.length > 1 &&
									` · ${t("models.versions", { count: model.variants.length })}`}
							</summary>
							<ul className="mt-2 flex flex-col gap-1 font-mono">
								{variant.files.map((file) => (
									<li key={file.name} className="flex justify-between gap-4">
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
												{bytes(other.size)} · {fitText(t, other.fit)}
												{other.id === model.variant &&
													` · ${installed ? t("models.variantInstalled") : t("models.recommended")}`}
											</span>
											{!installed && !active && others.includes(other) && (
												<button
													type="button"
													onClick={() => install.mutate(other.id)}
													disabled={install.isPending}
													className="rounded border border-line px-2 py-0.5 hover:border-dim hover:text-ink"
												>
													{t("models.installVersion")}
												</button>
											)}
										</li>
									))}
								</ul>
							)}
						</details>
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

				<div className="mt-auto flex flex-wrap gap-2 pt-1 text-sm">
					{installed && !model.ready && !active && (
						<button
							type="button"
							onClick={() => install.mutate(undefined)}
							disabled={install.isPending}
							className="rounded-md bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-40"
						>
							{t("models.installEngine")}
						</button>
					)}
					{variant && !installed && !active && (
						<button
							type="button"
							onClick={() => install.mutate(undefined)}
							disabled={!fits || install.isPending}
							className="rounded-md bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-40"
						>
							{partial > 0 ? t("models.resume") : t("models.install")}
						</button>
					)}
					{active && (
						<button
							type="button"
							onClick={() => cancel.mutate()}
							disabled={cancel.isPending}
							className="rounded-md border border-line px-4 py-2 hover:border-dim"
						>
							{model.state === "queued"
								? t("common.cancel")
								: t("models.pause")}
						</button>
					)}
					{(installed || partial > 0) && !active && (
						<button
							type="button"
							disabled={remove.isPending}
							onClick={() => {
								const question = installed
									? t("models.deleteConfirm", {
											model: model.name,
											size: bytes(model.reclaimableBytes),
										})
									: t("models.discardConfirm", {
											model: model.name,
											size: bytes(partial),
										});
								if (window.confirm(question)) remove.mutate();
							}}
							className="rounded-md border border-line px-4 py-2 text-dim hover:text-danger"
						>
							{installed ? t("models.delete") : t("models.discard")}
						</button>
					)}
				</div>
			</div>
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

/** What Hatchlight found on this computer, and what it will run models with. */
function Machine({ view }: { view: LocalModelsView }) {
	const { t, bytes } = useI18n();
	const { hardware, engines } = view;
	const gpu = hardware.gpus.toSorted(
		(a, b) => b.memoryBytes - a.memoryBytes,
	)[0];
	const label = "font-mono text-[11px] uppercase tracking-wider text-dim";
	return (
		<dl className="mt-6 grid gap-x-10 gap-y-4 sm:grid-cols-2">
			<div>
				<dt className={label}>{t("models.machine.computer")}</dt>
				<dd className="mt-1 text-sm">
					{gpu
						? `${gpu.name} · ${bytes(gpu.memoryBytes)}`
						: t("models.machine.noGpu")}
					<span className="text-dim">
						{" "}
						·{" "}
						{t("models.machine.memory", { size: bytes(hardware.memoryBytes) })}
						{hardware.wsl && " · WSL"}
					</span>
				</dd>
			</div>
			<div>
				<dt className={label}>{t("models.machine.engine")}</dt>
				<dd className="mt-1 text-sm">
					{engines.length === 0 ? (
						<span className="text-danger">{t("models.machine.noEngine")}</span>
					) : (
						engines.map((engine) => (
							<span key={engine.engine}>
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
		</dl>
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

const chip =
	"rounded-full border border-line px-3.5 py-1.5 text-sm text-dim transition-colors hover:text-ink aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-bg";

/** Every model, narrowed by what it does and how it suits this computer. */
function Catalog({ view }: { view: LocalModelsView }) {
	const { t } = useI18n();
	const [filter, setFilter] = useState<LocalFilter>(NO_FILTER);
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
		<div className="mt-8">
			<fieldset className="flex flex-col gap-3">
				<legend className="sr-only">{t("models.filter.label")}</legend>
				<div className="flex flex-wrap gap-2">
					{(["all", ...CATEGORIES] as const).map((category) => (
						<button
							key={category}
							type="button"
							aria-pressed={filter.category === category}
							onClick={() => set({ category })}
							className={chip}
						>
							{categoryText(t, category)}{" "}
							<span className="font-mono text-xs opacity-60">
								{count(category)}
							</span>
						</button>
					))}
				</div>
				<div className="flex flex-wrap gap-2">
					{toggles.map((toggle) => (
						<button
							key={toggle.key}
							type="button"
							aria-pressed={filter[toggle.key]}
							onClick={() => set({ [toggle.key]: !filter[toggle.key] })}
							className={`${chip} text-xs`}
						>
							{filter[toggle.key] ? "✓ " : ""}
							{toggle.text}
						</button>
					))}
				</div>
			</fieldset>
			{shown.length === 0 ? (
				<p className="mt-8 text-sm text-dim">
					{t("models.filter.none")}{" "}
					<button
						type="button"
						onClick={() => setFilter(NO_FILTER)}
						className="underline hover:text-ink"
					>
						{t("models.filter.clear")}
					</button>
				</p>
			) : (
				shelves.map(
					(shelf) =>
						shelf.models.length > 0 && (
							<section
								key={shelf.category}
								aria-label={categoryText(t, shelf.category)}
								className="mt-8"
							>
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<h2 className="font-display text-xl font-bold tracking-tight">
										{categoryText(t, shelf.category)}
									</h2>
									<p className="text-sm text-dim">
										{categoryBody(t, shelf.category)}
									</p>
								</div>
								<ul className="mt-3 grid gap-4 lg:grid-cols-2">
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
		<div className="min-w-0 flex-1 basis-80">
			<dt className="font-mono text-[11px] uppercase tracking-wider text-dim">
				{t("models.disk.path")}
			</dt>
			<dd className="pt-1">
				{moving ? (
					<div className="flex flex-col gap-1.5">
						<p className="truncate text-sm" title={moving.to}>
							{t("models.folder.moving", { path: moving.to })}
						</p>
						<div
							role="progressbar"
							aria-label={t("models.folder.moving", { path: moving.to })}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={percent}
							className="h-1.5 overflow-hidden rounded-full bg-line"
						>
							<div
								className="h-full rounded-full bg-accent transition-[width] duration-300"
								style={{ width: `${percent}%` }}
							/>
						</div>
						<p className="font-mono text-xs text-dim">
							{t("models.folder.moved", {
								moved: bytes(moving.movedBytes),
								total: bytes(moving.totalBytes),
							})}
						</p>
					</div>
				) : editing ? (
					<form
						className="flex flex-col gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							move.mutate();
						}}
					>
						<input
							value={path}
							onChange={(event) => setPath(event.target.value)}
							aria-label={t("models.folder.label")}
							spellCheck={false}
							// biome-ignore lint/a11y/noAutofocus: the form opens on request
							autoFocus
							className="rounded-md border border-line bg-panel px-3 py-2 font-mono text-sm focus:border-dim focus:outline-none"
						/>
						<p className="text-xs leading-relaxed text-dim">
							{t("models.folder.hint", { size: bytes(disk.usedBytes) })}
						</p>
						{move.error && (
							<p className="text-sm text-danger">{explain(move.error)}</p>
						)}
						<div className="flex gap-2">
							<button
								type="submit"
								disabled={move.isPending || !path.trim()}
								className="rounded-md bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-40"
							>
								{t("models.folder.move")}
							</button>
							<button
								type="button"
								onClick={() => {
									setEditing(false);
									move.reset();
								}}
								className="rounded-md border border-line px-4 py-2 hover:border-dim"
							>
								{t("common.cancel")}
							</button>
						</div>
					</form>
				) : (
					<div className="flex min-w-0 items-center gap-3">
						<span className="truncate font-mono text-sm" title={disk.path}>
							{disk.path}
						</span>
						{changeable && (
							<button
								type="button"
								onClick={() => {
									setPath(disk.path);
									setEditing(true);
								}}
								className="shrink-0 rounded border border-line px-2 py-0.5 text-xs hover:border-dim hover:text-ink"
							>
								{t("models.folder.change")}
							</button>
						)}
					</div>
				)}
				{disk.moveError && !moving && !editing && (
					<p className="mt-1 text-sm text-danger">{explain(disk.moveError)}</p>
				)}
			</dd>
		</div>
	);
}

export function Models() {
	const { t, bytes, explain } = useI18n();
	const view = useQuery({
		queryKey: ["local-models"],
		queryFn: api.localModels,
	});
	const disk = view.data?.disk;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-6">
			<div className="mx-auto max-w-5xl">
				<h1 className="font-display text-4xl leading-none font-extrabold tracking-tight">
					{t("models.title")}
				</h1>
				<p className="mt-2 max-w-2xl text-sm leading-relaxed text-dim">
					{t("models.intro")}
				</p>
				{view.error && (
					<p className="mt-6 text-sm text-danger">{explain(view.error)}</p>
				)}
				{view.data && <Machine view={view.data} />}
				{disk && (
					<dl className="mt-6 flex flex-wrap gap-x-10 gap-y-3">
						<div>
							<dt className="font-mono text-[11px] uppercase tracking-wider text-dim">
								{t("models.disk.used")}
							</dt>
							<dd className="font-mono text-lg">
								{disk.usedBytes > 0
									? bytes(disk.usedBytes)
									: t("models.disk.nothing")}
							</dd>
						</div>
						<div>
							<dt className="font-mono text-[11px] uppercase tracking-wider text-dim">
								{t("models.disk.free")}
							</dt>
							<dd className="font-mono text-lg">{bytes(disk.freeBytes)}</dd>
						</div>
						<Folder disk={disk} />
					</dl>
				)}
				<CheckpointShelf />
				<LoraShelf />
				{view.data && <Catalog view={view.data} />}
			</div>
		</div>
	);
}
