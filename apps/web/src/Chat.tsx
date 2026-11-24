import { storedValue } from "@hatchlight/core/legacy";
import type { JobView, ModelSpec, TurnView } from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type CSSProperties,
	type Dispatch,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import { api, assetUrl, previewUrl, type SessionDetail } from "./api";
import { Composer, type Draft } from "./Composer";
import { DevelopedImage, LatentFrame } from "./Develop";
import { duration, usd } from "./format";
import { Inspector } from "./Inspector";
import { type I18n, useI18n } from "./i18n";
import { Lightbox, type LightboxItem } from "./Lightbox";
import { type JobProgress, useProgress } from "./live";
import { href, navigate } from "./route";
import { Welcome } from "./Welcome";

const WELCOMED_KEY = "hatchlight.welcomed";

/** Whether this browser has been through the welcome, or skipped it. */
function welcomed(): boolean {
	try {
		return storedValue(localStorage, WELCOMED_KEY) === "1";
	} catch {
		return false;
	}
}

function markWelcomed(): void {
	try {
		localStorage.setItem(WELCOMED_KEY, "1");
	} catch {
		// Without storage, the welcome shows again while there are no sessions.
	}
}

interface Props {
	sessionId?: string;
	references: string[];
	setReferences: Dispatch<SetStateAction<string[]>>;
	addReference(assetId: string): void;
}

function Elapsed({ since }: { since: number }) {
	const i18n = useI18n();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(timer);
	}, []);
	return <>{duration(i18n, now - since)}</>;
}

