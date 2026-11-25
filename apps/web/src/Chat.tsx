import { storedValue } from "@hatchlight/core/legacy";
import {
	type JobView,
	MAX_CHARACTER_REFERENCES,
	type ModelSpec,
	type TurnView,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, Info, Maximize2 } from "lucide-react";
import {
	type CSSProperties,
	type Dispatch,
	type ReactElement,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, assetUrl, previewUrl, type SessionDetail, useDemo } from "./api";
import { Composer, type Draft, ROOMY } from "./Composer";
import {
	blindLetter,
	blindOrder,
	comparesModels,
	hasChoice,
	namesHidden,
} from "./compare";
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

/** A small action under a picture, named by its tooltip. */
function PictureAction(props: {
	label: string;
	icon: ReactElement;
	disabled?: boolean;
	onClick(): void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={props.label}
						disabled={props.disabled}
						onClick={props.onClick}
						className="text-dim hover:text-ink max-md:size-10"
					/>
				}
			>
				{props.icon}
			</TooltipTrigger>
			<TooltipContent>{props.label}</TooltipContent>
		</Tooltip>
	);
}

/** A result's place in its turn's comparison: its name, and picking the best. */
export interface Comparison {
	/** The model's name, or a letter while the names are hidden. */
	name: string;
	/** The names are hidden, and so are the time and cost that would tell them. */
	hidden: boolean;
	/** There is more than one result to choose the best of. */
	canPick: boolean;
	picked: string | null;
	busy: boolean;
	onPick(assetId: string | null): void;
}

/**
 * A turn's results as a comparison: in a blind order when the person hides
 * the names until they pick, and the way to pick the best.
 */
export function useComparison(
	turn: TurnView,
	models: Map<string, ModelSpec>,
): {
	jobs: JobView[];
	error: unknown;
	of(job: JobView, index: number): Comparison;
} {
	const { t } = useI18n();
	const client = useQueryClient();
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const pick = useMutation({
		mutationFn: (assetId: string | null) => api.pick(turn.id, assetId),
		onSuccess: (_, assetId) => {
			client.setQueryData<SessionDetail>(
				["session", turn.sessionId],
				(current) =>
					current && {
						...current,
						turns: current.turns.map((each) =>
							each.id === turn.id ? { ...each, pickedAssetId: assetId } : each,
						),
					},
			);
			void client.invalidateQueries({ queryKey: ["ranking"] });
			void client.invalidateQueries({ queryKey: ["gallery"] });
		},
	});
	const blind = settings.data?.blindPicks === true;
	const hidden = namesHidden(turn, blind);
	const canPick = hasChoice(turn);
	return {
		jobs:
			blind && comparesModels(turn)
				? blindOrder(turn.jobs, turn.id)
				: turn.jobs,
		error: pick.error,
		of: (job, index) => ({
			name: hidden
				? t("compare.blindName", { letter: blindLetter(index) })
				: (models.get(job.modelId)?.name ?? job.modelId),
			hidden,
			canPick,
			picked: turn.pickedAssetId ?? null,
			busy: pick.isPending,
			onPick: (assetId) => pick.mutate(assetId),
		}),
	};
}

