import type {
	BestFor,
	Hardware,
	LocalModelStatus,
	Media,
	ModelProfile,
	ModelSpec,
	ProviderStatus,
} from "@hatchlight/core/types";
import { develop, latent, loadImage } from "@hatchlight/motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCan } from "./Accounts";
import { api, demoUrl } from "./api";
import { FRAME_MS, reduceMotion } from "./Develop";
import { remaining, usd } from "./format";
import { type I18n, useI18n } from "./i18n";
import { useModelProgress } from "./live";
import {
	bestCloud,
	bestLocal,
	cloudFamilies,
	type Family,
	type FitLevel,
	fitLevel,
	gpuMemory,
	localFit,
	neededMemory,
	sortLocal,
} from "./recommend";

/** Where each service hands out API keys. */
export const KEY_PAGES: Record<string, string> = {
	fal: "https://fal.ai/dashboard/keys",
	openai: "https://platform.openai.com/api-keys",
	google: "https://aistudio.google.com/apikey",
	replicate: "https://replicate.com/account/api-tokens",
	openrouter: "https://openrouter.ai/settings/keys",
};

/** A model a person can choose: one on this computer, or one in the cloud. */
type Entry =
	| {
			kind: "local";
			key: string;
			profile?: ModelProfile;
			model: LocalModelStatus;
	  }
	| { kind: "cloud"; key: string; profile: ModelProfile; family: Family }
	/** A model the project has not described yet: shown without ratings. */
	| {
			kind: "other";
			key: string;
			profile?: undefined;
			model: ModelSpec;
			ready: boolean;
	  };

const FIT_STYLE: Record<FitLevel, { text: string; bg: string; bar: string }> = {
	great: { text: "text-good", bg: "bg-good/12", bar: "bg-good" },
	slow: { text: "text-warn", bg: "bg-warn/12", bar: "bg-warn" },
	none: { text: "text-danger", bg: "bg-danger/12", bar: "bg-danger" },
};

/** One side of a segmented switch: the one chosen is lit. */
const SEGMENT =
	"h-10 rounded-[10px] px-4 text-dim hover:bg-transparent aria-pressed:bg-ink aria-pressed:font-semibold aria-pressed:text-bg";
/** A small choice among a few, as a pill. */
const PILL =
	"h-10 rounded-full border border-line-strong px-3.5 text-[13px] text-dim aria-pressed:border-transparent aria-pressed:bg-ink aria-pressed:text-bg";

const sampleUrl = (profile?: ModelProfile) =>
	profile?.sample ? `/samples/${profile.sample}` : null;

/** A sample picture: the shared prompt, or the model's own demo. */
function entryImage(entry: Entry): string | null {
	const sample = sampleUrl(entry.profile);
	if (sample) return sample;
	if (entry.kind === "local") {
		const index = entry.model.demos.findIndex((d) => d.media === "image");
		if (index >= 0) return demoUrl(entry.model.id, index);
	}
	return null;
}

const entryName = (entry: Entry) =>
	entry.kind === "cloud" ? entry.profile.name : entry.model.name;

function fitLabel(t: I18n["t"], level: FitLevel): string {
	if (level === "great") return t("fit.great");
	if (level === "slow") return t("fit.slow");
	return t("fit.none");
}

function bestForLabel(t: I18n["t"], tag: BestFor): string {
	switch (tag) {
		case "speed":
			return t("bestFor.speed");
		case "drafts":
			return t("bestFor.drafts");
		case "photo":
			return t("bestFor.photo");
		case "text":
			return t("bestFor.text");
		case "illustration":
			return t("bestFor.illustration");
		case "editing":
			return t("bestFor.editing");
		case "instructions":
			return t("bestFor.instructions");
		case "detail":
			return t("bestFor.detail");
		case "motion":
			return t("bestFor.motion");
		case "cinema":
			return t("bestFor.cinema");
		case "sound":
			return t("bestFor.sound");
	}
}

/** What a cloud model costs, from the cheapest service that says. */
function familyCost(i18n: I18n, family: Family): string {
	// Prices per output and per second do not compare; per output comes first.
	const cheapest = (values: (number | undefined)[]) =>
		values.filter((v): v is number => v != null).sort((a, b) => a - b)[0];
	const perOutput = cheapest(family.routes.map((r) => r.pricing?.usdPerOutput));
	if (perOutput != null) {
		return family.media === "video"
			? i18n.t("picker.perVideo", { price: usd(i18n, perOutput) })
			: i18n.t("picker.perPicture", { price: usd(i18n, perOutput) });
	}
	const perSecond = cheapest(family.routes.map((r) => r.pricing?.usdPerSecond));
	if (perSecond != null) {
		return i18n.t("picker.perSecond", { price: usd(i18n, perSecond) });
	}
	return family.media === "video"
		? i18n.t("picker.paidVideo")
		: i18n.t("picker.paid");
}