export function JobCard(props: {
	index: number;
	job: JobView;
	prompt: string;
	model: ModelSpec | undefined;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
	/** Makes a picture larger, when an upscaler is installed: by how much. */
	upscale?: { factor: number; busy: boolean; run(assetId: string): void };
}) {
	const { job, model } = props;
	const i18n = useI18n();
	const { t } = i18n;
	const progress = useProgress(job.id);
	const cancel = useMutation({ mutationFn: () => api.cancelJob(job.id) });
	const retry = useMutation({ mutationFn: () => api.retryJob(job.id) });
	const name = model?.name ?? job.modelId;
	const pending = job.status === "queued" || job.status === "running";
	// Pictures that finish while watched develop; ones already done just appear.
	const watched = useRef(pending);
	// Once the model has shown the picture forming, the final one continues
	// from there rather than starting over from noise.
	const shown = useRef(false);
	if (progress?.preview) shown.current = true;
	const [width, height] = (
		job.params.aspectRatio ?? (model?.media === "video" ? "16:9" : "1:1")
	)
		.split(":")
		.map(Number);

	return (
		<section
			className="rise-in flex min-w-0 flex-col rounded-lg border border-line bg-panel transition-colors hover:border-line-strong"
			style={{ "--i": props.index } as CSSProperties}
		>
			<header className="flex items-baseline justify-between gap-3 border-b border-line px-3 py-2">
				<h3 className="truncate text-sm font-medium">
					{name}
					<span className="ml-2 font-mono text-[11px] font-normal uppercase tracking-wider text-dim">
						{job.providerId}
					</span>
				</h3>
				<p className="shrink-0 font-mono text-xs tabular-nums text-dim">
					{job.status === "queued" && t("job.queued")}
					{job.status === "running" && job.startedAt && (
						<Elapsed since={job.startedAt} />
					)}
					{job.status === "succeeded" && job.startedAt && job.finishedAt && (
						<>
							{duration(i18n, job.finishedAt - job.startedAt)}
							{job.costUsd != null &&
								` · ${job.costUsd === 0 ? t("picker.free") : usd(i18n, job.costUsd)}`}
						</>
					)}
					{job.status === "failed" && (
						<span className="text-danger">{t("job.failed")}</span>
					)}
					{job.status === "canceled" && t("job.canceled")}
				</p>
			</header>

			<div className="flex flex-1 flex-col gap-2 p-2">
				{pending && (
					<>
						<LatentFrame
							ratio={(width || 1) / (height || 1)}
							fraction={
								job.status === "running" ? progress?.fraction : undefined
							}
							preview={
								progress?.preview
									? previewUrl(job.id, progress.preview)
									: undefined
							}
						/>
						{/* Below the picture, so nothing covers it while it forms. */}
						<div className="flex items-center justify-between gap-3 px-1">
							<p
								className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink"
								aria-live="polite"
							>
								<i
									aria-hidden="true"
									className={`breathe size-2 shrink-0 rounded-full ${job.status === "queued" ? "bg-dim" : "bg-accent shadow-[0_0_10px_var(--accent)]"}`}
								/>
								<span className="truncate">
									{job.status === "running" || progress?.stage === "queued"
										? describeProgress(i18n, progress)
										: t("job.waiting")}
								</span>
							</p>
							<button
								type="button"
								onClick={() => cancel.mutate()}
								disabled={cancel.isPending}
								className="shrink-0 rounded-full border border-line-strong px-3 py-1 text-xs text-dim hover:text-ink"
							>
								{t("common.cancel")}
							</button>
						</div>
					</>
				)}
				{(job.status === "failed" || job.status === "canceled") && (
					<div className="flex items-start justify-between gap-3 p-2">
						{job.status === "failed" ? (
							<p className="text-sm leading-relaxed text-danger">
								{i18n.explain({
									message: job.error ?? "",
									code: job.errorCode,
									params: job.errorParams,
								})}
							</p>
						) : (
							<p className="text-sm text-dim">{t("job.canceledEarly")}</p>
						)}
						{retry.error && (
							<p className="text-sm text-danger">{i18n.explain(retry.error)}</p>
						)}
						<button
							type="button"
							onClick={() => retry.mutate()}
							disabled={retry.isPending}
							className="shrink-0 rounded-full border border-line-strong px-3 py-1 text-xs text-ink hover:border-ink"
						>
							{t("job.retry")}
						</button>
					</div>
				)}
				<div
					className={
						job.assets.length > 1 ? "grid grid-cols-2 gap-2" : "contents"
					}
				>
					{job.assets.map((asset) => {
						const open = () =>
							props.onOpen({
								assetId: asset.id,
								mime: asset.mime,
								prompt: props.prompt,
								modelName: name,
								params: job.params,
								costUsd:
									job.costUsd == null ? null : job.costUsd / job.assets.length,
							});
						const overlay =
							"absolute rounded-md bg-black/75 px-2 py-1 text-xs text-white opacity-0 focus-visible:opacity-100 group-hover:opacity-100";
						return asset.mime.startsWith("video/") ? (
							<div key={asset.id} className="group relative">
								{/* biome-ignore lint/a11y/useMediaCaption: generated clips have no transcript */}
								<video
									src={assetUrl(asset.id)}
									aria-label={`${name}: ${props.prompt}`}
									controls
									loop
									playsInline
									preload="metadata"
									className="print-in w-full rounded-md bg-black"
								/>
								<button
									type="button"
									onClick={open}
									className={`${overlay} right-2 top-2`}
								>
									{t("job.details")}
								</button>
							</div>
						) : (
							<div key={asset.id} className="group relative">
								<button
									type="button"
									aria-label={t("job.openImage", { model: name })}
									onClick={open}
									className="block w-full"
								>
									<DevelopedImage
										src={assetUrl(asset.id)}
										alt={`${name}: ${props.prompt}`}
										fresh={watched.current}
										from={shown.current ? 0.85 : 0}
										ratio={(width || 1) / (height || 1)}
										className="w-full rounded-md"
									/>
								</button>
								<button
									type="button"
									onClick={() => props.onUseAsReference(asset.id)}
									className={`${overlay} bottom-2 left-2`}
								>
									{t("common.useAsReference")}
								</button>
								{props.upscale && model?.capabilities.upscale == null && (
									<button
										type="button"
										onClick={() => props.upscale?.run(asset.id)}
										disabled={props.upscale.busy}
										className={`${overlay} right-2 bottom-2 disabled:opacity-40`}
									>
										{t("job.upscale", {
											factor: i18n.number(props.upscale.factor),
										})}
									</button>
								)}
							</div>
						);
					})}
				</div>
				{job.params.translatedPrompt && (
					// What the model was sent, in a language the person may not
					// read: there for the curious, out of the way otherwise.
					<details className="px-1 text-xs leading-relaxed text-dim">
						<summary className="w-fit cursor-pointer hover:text-ink">
							{t("job.details")}
						</summary>
						<p className="mt-1">
							{t("job.translated")}{" "}
							<span className="text-ink">{job.params.translatedPrompt}</span>
						</p>
					</details>
				)}
			</div>
		</section>
	);
}