/** Marks a result as the best of its comparison, or clears the mark. */
function PickButton(props: {
	label: string;
	picked: boolean;
	busy: boolean;
	onClick(): void;
}) {
	const { t } = useI18n();
	return (
		<Button
			variant={props.picked ? "default" : "outline"}
			size="sm"
			aria-pressed={props.picked}
			aria-label={
				props.picked
					? t("compare.pickedLabel", { name: props.label })
					: t("compare.pickLabel", { name: props.label })
			}
			disabled={props.busy}
			onClick={props.onClick}
			// On a narrow card only its mark shows, so the name keeps its room;
			// the label says it all to a screen reader either way.
			className="h-8 gap-1 px-2.5 font-sans text-xs max-md:h-10 @max-[17rem]:w-8 @max-[17rem]:px-0 max-md:@max-[17rem]:w-10"
		>
			<Check aria-hidden="true" />
			<span className="@max-[17rem]:hidden">
				{props.picked ? t("compare.picked") : t("compare.pick")}
			</span>
		</Button>
	);
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
	compare?: Comparison;
}) {
	const { job, model, compare } = props;
	const i18n = useI18n();
	const { t } = i18n;
	const progress = useProgress(job.id);
	const cancel = useMutation({ mutationFn: () => api.cancelJob(job.id) });
	const retry = useMutation({ mutationFn: () => api.retryJob(job.id) });
	const name = compare?.name ?? model?.name ?? job.modelId;
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
	const ratio = (width || 1) / (height || 1);
	const fraction = job.status === "running" ? progress?.fraction : undefined;
	const several = job.assets.length > 1;
	// How long it took and what it cost, under each picture it made.
	const took =
		!compare?.hidden &&
		job.status === "succeeded" &&
		job.startedAt &&
		job.finishedAt
			? [
					duration(i18n, job.finishedAt - job.startedAt),
					job.costUsd != null &&
						(job.costUsd === 0 ? t("picker.free") : usd(i18n, job.costUsd)),
				]
					.filter(Boolean)
					.join(" · ")
			: null;

	return (
		<article
			aria-label={name}
			className="rise-in flex min-w-0 flex-col gap-2"
			style={{ "--i": props.index } as CSSProperties}
		>
			{pending && (
				<>
					<LatentFrame
						ratio={ratio}
						fraction={fraction}
						preview={
							progress?.preview
								? previewUrl(job.id, progress.preview)
								: undefined
						}
					/>
					{/* Below the picture, so nothing covers it while it forms. */}
					{/* Name and Cancel, then what is happening, then the bar: a
					    narrow card still shows each in full. */}
					<div className="flex flex-col gap-1.5 font-mono text-xs text-[#a1a1aa]">
						<div className="flex min-h-8 items-center gap-2.5">
							<i
								aria-hidden="true"
								className={cn(
									"breathe size-2 shrink-0 rounded-full",
									job.status === "queued"
										? "bg-dim"
										: "bg-orange shadow-[0_0_12px_var(--orange)]",
								)}
							/>
							<span className="min-w-0 flex-1 truncate">{name}</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() => cancel.mutate()}
								disabled={cancel.isPending}
								className="font-sans max-md:h-10"
							>
								{t("common.cancel")}
							</Button>
						</div>
						<div className="flex items-center gap-2.5 text-dim">
							<span className="min-w-0 flex-1 truncate" aria-live="polite">
								{job.status === "running" || progress?.stage === "queued"
									? describeProgress(i18n, progress)
									: t("job.waiting")}
							</span>
							{job.status === "running" && job.startedAt && (
								<span className="shrink-0 tabular-nums">
									<Elapsed since={job.startedAt} />
								</span>
							)}
						</div>
						<div
							aria-hidden="true"
							className="h-1 overflow-hidden rounded-full bg-line"
						>
							{job.status === "running" && (
								<div
									className={cn(
										"flow h-full transition-[width] duration-500",
										fraction == null && "w-full opacity-60",
									)}
									style={
										fraction == null
											? undefined
											: { width: `${Math.round(fraction * 100)}%` }
									}
								/>
							)}
						</div>
						{job.status === "running" && progress?.busyBytes != null && (
							<p className="text-dim">
								{t("progress.lowMemory", {
									size: i18n.bytes(progress.busyBytes),
								})}
							</p>
						)}
					</div>
				</>
			)}
			{(job.status === "failed" || job.status === "canceled") && (
				<div className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4">
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
					<div className="flex items-center justify-between gap-3">
						<span className="min-w-0 truncate font-mono text-xs text-dim">
							{name}
						</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => retry.mutate()}
							disabled={retry.isPending}
							className="max-md:h-10"
						>
							{t("job.retry")}
						</Button>
					</div>
				</div>
			)}
			{/* What it made was deleted since: the turn keeps its place. */}
			{job.status === "succeeded" && job.assets.length === 0 && (
				<p
					className="flex w-full items-center justify-center rounded-2xl border border-dashed border-line text-sm text-dim"
					style={{ aspectRatio: ratio }}
				>
					{t("job.deleted")}
				</p>
			)}
			{job.assets.length > 0 && (
				<div className={several ? "grid grid-cols-2 gap-2.5" : "contents"}>
					{job.assets.map((asset, position) => {
						const open = () =>
							props.onOpen({
								assetId: asset.id,
								mime: asset.mime,
								prompt: props.prompt,
								modelName: name,
								params: job.params,
								costUsd:
									job.costUsd == null || compare?.hidden
										? null
										: job.costUsd / job.assets.length,
							});
						const video = asset.mime.startsWith("video/");
						const label = several
							? `${name} · ${i18n.number(position + 1)}`
							: name;
						const picked = compare?.picked === asset.id;
						return (
							<figure
								key={asset.id}
								className={cn(
									// The mark of a pick is drawn inside the card, so nothing
									// around it cuts it off or covers the caption.
									"@container flex min-w-0 flex-col gap-1.5 rounded-[1.15rem] transition-shadow",
									compare?.canPick && "p-1.5",
									picked && "ring-2 ring-orange",
								)}
							>
								{video ? (
									// biome-ignore lint/a11y/useMediaCaption: generated clips have no transcript
									<video
										src={assetUrl(asset.id)}
										aria-label={`${name}: ${props.prompt}`}
										controls
										loop
										playsInline
										preload="metadata"
										className="print-in w-full rounded-2xl bg-black"
									/>
								) : (
									<button
										type="button"
										aria-label={t("job.openImage", { model: name })}
										onClick={open}
										className="block w-full rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
									>
										<DevelopedImage
											src={assetUrl(asset.id)}
											alt={`${name}: ${props.prompt}`}
											fresh={watched.current}
											from={shown.current ? 0.85 : 0}
											ratio={ratio}
											className="w-full rounded-2xl"
										/>
									</button>
								)}
								{/* The actions move under the name when the card is too narrow
								    for both: they never cover it, nor each other. */}
								<figcaption className="flex min-h-8 flex-wrap items-center gap-1 font-mono text-xs text-dim">
									{/* The name on its own line, so narrow cards keep it whole. */}
									<span className="flex min-w-0 flex-[1_1_5rem] flex-col gap-0.5">
										<span className="truncate text-[#a1a1aa]">{label}</span>
										{took && (
											<span className="truncate tabular-nums">{took}</span>
										)}
									</span>
									<span className="flex min-w-0 flex-wrap items-center gap-0.5">
										{compare?.canPick && (
											<PickButton
												label={label}
												picked={picked}
												busy={compare.busy}
												onClick={() => compare.onPick(picked ? null : asset.id)}
											/>
										)}
										{video ? (
											<PictureAction
												label={t("job.details")}
												icon={<Info />}
												onClick={open}
											/>
										) : (
											<>
												<PictureAction
													label={t("common.useAsReference")}
													icon={<ImagePlus />}
													onClick={() => props.onUseAsReference(asset.id)}
												/>
												{props.upscale &&
													model?.capabilities.upscale == null && (
														<PictureAction
															label={t("job.upscale", {
																factor: i18n.number(props.upscale.factor),
															})}
															icon={<Maximize2 />}
															disabled={props.upscale.busy}
															onClick={() => props.upscale?.run(asset.id)}
														/>
													)}
											</>
										)}
									</span>
								</figcaption>
							</figure>
						);
					})}
				</div>
			)}
			{job.params.translatedPrompt && (
				// What the model was sent, in a language the person may not
				// read: there for the curious, out of the way otherwise.
				<Collapsible className="text-xs leading-relaxed text-dim">
					<CollapsibleTrigger className="min-h-8 rounded-sm outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50">
						{t("job.details")}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<p>
							{t("job.translated")}{" "}
							<span className="text-ink">{job.params.translatedPrompt}</span>
						</p>
					</CollapsibleContent>
				</Collapsible>
			)}
		</article>
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
	const i18n = useI18n();
	const { t } = i18n;
	const comparison = useComparison(turn, props.models);
	return (
		<article className="flex flex-col gap-3.5">
			<header className="rise-in flex flex-col gap-1 md:flex-row md:items-baseline md:gap-3">
				<span className="shrink-0 font-mono text-[11px] tracking-[0.14em] text-dim uppercase">
					{props.label}
				</span>
				<p className="whitespace-pre-wrap leading-snug text-[#e4e4e7]">
					{turn.prompt}
				</p>
			</header>
			{turn.referenceAssetIds.length > 0 && (
				<div className="flex gap-2">
					{turn.referenceAssetIds.map((id) => (
						<img
							key={id}
							src={assetUrl(id)}
							alt={t("common.reference")}
							// A reference deleted since leaves an empty frame, not a broken one.
							onError={(event) => {
								event.currentTarget.style.visibility = "hidden";
							}}
							className="size-12 shrink-0 rounded-[10px] border border-line object-cover"
						/>
					))}
				</div>
			)}
			<div
				className={cn(
					"grid gap-3.5",
					turn.jobs.length > 1 ? "sm:grid-cols-2" : "max-w-xl",
				)}
			>
				{comparison.jobs.map((job, index) => (
					<JobCard
						key={job.id}
						index={index}
						job={job}
						prompt={turn.prompt}
						model={props.models.get(job.modelId)}
						onOpen={props.onOpen}
						onUseAsReference={props.onUseAsReference}
						upscale={props.upscale}
						compare={comparison.of(job, index)}
					/>
				))}
			</div>
			{comparison.error != null && (
				<p className="text-sm text-danger">{i18n.explain(comparison.error)}</p>
			)}
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
							: progress.stage === "loading" || progress.stage === "lowMemory"
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
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const [skipped, setSkipped] = useState(welcomed);
	// A first visit: nothing made yet, so show the way to a first picture.
	const firstRun = !sessionId && !skipped && sessions.data?.length === 0;
	// Until the sessions arrive it is unknown whether this is a first visit.
	const deciding = !sessionId && !skipped && sessions.isPending;
	const [open, setOpen] = useState<LightboxItem | null>(null);
	// The picture in the inspector, once one is chosen.
	const [selected, setSelected] = useState<LightboxItem | null>(null);
	// On narrow screens the inspector opens over the turns.
	const [inspecting, setInspecting] = useState(false);
	// The picture of a series' character, chosen in this session.
	const [character, setCharacter] = useState<{
		sessionId: string | undefined;
		assetId: string;
	} | null>(null);

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
	const demo = useDemo() !== null;
	const assistant = useQuery({
		queryKey: ["assistant", sessionId],
		queryFn: () => api.assistantView(sessionId as string),
		// A public demo has no assistant.
		enabled: sessionId != null && !demo,
	});
	// Turns the assistant made, to say they were asked for in the chat.
	const fromChat = new Set(
		assistant.data?.entries.flatMap((e) => (e.turnId ? [e.turnId] : [])),
	);
	const turns = session.data?.turns ?? [];
	// Until one is chosen, the newest picture made is shown.
	// In a blind comparison it goes by its letter, as in the turn.
	const latest = turns.toReversed().flatMap((turn) => {
		const hidden = namesHidden(turn, settings.data?.blindPicks === true);
		const order = blindOrder(turn.jobs, turn.id);
		return turn.jobs.flatMap((job) =>
			job.assets.map((asset) =>
				itemOf(
					turn,
					job,
					asset,
					byId.get(job.modelId),
					hidden
						? t("compare.blindName", {
								letter: blindLetter(order.indexOf(job)),
							})
						: undefined,
				),
			),
		);
	})[0];
	const shown = selected ?? latest ?? null;
	const videoIds = new Set(
		turns.flatMap((turn) =>
			turn.jobs.flatMap((job) =>
				job.assets.flatMap((asset) =>
					asset.mime.startsWith("image/") ? [] : [asset.id],
				),
			),
		),
	);
	const characterId =
		character?.sessionId === sessionId ? character?.assetId : undefined;
	// What the chosen picture is compared with: the character, else the
	// reference pictures in the composer.
	const characterOf = (assetId: string) => ({
		references: (characterId ? [characterId] : references)
			// Pictures only: a video in the session cannot be compared.
			.filter((id) => id !== assetId && !videoIds.has(id))
			.slice(0, MAX_CHARACTER_REFERENCES),
		chosen: characterId === assetId,
		choose: (id: string | null) =>
			setCharacter(id ? { sessionId, assetId: id } : null),
	});

	return (
		<>
			{firstRun ? (
				// The welcome's glow spills past the sides by design: cut at the
				// window's edge, not scrolled to.
				<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
					<div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
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
					<div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)] roomy:grid-cols-[300px_minmax(0,1fr)_320px]">
						<Composer
							models={models.data ?? []}
							providers={providers.data ?? []}
							references={references}
							setReferences={setReferences}
							busy={create.isPending}
							error={create.error ? i18n.explain(create.error) : null}
							onSubmit={(draft) => create.mutateAsync(draft)}
							inspector={{
								content: (
									<Inspector
										item={shown}
										onOpen={(item) => {
											setInspecting(false);
											setOpen(item);
										}}
										onUseAsReference={(id) => {
											setInspecting(false);
											addReference(id);
										}}
										upscale={upscale}
										talkHref={
											sessionId && !demo ? href.talk(sessionId) : undefined
										}
										onDeleted={() => {
											setInspecting(false);
											setSelected(null);
										}}
										// A public demo has no model to compare with.
										character={
											shown && !demo ? characterOf(shown.assetId) : undefined
										}
									/>
								),
								chosen: shown != null,
								thumb:
									shown?.mime.startsWith("image/") === true
										? assetUrl(shown.assetId)
										: undefined,
								open: inspecting,
								onOpenChange: setInspecting,
							}}
						>
							<div className="flex flex-col gap-8 px-4 py-5 md:px-7 md:py-6">
								{loadError && (
									<p className="text-sm text-danger">
										{i18n.explain(loadError)}
									</p>
								)}
								{!sessionId && sessions.data && (
									<div className="rise-in py-6 md:py-10">
										<p className="font-mono text-[11px] tracking-[0.18em] text-dim uppercase">
											{t("chat.eyebrow")}
										</p>
										<h1 className="mt-3 font-display text-[40px] leading-[0.95] font-extrabold tracking-[-0.03em] text-balance md:text-5xl">
											{t("chat.heading")}
										</h1>
										<p className="mt-4 max-w-xl leading-relaxed text-soft">
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
											onOpen={(item) => {
												setSelected(item);
												// A sheet below the column width; a column above it.
												setInspecting(!window.matchMedia(ROOMY).matches);
											}}
											onUseAsReference={addReference}
											upscale={upscale}
										/>
									))
									.toReversed()}
							</div>
						</Composer>
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
	/** The letter it goes by while the names are hidden. */
	hiddenName?: string,
): LightboxItem {
	return {
		assetId: asset.id,
		mime: asset.mime,
		prompt: turn.prompt,
		modelName: hiddenName ?? model?.name ?? job.modelId,
		params: job.params,
		costUsd:
			job.costUsd == null || hiddenName != null
				? null
				: job.costUsd / job.assets.length,
	};
}