/** Three marks, `value` of them lit. */
function Meter(props: {
	value: number;
	label: string;
	tone: "speed" | "quality";
}) {
	return (
		<span className="inline-flex gap-[3px]" role="img" aria-label={props.label}>
			{[1, 2, 3].map((n) => (
				<i
					key={n}
					className={`h-1.5 w-3.5 rounded-sm ${
						n > props.value
							? "bg-line-strong"
							: props.tone === "speed"
								? "bg-gold"
								: "aurora"
					}`}
				/>
			))}
		</span>
	);
}

/** A picture coming through noise: the sample, or light that never settles. */
function Reveal(props: {
	src: string | null;
	alt: string;
	delay?: number;
	/** Shifts the light of a picture without a sample, so cards differ. */
	seed?: string;
	className?: string;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [focused, setFocused] = useState(() => reduceMotion());
	useEffect(() => {
		if (props.src) {
			const timer = setTimeout(() => setFocused(true), props.delay ?? 0);
			return () => clearTimeout(timer);
		}
		const element = canvas.current;
		if (!element) return;
		let offset = 0;
		for (const char of props.seed ?? "") {
			offset = (offset * 31 + char.charCodeAt(0)) % 100_000;
		}
		latent(element, 0.4, performance.now() + offset * 97);
		if (reduceMotion()) return;
		// Drawn at film speed, and only while on screen: a grid can hold dozens.
		let frame = 0;
		let last = 0;
		const draw = (time: number) => {
			frame = requestAnimationFrame(draw);
			if (time - last < FRAME_MS) return;
			last = time;
			latent(element, 0.4, time + offset * 97);
		};
		const watcher = new IntersectionObserver(([seen]) => {
			cancelAnimationFrame(frame);
			if (seen?.isIntersecting) frame = requestAnimationFrame(draw);
		});
		watcher.observe(element);
		return () => {
			watcher.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [props.src, props.delay, props.seed]);

	return props.src ? (
		<img
			src={props.src}
			alt={props.alt}
			loading="lazy"
			decoding="async"
			className={`focus-in h-full w-full object-cover ${focused ? "focused" : ""} ${props.className ?? ""}`}
		/>
	) : (
		<canvas
			ref={canvas}
			width={240}
			height={180}
			className={`h-full w-full ${props.className ?? ""}`}
		/>
	);
}

/** The machine, and the model that suits it best. */
function Hero(props: {
	hardware: Hardware | undefined;
	pick: Entry | undefined;
	onChoose(entry: Entry): void;
	onSeeAll(): void;
}) {
	const i18n = useI18n();
	const { t } = i18n;
	const gpu = props.hardware?.gpus.toSorted(
		(a, b) => b.memoryBytes - a.memoryBytes,
	)[0];
	const total = props.hardware ? gpuMemory(props.hardware) : null;
	const local = props.pick?.kind === "local" ? props.pick.model : undefined;
	const can = useCan();
	const need = local ? neededMemory(local) : null;
	const level = local ? fitLevel(localFit(local)) : null;
	const share = need && total ? Math.min(1, need / total) : 0;
	const [shown, setShown] = useState(0);

	// The memory bar fills, and its figure counts up, when the hero appears.
	useEffect(() => {
		if (reduceMotion()) {
			setShown(share);
			return;
		}
		const start = performance.now();
		let frame = 0;
		const step = (now: number) => {
			const p = Math.min(1, (now - start) / 1400);
			setShown(share * (1 - (1 - p) ** 3));
			if (p < 1) frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [share]);

	return (
		<section
			aria-label={t("picker.bestHere")}
			className="rise-in grid overflow-hidden rounded-2xl border border-line bg-panel md:grid-cols-[1.1fr_1fr]"
			style={{ "--i": 1 } as CSSProperties}
		>
			<div className="flex flex-col gap-4 border-line p-6 max-md:border-b md:border-r">
				<p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-dim">
					<i
						aria-hidden="true"
						className="breathe size-1.5 rounded-full bg-good shadow-[0_0_10px_var(--good)]"
					/>
					{t("picker.machine")}
				</p>
				<p className="font-display text-xl leading-tight font-bold tracking-tight">
					{gpu?.name ?? t("picker.noGpu")}
					<span className="mt-1 block font-sans text-sm font-normal tracking-normal text-dim">
						{[
							total != null &&
								t("picker.gpuMemory", { size: i18n.bytes(total) }),
							props.hardware &&
								t("picker.ram", {
									size: i18n.bytes(props.hardware.memoryBytes),
								}),
						]
							.filter(Boolean)
							.join(" · ")}
					</span>
				</p>
				{total != null && need != null && level && (
					<div className="flex flex-col gap-2">
						<div className="flex justify-between font-mono text-xs text-dim tabular-nums">
							<span>{t("picker.vram")}</span>
							<span>
								{t("picker.vramUse", {
									used: i18n.bytes(Math.round(total * shown)),
									total: i18n.bytes(total),
								})}
							</span>
						</div>
						<div
							className="relative h-3.5 overflow-hidden rounded-full border border-line bg-panel-2"
							role="img"
							aria-label={t("picker.vramUse", {
								used: i18n.bytes(need),
								total: i18n.bytes(total),
							})}
						>
							<i
								className={`sweep absolute inset-y-0 left-0 rounded-full ${FIT_STYLE[level].bar}`}
								style={{ width: `${shown * 100}%` }}
							/>
						</div>
						<ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-dim">
							{(["great", "slow", "none"] as const).map((l) => (
								<li key={l} className="inline-flex items-center gap-1.5">
									<i className={`size-2 rounded-sm ${FIT_STYLE[l].bar}`} />
									{fitLabel(t, l)}
								</li>
							))}
						</ul>
					</div>
				)}
			</div>

			{props.pick && (
				<div className="flex flex-col gap-4 p-6">
					<p className="font-mono text-[11px] uppercase tracking-[0.12em] text-dim">
						{t("picker.best")}
					</p>
					<div className="flex items-center gap-4">
						<div className="size-24 shrink-0 overflow-hidden rounded-xl bg-panel-2">
							<Reveal
								src={entryImage(props.pick)}
								alt={entryName(props.pick)}
								delay={300}
							/>
						</div>
						<div className="min-w-0">
							<h2 className="font-display text-2xl leading-tight font-bold tracking-tight">
								{entryName(props.pick)}
							</h2>
							<p className="mt-1 text-sm text-dim">
								{props.pick.kind !== "local"
									? t("picker.whyCloud")
									: level === "great"
										? t("picker.whyLocal")
										: t("picker.whySlow")}
							</p>
						</div>
					</div>
					<div className="flex flex-wrap gap-1.5">
						<span className="aurora rounded-full px-2.5 py-0.5 text-xs font-semibold">
							{t("picker.recommended")}
						</span>
						{level && (
							<span
								className={`rounded-full px-2.5 py-0.5 text-xs ${FIT_STYLE[level].bg} ${FIT_STYLE[level].text}`}
							>
								<span aria-hidden="true">● </span>
								{fitLabel(t, level)}
							</span>
						)}
						{need != null && (
							<span className="rounded-full bg-white/6 px-2.5 py-0.5 text-xs">
								{t("picker.uses", { size: i18n.bytes(need) })}
							</span>
						)}
					</div>
					<div className="mt-auto flex flex-wrap items-center gap-2">
						{local && !local.ready && !can.admin ? (
							<p className="text-sm text-dim">{t("models.askAdmin")}</p>
						) : (
							<Button
								variant="aurora"
								size="lg"
								onClick={() => props.pick && props.onChoose(props.pick)}
							>
								{local && !local.ready
									? t("picker.downloadUse", { size: i18n.bytes(local.size) })
									: t("picker.useThis")}
							</Button>
						)}
						<Button variant="outline" size="lg" onClick={props.onSeeAll}>
							{t("picker.seeAll")}
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}

/** The same prompt through each model, one after another. */
function CompareStrip({ entries }: { entries: Entry[] }) {
	const { t } = useI18n();
	const canvas = useRef<HTMLCanvasElement>(null);
	const [current, setCurrent] = useState(0);
	const [developing, setDeveloping] = useState(false);
	// Pointing at or focusing the strip holds the current picture; with
	// reduced motion it never moves on by itself.
	const held = useRef(false);
	const entry = entries[current % entries.length];
	const src = entry && entryImage(entry);

	useEffect(() => {
		const element = canvas.current;
		if (!element || !src) return;
		let frame = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		const next = () => {
			if (reduceMotion()) return;
			timer = setTimeout(() => {
				if (held.current) next();
				else setCurrent((c) => (c + 1) % entries.length);
			}, 2800);
		};
		loadImage(src)
			.then((image) => {
				if (stopped) return;
				if (reduceMotion()) {
					develop(element, image, 1);
					return next();
				}
				setDeveloping(true);
				const start = performance.now();
				const step = (now: number) => {
					const p = Math.min(1, (now - start) / 1100);
					develop(element, image, 1 - (1 - p) ** 3);
					if (p < 1) frame = requestAnimationFrame(step);
					else {
						setDeveloping(false);
						next();
					}
				};
				frame = requestAnimationFrame(step);
			})
			// A picture that fails to load is skipped, not waited on forever.
			.catch(() => {
				setDeveloping(false);
				next();
			});
		return () => {
			stopped = true;
			cancelAnimationFrame(frame);
			clearTimeout(timer);
		};
	}, [src, entries.length]);

	if (!entry) return null;
	return (
		<section
			aria-label={t("picker.compareTitle")}
			onPointerEnter={() => {
				held.current = true;
			}}
			onPointerLeave={() => {
				held.current = false;
			}}
			onFocus={() => {
				held.current = true;
			}}
			onBlur={() => {
				held.current = false;
			}}
			className="rise-in grid items-center gap-6 md:grid-cols-[17rem_1fr]"
			style={{ "--i": 2 } as CSSProperties}
		>
			<div className="flex flex-col gap-2">
				<p className="font-mono text-[11px] uppercase tracking-[0.12em] text-dim">
					{t("picker.compareEyebrow")}
				</p>
				<h3 className="font-display text-2xl leading-tight font-bold tracking-tight text-balance">
					{t("picker.compareTitle")}
				</h3>
				<p className="rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[13px] leading-relaxed">
					<span className="text-pink">› </span>
					{t("picker.comparePrompt")}
				</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-[1.4fr_1fr]">
				<figure className="flex flex-col gap-2">
					<div className="relative aspect-square overflow-hidden rounded-2xl border border-line bg-panel">
						<canvas
							ref={canvas}
							width={640}
							height={640}
							className="absolute inset-0 h-full w-full"
						/>
					</div>
					<figcaption className="flex justify-between gap-2 px-0.5 font-mono text-xs text-dim">
						<span className="font-sans font-medium text-ink">
							{entryName(entry)}
						</span>
						<span>
							{entry.kind === "local" ? t("picker.free") : t("picker.cloud")}
						</span>
					</figcaption>
				</figure>
				<div className="flex flex-col gap-1.5">
					{entries.map((other, index) => (
						<button
							key={other.key}
							type="button"
							aria-current={index === current % entries.length}
							onClick={() => setCurrent(index)}
							className="relative overflow-hidden rounded-xl border border-line bg-panel px-3 py-2.5 text-left transition-colors aria-[current=true]:border-line-strong aria-[current=true]:bg-panel-2"
						>
							<span className="block text-sm font-semibold">
								{entryName(other)}
							</span>
							<span className="font-mono text-xs text-dim">
								{other.kind === "local" ? t("picker.free") : t("picker.cloud")}
							</span>
							{index === current % entries.length && !developing && (
								<i
									key={current}
									aria-hidden="true"
									className="aurora absolute inset-x-0 bottom-0 h-0.5 origin-left motion-safe:animate-[grow_2.8s_linear_both]"
								/>
							)}
						</button>
					))}
				</div>
			</div>
		</section>
	);
}

function Card(props: {
	entry: Entry;
	index: number;
	chosen: boolean;
	best: boolean;
	/** The graphics memory here, to show what share a local model takes. */
	gpuTotal: number | null;
	onChoose(): void;
}) {
	const i18n = useI18n();
	const { t } = i18n;
	const { entry } = props;
	const profile = entry.profile;
	const local = entry.kind === "local" ? entry.model : undefined;
	const level = local ? fitLevel(localFit(local)) : null;
	const need = local ? neededMemory(local) : null;
	const author =
		entry.kind === "local"
			? entry.model.author
			: entry.kind === "cloud"
				? entry.profile.author
				: entry.model.providerId;
	const services =
		entry.kind === "cloud"
			? [...new Set(entry.family.routes.map((r) => r.providerId))].join(" · ")
			: null;
	// Videos rarely show writing, so they get no text row.
	const media = entry.kind === "cloud" ? entry.family.media : entry.model.media;
	const needsKey =
		(entry.kind === "cloud" && !entry.family.ready) ||
		(entry.kind === "other" && !entry.ready);

	return (
		<article
			data-chosen={props.chosen}
			className="glow-card rise-in relative flex flex-col overflow-hidden rounded-2xl border border-line bg-panel"
			style={{ "--i": props.index + 3 } as CSSProperties}
		>
			{/* One real button over the whole card, named after the model; the
			    details stay readable as the card's own content. */}
			<button
				type="button"
				aria-pressed={props.chosen}
				aria-label={entryName(entry)}
				onClick={props.onChoose}
				className="absolute inset-0 z-10 rounded-2xl"
			/>
			<div className="relative aspect-[4/3] overflow-hidden bg-panel-2">
				<Reveal
					src={entryImage(entry)}
					alt={t("picker.sampleOf", { model: entryName(entry) })}
					delay={500 + props.index * 160}
					seed={entry.key}
				/>
			</div>
			<div className="flex flex-1 flex-col gap-2.5 p-4">
				<div className="flex flex-wrap items-center gap-1.5">
					{props.best && (
						<span className="aurora rounded-full px-2.5 py-0.5 text-xs font-semibold">
							{t("picker.best")}
						</span>
					)}
					<span
						className={`rounded-full px-2 py-0.5 text-[11px] ${
							level
								? `${FIT_STYLE[level].bg} ${FIT_STYLE[level].text}`
								: needsKey
									? "bg-white/6 text-ink"
									: "bg-good/12 text-good"
						}`}
					>
						{(level || !needsKey) && <span aria-hidden="true">● </span>}
						{level
							? fitLabel(t, level)
							: needsKey
								? t("picker.needsKey")
								: t("picker.ready")}
					</span>
				</div>
				<div className="min-w-0">
					<h4 className="font-display text-lg leading-tight font-bold tracking-tight">
						{entryName(entry)}
					</h4>
					<p className="truncate text-xs text-dim" title={services ?? author}>
						{services ? t("picker.via", { author, services }) : author}
					</p>
				</div>
				{profile && (
					<dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs text-dim">
						<dt>{t("picker.speed")}</dt>
						<dd>
							<Meter
								value={profile.speed}
								tone="speed"
								label={t("picker.outOf", { value: profile.speed })}
							/>
						</dd>
						<dt>{t("picker.quality")}</dt>
						<dd>
							<Meter
								value={profile.quality}
								tone="quality"
								label={t("picker.outOf", { value: profile.quality })}
							/>
						</dd>
						{media !== "video" && (
							<>
								<dt>{t("picker.text")}</dt>
								<dd>
									{profile.text ? t("picker.textGood") : t("picker.textPoor")}
								</dd>
							</>
						)}
					</dl>
				)}
				{local && need != null && level && props.gpuTotal != null && (
					<div
						className="h-1 overflow-hidden rounded-full bg-panel-2"
						role="img"
						aria-label={t("picker.vramUse", {
							used: i18n.bytes(need),
							total: i18n.bytes(props.gpuTotal),
						})}
					>
						<i
							className={`block h-full rounded-full ${FIT_STYLE[level].bar}`}
							style={{
								width: `${Math.min(100, (need / props.gpuTotal) * 100)}%`,
							}}
						/>
					</div>
				)}
				{profile && profile.bestFor.length > 0 && (
					<ul className="flex flex-wrap gap-1">
						{profile.bestFor.map((tag) => (
							<li
								key={tag}
								className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] text-dim"
							>
								{bestForLabel(t, tag)}
							</li>
						))}
					</ul>
				)}
				<p className="mt-auto flex items-center justify-between gap-2 pt-1 font-mono text-xs text-dim tabular-nums">
					<span>
						{local
							? local.ready
								? t("picker.installed")
								: i18n.bytes(local.size)
							: entry.kind === "cloud"
								? familyCost(i18n, entry.family)
								: ""}
					</span>
					<span className="text-ink">{local ? t("picker.free") : ""}</span>
				</p>
			</div>
		</article>
	);
}

/** Downloading a local model, step by step, until it is ready. */
function Download(props: { model: LocalModelStatus; autoStart: boolean }) {
	const { model } = props;
	const i18n = useI18n();
	const { t } = i18n;
	const live = useModelProgress(model.id);
	const install = useMutation({ mutationFn: () => api.installModel(model.id) });
	const state = live?.state ?? model.state;
	const received = live?.receivedBytes ?? model.receivedBytes;
	const total = live?.size ?? model.size;
	const speed = live?.bytesPerSecond ?? 0;
	// Until the first progress event arrives, a request sent counts as started.
	const started =
		state !== "available" || install.isPending || install.isSuccess;
	const { mutate } = install;
	const can = useCan();
	// Chosen from "Download and use": start without a second click.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the drawer opens
	useEffect(() => {
		if (can.admin && props.autoStart && model.state === "available") mutate();
	}, []);
	const steps = [
		["downloading", t("picker.stepDownload")],
		["verifying", t("picker.stepCheck")],
		["installed", t("picker.stepReady")],
	] as const;
	const position = state === "verifying" ? 1 : state === "installed" ? 2 : 0;
	const error = install.error
		? i18n.explain(install.error)
		: model.error
			? i18n.explain({
					message: model.error,
					code: model.errorCode,
					params: model.errorParams,
				})
			: null;

	return (
		<div className="flex flex-col gap-3">
			<ol className="flex flex-wrap gap-1.5 text-xs">
				{steps.map(([key, label], index) => (
					<li
						key={key}
						className={`rounded-full border px-2.5 py-0.5 transition-colors ${
							!started || index > position
								? "border-line text-dim"
								: index < position
									? "border-good/40 text-good"
									: "border-pink text-ink shadow-[0_0_0_3px_rgb(255_61_139/0.15)]"
						}`}
					>
						{label}
					</li>
				))}
			</ol>
			{started ? (
				<>
					<Progress
						value={total ? Math.round((received / total) * 100) : 0}
						aria-label={t("picker.stepDownload")}
						className="*:data-[slot=progress-track]:h-2.5 *:data-[slot=progress-track]:bg-panel-2 **:data-[slot=progress-indicator]:rounded-full **:data-[slot=progress-indicator]:bg-linear-to-r **:data-[slot=progress-indicator]:from-pink **:data-[slot=progress-indicator]:via-orange **:data-[slot=progress-indicator]:to-gold"
					/>
					<p
						className="flex flex-wrap justify-between gap-2 font-mono text-xs text-dim tabular-nums"
						aria-live="polite"
					>
						<span>
							{state === "queued"
								? t("models.progress.queued")
								: state === "verifying"
									? t("models.progress.verifying")
									: t("models.progress.received", {
											received: i18n.bytes(received),
											total: i18n.bytes(total),
										})}
						</span>
						{state === "downloading" && speed > 0 && (
							<>
								<span>
									{t("models.progress.speed", { speed: i18n.bytes(speed) })}
								</span>
								<span>{remaining(i18n, (total - received) / speed)}</span>
							</>
						)}
					</p>
				</>
			) : can.admin ? (
				<Button
					variant="aurora"
					size="lg"
					onClick={() => install.mutate()}
					className="self-start"
				>
					{t("picker.download", { size: i18n.bytes(model.size) })}
				</Button>
			) : (
				<p className="text-sm text-dim">{t("models.askAdmin")}</p>
			)}
			{error && <p className="text-sm text-danger">{error}</p>}
		</div>
	);
}

/** Pasting a key for one of the services that offer a cloud model. */
function KeyForm(props: { routes: ModelSpec[]; providers: ProviderStatus[] }) {
	const { t, explain } = useI18n();
	const can = useCan();
	const client = useQueryClient();
	const options = props.providers.filter(
		(p) => p.requiresKey && props.routes.some((r) => r.providerId === p.id),
	);
	const [chosen, setChosen] = useState(options[0]?.id ?? "");
	const [key, setKey] = useState("");
	const field = useId();
	const provider = options.find((p) => p.id === chosen) ?? options[0];
	const save = useMutation({
		mutationFn: () => api.setKey(provider?.id ?? chosen, key.trim()),
		onSuccess: () => {
			setKey("");
			return client.invalidateQueries({ queryKey: ["providers"] });
		},
	});
	if (!provider) return null;
	// A server's keys are its owner's to add.
	if (!can.owner) {
		return <p className="text-sm text-dim">{t("settings.providersServer")}</p>;
	}

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (key.trim()) save.mutate();
			}}
		>
			{options.length > 1 && (
				<ToggleGroup
					aria-label={t("picker.service")}
					value={[provider.id]}
					onValueChange={([id]) => id && setChosen(id)}
					className="flex-wrap"
				>
					{options.map((option) => (
						<ToggleGroupItem key={option.id} value={option.id} className={PILL}>
							{option.name}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			)}
			<div className="flex flex-col gap-2">
				<Label htmlFor={field} className="text-dim">
					{t("settings.keyLabel", { provider: provider.name })}
				</Label>
				<div className="flex flex-wrap gap-2">
					<Input
						id={field}
						type="password"
						value={key}
						onChange={(event) => setKey(event.target.value)}
						placeholder={t("settings.pasteKey")}
						autoComplete="off"
						className="h-11 min-w-0 flex-[1_1_14rem] rounded-xl bg-bg font-mono"
					/>
					<Button
						type="submit"
						variant="aurora"
						size="lg"
						disabled={!key.trim() || save.isPending}
						className="h-11"
					>
						{t("picker.saveKey")}
					</Button>
				</div>
			</div>
			<p className="flex flex-wrap justify-between gap-2 text-xs text-dim">
				<span>{t("picker.keyNote", { provider: provider.name })}</span>
				{KEY_PAGES[provider.id] && (
					<a
						href={KEY_PAGES[provider.id]}
						target="_blank"
						rel="noreferrer"
						className="underline decoration-line-strong underline-offset-4 hover:text-pink"
					>
						{t("picker.whereKey", { provider: provider.name })}
					</a>
				)}
			</p>
			{save.error && (
				<p className="text-sm text-danger">{explain(save.error)}</p>
			)}
		</form>
	);
}

/**
 * Choosing a model: what runs best on this computer, the same prompt through
 * each model, and every model with how fast, how good and how costly it is.
 * Once the chosen model is ready, `ready` says what to do with it.
 */
export function Picker(props: {
	media: Media;
	setMedia(media: Media): void;
	ready(modelId: string, name: string): ReactNode;
}) {
	const { t } = useI18n();
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const providers = useQuery({
		queryKey: ["providers"],
		queryFn: api.providers,
	});
	const local = useQuery({
		queryKey: ["local-models"],
		queryFn: api.localModels,
	});
	const [chosen, setChosen] = useState<string | null>(null);
	const grid = useRef<HTMLDivElement>(null);
	const drawer = useRef<HTMLDivElement>(null);

	const families = cloudFamilies(
		models.data ?? [],
		providers.data ?? [],
		props.media,
	);
	const [allLocal, setAllLocal] = useState(false);
	const localModels = sortLocal(
		// An upscaler is offered on pictures made, not to make them.
		(local.data?.models ?? []).filter(
			(m) => m.media === props.media && !m.tasks.includes("upscale"),
		),
	);
	// Models that cannot run well here wait behind a button, so the ones
	// worth choosing come first.
	const runsHere = (model: LocalModelStatus) =>
		model.state !== "available" || fitLevel(localFit(model)) !== "none";
	const hiddenLocal = allLocal
		? 0
		: localModels.filter((m) => !runsHere(m)).length;
	const localEntries: Entry[] = localModels
		.filter((m) => allLocal || runsHere(m))
		.map((model) => ({
			kind: "local",
			key: `local:${model.id}`,
			profile: model.profile,
			model,
		}));
	const cloudEntries: Entry[] = families.map((family) => ({
		kind: "cloud",
		key: `cloud:${family.profile.family}`,
		profile: family.profile,
		family,
	}));
	const ready = new Set(
		(providers.data ?? [])
			.filter((p) => p.hasKey || !p.requiresKey)
			.map((p) => p.id),
	);
	const otherEntries: Entry[] = (models.data ?? [])
		.filter(
			(m) => !m.profile && m.providerId !== "local" && m.media === props.media,
		)
		.map((model) => ({
			kind: "other",
			key: `other:${model.id}`,
			model,
			ready: ready.has(model.providerId),
		}));
	const all = [...localEntries, ...cloudEntries, ...otherEntries];
	const gpuTotal = local.data ? gpuMemory(local.data.hardware) : null;
	const bestModel = bestLocal(local.data?.models ?? [], props.media);
	const pick: Entry | undefined = bestModel
		? localEntries.find(
				(e) => e.kind === "local" && e.model.id === bestModel.id,
			)
		: (() => {
				const family = bestCloud(families);
				return cloudEntries.find(
					(e) => e.kind === "cloud" && e.family === family,
				);
			})();
	// One picture per model, even when it runs both here and in the cloud.
	const withSamples = all.filter(
		(e, index) =>
			sampleUrl(e.profile) &&
			all.findIndex((o) => o.profile?.family === e.profile?.family) === index,
	);
	const current = all.find((e) => e.key === chosen);

	// Which entry was chosen from the hero, to start its download at once.
	const [autoStart, setAutoStart] = useState<string | null>(null);
	const choose = (entry: Entry, start = false) => {
		setChosen(entry.key);
		setAutoStart(start ? entry.key : null);
		requestAnimationFrame(() =>
			drawer.current?.scrollIntoView({
				block: "nearest",
				behavior: reduceMotion() ? "auto" : "smooth",
			}),
		);
	};

	/** The chosen model's id once it can be used now. */
	const readyId =
		current?.kind === "local"
			? current.model.ready
				? `local/${current.model.id}`
				: null
			: current?.kind === "cloud"
				? (current.family.ready?.id ?? null)
				: current?.kind === "other" && current.ready
					? current.model.id
					: null;

	return (
		<div className="flex flex-col gap-8">
			<ToggleGroup
				aria-label={t("picker.media")}
				value={[props.media]}
				onValueChange={([kind]) => {
					if (kind !== "image" && kind !== "video") return;
					props.setMedia(kind);
					setChosen(null);
				}}
				spacing={1}
				className="self-start rounded-xl border border-line bg-panel p-1"
			>
				{(["image", "video"] as const).map((kind) => (
					<ToggleGroupItem key={kind} value={kind} className={SEGMENT}>
						{kind === "image" ? t("picker.image") : t("picker.video")}
					</ToggleGroupItem>
				))}
			</ToggleGroup>

			{local.isPending ? (
				<div
					className="developing h-64 rounded-2xl border border-line"
					aria-hidden="true"
				/>
			) : (
				<Hero
					hardware={local.data?.hardware}
					pick={pick}
					onChoose={(entry) => choose(entry, true)}
					onSeeAll={() =>
						grid.current?.scrollIntoView({
							behavior: reduceMotion() ? "auto" : "smooth",
						})
					}
				/>
			)}

			{withSamples.length >= 2 && (
				<CompareStrip key={props.media} entries={withSamples} />
			)}

			<div ref={grid} className="flex flex-col gap-8">
				{[
					{
						entries: localEntries,
						title: t("picker.localTitle"),
						body: t("picker.localBody"),
					},
					{
						entries: cloudEntries,
						title: t("picker.cloudTitle"),
						body: t("picker.cloudBody"),
					},
					{
						entries: otherEntries,
						title: t("picker.otherTitle"),
						body: t("picker.otherBody"),
					},
				].map(
					(group) =>
						group.entries.length > 0 && (
							<section key={group.title} aria-label={group.title}>
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<h3 className="font-display text-xl font-bold tracking-tight">
										{group.title}
									</h3>
									<p className="text-sm text-dim">{group.body}</p>
								</div>
								<div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3.5">
									{group.entries.map((entry, index) => (
										<Card
											key={entry.key}
											entry={entry}
											index={index}
											chosen={entry.key === chosen}
											best={entry.key === pick?.key}
											gpuTotal={gpuTotal}
											onChoose={() => choose(entry)}
										/>
									))}
								</div>
								{group.entries === localEntries && hiddenLocal > 0 && (
									<Button
										variant="ghost"
										onClick={() => setAllLocal(true)}
										className="mt-3 text-dim"
									>
										{t("picker.showTooBig", { count: hiddenLocal })}
									</Button>
								)}
							</section>
						),
				)}
			</div>

			{current && (
				<div
					ref={drawer}
					key={current.key}
					className="rise-in sticky bottom-3 z-10 flex flex-col gap-3 rounded-2xl border border-line-strong bg-panel/90 p-4 shadow-[0_20px_50px_-20px_#000] backdrop-blur-xl"
				>
					<p className="font-display text-lg font-bold tracking-tight">
						{readyId
							? t("picker.readyWith", { model: entryName(current) })
							: current.kind === "local"
								? entryName(current)
								: t("picker.keyFor", { model: entryName(current) })}
					</p>
					{readyId ? (
						props.ready(readyId, entryName(current))
					) : current.kind === "local" ? (
						<Download
							model={current.model}
							autoStart={autoStart === current.key}
						/>
					) : (
						<KeyForm
							routes={
								current.kind === "cloud"
									? current.family.routes
									: [current.model]
							}
							providers={providers.data ?? []}
						/>
					)}
				</div>
			)}
		</div>
	);
}

/** The picker in a window, for changing models in the middle of a session. */
export function PickerDialog(props: {
	media: Media;
	onUse(modelId: string, media: Media): void;
	onClose(): void;
}) {
	const { t } = useI18n();
	const [media, setMedia] = useState(props.media);

	return (
		<Dialog open onOpenChange={(open) => !open && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				className="block max-h-[92dvh] w-[min(68rem,calc(100%-2rem))] max-w-none overflow-y-auto rounded-2xl bg-bg p-0 ring-line-strong sm:max-w-none"
			>
				<div className="flex flex-col gap-6 p-5 sm:p-8">
					<div className="flex items-center justify-between gap-4">
						<DialogTitle className="font-display text-3xl leading-tight font-extrabold tracking-tight">
							{t("composer.chooseModel")}
						</DialogTitle>
						<DialogClose render={<Button variant="ghost" size="icon" />}>
							<XIcon />
							<span className="sr-only">{t("common.close")}</span>
						</DialogClose>
					</div>
					<Picker
						media={media}
						setMedia={setMedia}
						ready={(modelId) => (
							<Button
								variant="aurora"
								size="lg"
								onClick={() => props.onUse(modelId, media)}
								className="self-start"
							>
								{t("picker.useThis")}
							</Button>
						)}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