function TurnBlock(props: {
	turn: TurnView;
	/** Which turn it is, and how it was asked for. */
	label: string;
	models: Map<string, ModelSpec>;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
	upscale?: { factor: number; busy: boolean; run(assetId: string): void };
}) {
	const { turn } = props;
	const { t } = useI18n();
	const columns = Math.min(turn.jobs.length, 3);
	return (
		<article className="flex flex-col gap-3">
			<p className="font-mono text-[11px] uppercase tracking-wider text-dim">
				{props.label}
			</p>
			<div className="rise-in flex items-start gap-3">
				{turn.referenceAssetIds.map((id) => (
					<img
						key={id}
						src={assetUrl(id)}
						alt={t("common.reference")}
						className="size-12 shrink-0 rounded-md border border-line object-cover"
					/>
				))}
				<p className="whitespace-pre-wrap text-lg leading-snug">
					<span
						aria-hidden="true"
						className="mr-2 align-middle font-mono text-[11px] tracking-wider text-accent"
					>
						▸
					</span>
					{turn.prompt}
				</p>
			</div>
			<div
				className="grid gap-3 max-md:!grid-cols-1"
				style={{
					gridTemplateColumns: `repeat(${columns}, minmax(0, ${columns === 1 ? "28rem" : "1fr"}))`,
				}}
			>
				{turn.jobs.map((job, index) => (
					<JobCard
						key={job.id}
						index={index}
						job={job}
						prompt={turn.prompt}
						model={props.models.get(job.modelId)}
						onOpen={props.onOpen}
						onUseAsReference={props.onUseAsReference}
						upscale={props.upscale}
					/>
				))}
			</div>
		</article>
	);
}

/** What a running job is doing, in the reader's language. */
function describeProgress(
	i18n: I18n,
	progress: JobProgress | undefined,
): string {
	if (!progress) return i18n.t("job.starting");
	const percent =
		progress.fraction == null
			? null
			: i18n.number(progress.fraction, { style: "percent" });
	// Local models say which sampling step they are on.
	if (progress.stage === "generating" && progress.step && progress.steps) {
		return i18n.t("progress.step", {
			step: progress.step,
			steps: progress.steps,
		});
	}
	const stage =
		progress.stage === "queued"
			? progress.position != null
				? i18n.t("progress.queuedAt", { position: progress.position })
				: i18n.t("progress.queued")
			: progress.stage === "retrying"
				? i18n.t("progress.retrying")
				: progress.stage === "translating"
					? i18n.t("progress.translating")
					: progress.stage === "waitingGpu"
						? i18n.t("progress.waitingGpu")
						: progress.stage === "starting"
							? i18n.t("progress.starting")
							: progress.stage === "loading"
								? i18n.t("progress.loading")
								: progress.stage === "generating"
									? i18n.t("progress.generating")
									: progress.message;
	return [stage, percent].filter(Boolean).join(" · ") || i18n.t("job.starting");
}

export function Chat({
	sessionId,
	references,
	setReferences,
	addReference,
}: Props) {
	const i18n = useI18n();
	const { t } = i18n;
	const client = useQueryClient();
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const providers = useQuery({
		queryKey: ["providers"],
		queryFn: api.providers,
	});
	const session = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => api.session(sessionId as string),
		enabled: sessionId != null,
	});
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
	const [skipped, setSkipped] = useState(welcomed);
	// A first visit: nothing made yet, so show the way to a first picture.
	const firstRun = !sessionId && !skipped && sessions.data?.length === 0;
	// Until the sessions arrive it is unknown whether this is a first visit.
	const deciding = !sessionId && !skipped && sessions.isPending;
	const [open, setOpen] = useState<LightboxItem | null>(null);
	// The picture in the inspector, once one is chosen.
	const [selected, setSelected] = useState<LightboxItem | null>(null);

	const create = useMutation({
		mutationFn: (draft: Draft & { referenceAssetIds?: string[] }) =>
			api.createTurn({
				...draft,
				sessionId,
				referenceAssetIds: draft.referenceAssetIds ?? references,
			}),
		onSuccess: ({ session: created, turn }, draft) => {
			markWelcomed();
			// Drop only what was sent from the composer; more may have been
			// added meanwhile. A turn that brought its own pictures sent none.
			if (!draft.referenceAssetIds) {
				setReferences((current) =>
					current.filter((id) => !turn.referenceAssetIds.includes(id)),
				);
			}
			client.setQueryData<SessionDetail>(["session", created.id], (current) =>
				current?.turns.some((t) => t.id === turn.id)
					? current
					: {
							...(current ?? created),
							turns: [...(current?.turns ?? []), turn],
						},
			);
			void client.invalidateQueries({ queryKey: ["session", created.id] });
			void client.invalidateQueries({ queryKey: ["sessions"] });
			// Follow the new session unless the user has already gone elsewhere.
			if (
				!sessionId &&
				["", "#", href.newChat].includes(window.location.hash)
			) {
				navigate(href.session(created.id));
			}
		},
	});

	const byId = new Map(models.data?.map((m) => [m.id, m]));
	// An installed upscaler enlarges any picture made, as a turn of its own.
	const upscaler = models.data?.find((m) => m.capabilities.upscale != null);
	const factor = upscaler?.capabilities.upscale;
	const upscale =
		upscaler && factor != null
			? {
					factor,
					busy: create.isPending,
					run: (assetId: string) =>
						create.mutate({
							prompt: t("job.upscale", { factor: i18n.number(factor) }),
							modelIds: [upscaler.id],
							count: 1,
							referenceAssetIds: [assetId],
						}),
				}
			: undefined;
	const loadError = session.error ?? models.error ?? providers.error;
	const assistant = useQuery({
		queryKey: ["assistant", sessionId],
		queryFn: () => api.assistantView(sessionId as string),
		enabled: sessionId != null,
	});
	// Turns the assistant made, to say they were asked for in the chat.
	const fromChat = new Set(
		assistant.data?.entries.flatMap((e) => (e.turnId ? [e.turnId] : [])),
	);
	const turns = session.data?.turns ?? [];
	// Until one is chosen, the newest picture made is shown.
	const latest = turns
		.toReversed()
		.flatMap((turn) =>
			turn.jobs.flatMap((job) =>
				job.assets.map((asset) =>
					itemOf(turn, job, asset, byId.get(job.modelId)),
				),
			),
		)[0];
	const shown = selected ?? latest ?? null;

	return (
		<>
			{firstRun ? (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto max-w-5xl p-6">
						<Welcome
							busy={create.isPending}
							error={create.error ? i18n.explain(create.error) : null}
							onSubmit={(draft) => create.mutate(draft)}
							onSkip={() => {
								markWelcomed();
								setSkipped(true);
							}}
						/>
					</div>
				</div>
			) : (
				!deciding && (
					<div className="grid min-h-0 flex-1 max-lg:overflow-y-auto lg:grid-cols-[17rem_minmax(0,1fr)_19rem]">
						<Composer
							models={models.data ?? []}
							providers={providers.data ?? []}
							references={references}
							setReferences={setReferences}
							busy={create.isPending}
							error={create.error ? i18n.explain(create.error) : null}
							onSubmit={(draft) => create.mutate(draft)}
						>
							<div className="flex flex-col gap-10 p-6">
								{loadError && (
									<p className="text-sm text-danger">
										{i18n.explain(loadError)}
									</p>
								)}
								{!sessionId && sessions.data && (
									<div className="rise-in py-6">
										<p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
											{t("chat.eyebrow")}
										</p>
										<h1 className="mt-3 font-display text-5xl leading-[0.95] font-extrabold tracking-tight">
											{t("chat.heading")}
										</h1>
										<p className="mt-4 max-w-xl leading-relaxed text-dim">
											{t("chat.intro")}
										</p>
									</div>
								)}
								{turns
									.map((turn, index) => (
										<TurnBlock
											key={turn.id}
											turn={turn}
											label={[
												t("chat.turn", { number: index + 1 }),
												fromChat.has(turn.id) && t("chat.askedInChat"),
												turn.jobs[0]?.params.aspectRatio,
											]
												.filter(Boolean)
												.join(" · ")}
											models={byId}
											onOpen={setSelected}
											onUseAsReference={addReference}
											upscale={upscale}
										/>
									))
									.toReversed()}
							</div>
						</Composer>
						<Inspector
							item={shown}
							onOpen={setOpen}
							onUseAsReference={addReference}
							upscale={upscale}
							talkHref={sessionId ? href.talk(sessionId) : undefined}
						/>
					</div>
				)
			)}
			{open && (
				<Lightbox
					item={open}
					onClose={() => setOpen(null)}
					onUseAsReference={(id) => {
						addReference(id);
						setOpen(null);
					}}
				/>
			)}
		</>
	);
}

/** A picture or video made, as the inspector and the lightbox show it. */
function itemOf(
	turn: TurnView,
	job: JobView,
	asset: { id: string; mime: string },
	model: ModelSpec | undefined,
): LightboxItem {
	return {
		assetId: asset.id,
		mime: asset.mime,
		prompt: turn.prompt,
		modelName: model?.name ?? job.modelId,
		params: job.params,
		costUsd: job.costUsd == null ? null : job.costUsd / job.assets.length,
	};
}
