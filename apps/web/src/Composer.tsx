import { storedValue } from "@hatchlight/core/legacy";
import {
	MAX_LORAS,
	type Media,
	type ModelSpec,
	type ProviderStatus,
} from "@hatchlight/core/types";
import { useMutation } from "@tanstack/react-query";
import {
	Loader2,
	Plus,
	SlidersHorizontal,
	Sparkles,
	Square,
	X,
} from "lucide-react";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useEffect,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	PromptInput,
	PromptInputActions,
	PromptInputTextarea,
} from "@/components/chat/prompt-input";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { Adjust } from "./Adjust";
import { api, assetUrl, useDemo } from "./api";
import { Extend } from "./Extend";
import { useI18n } from "./i18n";
import { type ChosenLora, LoraPicker, useLoras } from "./Loras";
import { MaskPainter } from "./MaskPainter";
import { PickerDialog } from "./Picker";

export interface Draft {
	prompt: string;
	modelIds: string[];
	aspectRatio?: string;
	count: number;
	durationSeconds?: number;
	/** How much a model that redraws the reference changes it. */
	strength?: number;
	/** The area of the reference to redraw; the rest is kept. */
	maskAssetId?: string;
	/** LoRAs for the models that take them. */
	loras?: ChosenLora[];
}

interface Props {
	models: ModelSpec[];
	providers: ProviderStatus[];
	references: string[];
	setReferences: Dispatch<SetStateAction<string[]>>;
	busy: boolean;
	error: string | null;
	/** Sends the turn; the prompt is cleared only once it is accepted. */
	onSubmit(draft: Draft): Promise<unknown>;
	/** The chosen picture: a column on wide screens, a sheet on narrow ones. */
	inspector: {
		content: ReactNode;
		/** A small copy of the chosen picture, for the button that opens it. */
		thumb?: string;
		open: boolean;
		onOpenChange(open: boolean): void;
	};
	/** Shown above the prompt: the session's results. */
	children?: ReactNode;
}

const STORAGE_KEY = "hatchlight.models";
/** From this width the settings and the inspector sit beside the turns. */
const WIDE = "(min-width: 1024px)";
/** The ratio item that leaves the shape to each model. */
const DEFAULT_RATIO = "default";
/** The length item that leaves each model at its shortest. */
const SHORTEST = "shortest";

/** Makes `ids` the models the composer starts with next time. */
export function rememberModels(ids: string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
	} catch {
		// Storage can be unavailable; the composer then starts with none.
	}
}

function savedModels(): string[] {
	try {
		const value = JSON.parse(storedValue(localStorage, STORAGE_KEY) ?? "[]");
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

function useWide(): boolean {
	return useSyncExternalStore(
		(change) => {
			const query = window.matchMedia(WIDE);
			query.addEventListener("change", change);
			return () => query.removeEventListener("change", change);
		},
		() => window.matchMedia(WIDE).matches,
	);
}

const LABEL = "font-mono text-[11px] tracking-[0.14em] text-dim uppercase";

export function Composer(props: Props) {
	const { models, providers, references, setReferences, inspector } = props;
	const { t, explain, number, language } = useI18n();
	const ids = {
		prompt: useId(),
		ratio: useId(),
		count: useId(),
		strength: useId(),
		length: useId(),
	};
	const wide = useWide();
	// On narrow screens the settings open in a sheet.
	const [setting, setSetting] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [chosen, setChosen] = useState<string[]>(savedModels);
	// A public demo has one model: chosen from the start, and nothing else
	// to choose.
	const demo = useDemo() !== null;
	useEffect(() => {
		if (!demo || models.length === 0) return;
		if (!models.some((m) => chosen.includes(m.id))) {
			setChosen(models.map((m) => m.id));
		}
	}, [demo, models, chosen]);
	const [aspectRatio, setAspectRatio] = useState("");
	const [count, setCount] = useState(1);
	const [media, setMedia] = useState<Media>("image");
	// The picker window, to find and set up another model.
	const [picking, setPicking] = useState(false);
	const [seconds, setSeconds] = useState<number | null>(null);
	// Unset, the slider shows the chosen models' own strength.
	const [moved, setStrength] = useState<number | null>(null);
	const [loras, setLoras] = useState<ChosenLora[]>([]);
	const known = useLoras();
	const fileInput = useRef<HTMLInputElement>(null);
	// The area of the reference to redraw, for the reference it was marked on.
	const [mask, setMask] = useState<{
		reference: string;
		id: string;
		/** The marks as painted, to show over the picture. */
		marks: string;
	} | null>(null);
	const [painting, setPainting] = useState(false);
	const [extending, setExtending] = useState(false);
	// The reference being turned or cropped.
	const [adjusting, setAdjusting] = useState<string | null>(null);
	// A richer prompt offered for the one written; nothing changes until used.
	const [suggestion, setSuggestion] = useState<string | null>(null);
	const [improving, setImproving] = useState<AbortController | null>(null);
	const [improveError, setImproveError] = useState<unknown>(null);
	// A public demo takes no uploads, and has no language model to write with:
	// references are the visitor's own pictures, used as they are.
	const [only] = references.length === 1 ? references : [];
	const marked = only != null && mask?.reference === only ? mask : null;
	const maskId = marked?.id ?? null;
	// Marking an area is offered when a picture model here can use it.
	const canMask = models.some(
		(m) => m.media === "image" && m.capabilities.mask != null,
	);

	const ready = new Set(
		providers.filter((p) => p.hasKey || !p.requiresKey).map((p) => p.id),
	);
	/** Why a model cannot be used right now, if it cannot. */
	const blocked = (model: ModelSpec): string | null => {
		if (!ready.has(model.providerId)) {
			return t("composer.blocked.needsKey", { model: model.name });
		}
		if (references.length > model.capabilities.maxReferenceImages) {
			return model.capabilities.maxReferenceImages === 0
				? t("composer.blocked.noReferences", { model: model.name })
				: t("composer.blocked.tooManyReferences", {
						model: model.name,
						count: model.capabilities.maxReferenceImages,
					});
		}
		if (maskId && model.capabilities.mask == null) {
			return t("composer.blocked.noMask", { model: model.name });
		}
		return null;
	};
	// Images and videos are chosen separately: they differ in cost by orders of
	// magnitude, and nobody compares one against the other.
	// An upscaler is offered on pictures made, not here.
	const offered = models.filter(
		(m) => m.media === media && m.capabilities.upscale == null,
	);
	const selected = offered.filter((m) => chosen.includes(m.id) && !blocked(m));
	const offeredRatios = [
		...new Set(selected.flatMap((m) => m.capabilities.aspectRatios)),
	];
	const maxCount = Math.max(1, ...selected.map((m) => m.capabilities.maxCount));
	const durations = [
		...new Set(selected.flatMap((m) => m.capabilities.durations ?? [])),
	].sort((a, b) => a - b);
	// Some models redraw the reference picture: how much is up to the person.
	const redrawer = selected.find((m) => m.capabilities.strength != null);
	const redrawing = references.length > 0 && redrawer != null;
	// A marked part is redrawn more than a whole picture, unless moved.
	const strength =
		moved ??
		(maskId
			? (redrawer?.capabilities.mask ?? redrawer?.capabilities.strength)
			: redrawer?.capabilities.strength);
	// LoRAs are offered for the families the chosen models take.
	const loraBases = [
		...new Set(selected.flatMap((m) => m.capabilities.loraBase ?? [])),
	];
	// At most MAX_LORAS for each family: each model gets its own family's.
	const sentLoras = loraBases.flatMap((base) =>
		loras
			.filter((chosen) =>
				known.data?.some((lora) => lora.id === chosen.id && lora.base === base),
			)
			.slice(0, MAX_LORAS),
	);
	// A redrawn picture keeps the reference's shape: no ratio to choose.
	const ratios =
		redrawing && selected.every((m) => m.capabilities.strength != null)
			? []
			: offeredRatios;
	const ratio = ratios.includes(aspectRatio) ? aspectRatio : "";
	const each = Math.min(count, maxCount);
	const length =
		seconds != null && durations.includes(seconds) ? seconds : null;

	// Without storage, the selection lasts for this visit only.
	useEffect(() => rememberModels(chosen), [chosen]);

	// Open on the kind of output the remembered models make, e.g. after a
	// first video chosen in the welcome.
	const settled = useRef(false);
	useEffect(() => {
		if (settled.current || models.length === 0) return;
		settled.current = true;
		const kinds = models
			.filter((m) => chosen.includes(m.id))
			.map((m) => m.media);
		if (kinds.length > 0 && !kinds.includes("image")) setMedia("video");
	}, [models, chosen]);

	const upload = useMutation({
		mutationFn: api.upload,
		onSuccess: (asset) => setReferences([...references, asset.id]),
	});

	// Kept in a ref too, so a second click before the next render is ignored
	// and the request stops when the composer goes away.
	const improvingRef = useRef<AbortController | null>(null);
	useEffect(() => () => improvingRef.current?.abort(), []);
	// The prompt as typed now, to drop a suggestion for one since changed.
	const promptRef = useRef(prompt);
	promptRef.current = prompt;

	const stopImproving = () => {
		improvingRef.current?.abort();
		improvingRef.current = null;
		setImproving(null);
	};

	const improve = async () => {
		const idea = prompt.trim();
		if (idea === "" || improvingRef.current) return;
		const controller = new AbortController();
		improvingRef.current = controller;
		setImproving(controller);
		setImproveError(null);
		try {
			const { prompt: better } = await api.improvePrompt(
				{
					prompt: idea,
					modelIds: selected.map((m) => m.id),
					editing: references.length > 0,
					language,
				},
				controller.signal,
			);
			// Written for a prompt that is no longer there: using it would
			// overwrite what was typed since.
			if (!controller.signal.aborted && promptRef.current.trim() === idea) {
				setSuggestion(better);
			}
		} catch (problem) {
			if (!controller.signal.aborted) setImproveError(problem);
		} finally {
			if (improvingRef.current === controller) {
				improvingRef.current = null;
				setImproving(null);
			}
		}
	};

	const canSend = prompt.trim() !== "" && selected.length > 0 && !props.busy;
	const submit = () => {
		if (!canSend) return;
		const sent = prompt.trim();
		const accepted = props.onSubmit({
			prompt: sent,
			modelIds: selected.map((m) => m.id),
			aspectRatio: ratio || undefined,
			count: each,
			// Unset, each model uses its shortest length.
			durationSeconds: length ?? undefined,
			// Unmoved, each model redraws by its own.
			strength: redrawing && moved != null ? moved : undefined,
			maskAssetId: maskId ?? undefined,
			loras: sentLoras.length > 0 ? sentLoras : undefined,
		});
		// Kept when refused, so nothing typed is lost; cleared once accepted,
		// unless it was changed meanwhile.
		void accepted.then(
			() => setPrompt((current) => (current.trim() === sent ? "" : current)),
			() => {},
		);
		// Whatever was offered was for the prompt just sent.
		stopImproving();
		setSuggestion(null);
		setImproveError(null);
	};

	// A window of its own replaces the settings sheet, so the two never stack.
	const leaveSheet = () => setSetting(false);

	// Chosen models that have a key but are ruled out by the reference images.
	const overReferenceLimit =
		selected.length === 0 &&
		offered.some((m) => chosen.includes(m.id) && ready.has(m.providerId));
	const error =
		props.error ??
		(upload.error ? explain(upload.error) : null) ??
		(improveError ? explain(improveError) : null) ??
		(overReferenceLimit ? t("composer.tooManyReferences") : null);
	const total = selected.length * each;
	// The settings in a few words, for the button that opens them on phones.
	const summary = [
		selected.length === 0
			? t("composer.summaryNone")
			: t("composer.summaryModels", { count: selected.length }),
		ratio,
		maxCount > 1 && t("composer.summaryEach", { count: each }),
	]
		.filter(Boolean)
		.join(" · ");
	const hasLoras =
		known.data?.some((lora) => loraBases.includes(lora.base)) ?? false;

	const settings = (
		<div className="flex flex-col gap-[22px]">
			{models.some((m) => m.media === "video") && (
				<Tabs value={media} onValueChange={(value) => setMedia(value as Media)}>
					<TabsList aria-label={t("composer.output")} className="w-full">
						<TabsTrigger value="image">{t("composer.images")}</TabsTrigger>
						<TabsTrigger value="video">{t("composer.video")}</TabsTrigger>
					</TabsList>
				</Tabs>
			)}
			<fieldset className="flex min-w-0 flex-col gap-1.5">
				<legend className={cn(LABEL, "mb-2.5")}>{t("composer.models")}</legend>
				{offered
					.filter((m) => ready.has(m.providerId) || chosen.includes(m.id))
					.map((model) => {
						const reason = blocked(model);
						const on = chosen.includes(model.id) && !reason;
						return (
							<Toggle
								key={model.id}
								variant="outline"
								pressed={on}
								disabled={reason !== null}
								title={reason ?? model.id}
								onPressedChange={(pressed) =>
									setChosen(
										pressed
											? [...chosen, model.id]
											: chosen.filter((id) => id !== model.id),
									)
								}
								className="h-auto min-h-11 w-full justify-start gap-2.5 rounded-xl border-line bg-panel px-3 py-2 text-left font-normal hover:bg-panel-2 aria-pressed:border-orange aria-pressed:bg-panel"
							>
								<i
									aria-hidden="true"
									className={cn(
										"size-2 shrink-0 rounded-full",
										ready.has(model.providerId) ? "bg-good" : "bg-dim",
									)}
								/>
								<span className="min-w-0 flex-1 truncate">{model.name}</span>
								<span className="shrink-0 font-mono text-[11px] text-dim">
									{model.providerId}
								</span>
							</Toggle>
						);
					})}
				<Button
					variant="outline"
					hidden={demo}
					onClick={() => {
						leaveSheet();
						setPicking(true);
					}}
					className="h-11 justify-start gap-2 rounded-xl border-dashed text-dim hover:text-ink dark:bg-transparent"
				>
					<Plus />
					{t("composer.chooseModel")}
				</Button>
			</fieldset>

			{ratios.length > 0 && (
				<div className="flex flex-col gap-2.5">
					<span id={ids.ratio} className={LABEL}>
						{t("composer.ratio")}
					</span>
					<ToggleGroup
						aria-labelledby={ids.ratio}
						value={[ratio || DEFAULT_RATIO]}
						onValueChange={(values) => {
							const [value = DEFAULT_RATIO] = values;
							setAspectRatio(value === DEFAULT_RATIO ? "" : value);
						}}
						className="grid w-full grid-cols-4 gap-1.5"
					>
						{[DEFAULT_RATIO, ...ratios].map((value) => (
							<ToggleGroupItem
								key={value}
								value={value}
								variant="outline"
								className="h-[52px] min-w-0 rounded-[10px] border-line bg-panel px-1 font-mono text-xs text-soft aria-pressed:border-ink aria-pressed:bg-panel-2 aria-pressed:text-ink"
							>
								{value === DEFAULT_RATIO ? t("composer.ratioDefault") : value}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</div>
			)}

			{maxCount > 1 && (
				<div className="flex flex-col gap-3">
					<div className="flex items-baseline justify-between">
						<span id={ids.count} className={LABEL}>
							{media === "video"
								? t("composer.videoCount")
								: t("composer.imageCount")}
						</span>
						<span className="font-mono text-[13px]">{number(each)}</span>
					</div>
					<Slider
						aria-labelledby={ids.count}
						min={1}
						max={maxCount}
						step={1}
						value={[each]}
						onValueChange={(value) =>
							setCount(typeof value === "number" ? value : (value[0] ?? 1))
						}
						locale={language}
						className="py-2"
					/>
				</div>
			)}

			{durations.length > 0 && (
				<div className="flex flex-col gap-2.5">
					<span id={ids.length} className={LABEL}>
						{t("composer.length")}
					</span>
					<Select
						value={length == null ? SHORTEST : String(length)}
						onValueChange={(value) =>
							setSeconds(value && value !== SHORTEST ? Number(value) : null)
						}
						items={[
							{ value: SHORTEST, label: t("composer.lengthShortest") },
							...durations.map((d) => ({
								value: String(d),
								label: t("format.seconds", { seconds: d }),
							})),
						]}
					>
						<SelectTrigger
							aria-labelledby={ids.length}
							className="h-10 w-full rounded-xl bg-panel data-[size=default]:h-10"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={SHORTEST}>
								{t("composer.lengthShortest")}
							</SelectItem>
							{durations.map((d) => (
								<SelectItem key={d} value={String(d)}>
									{t("format.seconds", { seconds: d })}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}

			{redrawing && strength != null && (
				<div className="flex flex-col gap-3">
					<div className="flex items-baseline justify-between">
						<span id={ids.strength} className={LABEL}>
							{t("composer.strength")}
						</span>
						<span className="font-mono text-[13px]">
							{number(strength, { style: "percent" })}
						</span>
					</div>
					<Slider
						aria-labelledby={ids.strength}
						min={0.1}
						max={1}
						step={0.05}
						value={[strength]}
						onValueChange={(value) =>
							setStrength(
								typeof value === "number" ? value : (value[0] ?? strength),
							)
						}
						format={{ style: "percent" }}
						locale={language}
						getAriaValueText={(_, value) =>
							t("composer.strengthValue", {
								amount: number(value, { style: "percent" }),
							})
						}
						className="py-2"
					/>
				</div>
			)}

			<div
				className="flex flex-col gap-2.5"
				// In a demo they come only from the gallery: none, nothing to show.
				hidden={demo && references.length === 0}
			>
				<span className={LABEL}>{t("composer.referenceImages")}</span>
				<ul
					className="flex flex-wrap gap-2"
					aria-label={t("composer.referenceImages")}
				>
					{references.map((id) => (
						<li key={id} className="relative">
							{demo ? (
								<img
									src={assetUrl(id)}
									alt={t("common.reference")}
									className="block size-14 rounded-[10px] object-cover"
								/>
							) : (
								<button
									type="button"
									onClick={() => {
										leaveSheet();
										setAdjusting(id);
									}}
									aria-label={t("composer.adjust")}
									title={t("composer.adjust")}
									className="block rounded-[10px] outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
								>
									<img
										src={assetUrl(id)}
										alt={t("common.reference")}
										className="size-14 rounded-[10px] object-cover transition-opacity hover:opacity-80"
									/>
								</button>
							)}
							{id === only && marked && (
								// The marked area, as it was painted.
								<img
									src={marked.marks}
									alt=""
									className="pointer-events-none absolute inset-0 size-14 rounded-[10px] object-cover opacity-55"
								/>
							)}
							<button
								type="button"
								aria-label={t("composer.removeReference")}
								onClick={() =>
									setReferences(references.filter((r) => r !== id))
								}
								className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full border border-line-strong bg-panel-2 text-soft outline-none after:absolute after:-inset-2 hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/60"
							>
								<X className="size-3.5" />
							</button>
						</li>
					))}
					<li hidden={demo}>
						<button
							type="button"
							onClick={() => fileInput.current?.click()}
							disabled={upload.isPending}
							aria-label={
								upload.isPending
									? t("composer.uploading")
									: t("composer.addReference")
							}
							title={t("composer.addReference")}
							className="grid size-14 place-items-center rounded-[10px] border border-dashed border-line-strong text-dim outline-none transition-colors hover:border-dim hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/60 disabled:opacity-60"
						>
							{upload.isPending ? (
								<Loader2 className="size-[18px] animate-spin" />
							) : (
								<Plus className="size-[18px]" />
							)}
						</button>
					</li>
				</ul>
				{only != null && canMask && !demo && (
					<div className="flex flex-wrap gap-1.5">
						<Button
							variant="outline"
							onClick={() => {
								leaveSheet();
								setPainting(true);
							}}
						>
							{maskId ? t("composer.editArea") : t("composer.markArea")}
						</Button>
						<Button
							variant="outline"
							onClick={() => {
								leaveSheet();
								setExtending(true);
							}}
						>
							{t("composer.extend")}
						</Button>
						{maskId && (
							<Button
								variant="ghost"
								onClick={() => setMask(null)}
								className="text-dim"
							>
								{t("composer.removeMask")}
							</Button>
						)}
					</div>
				)}
				<input
					ref={fileInput}
					type="file"
					accept="image/png,image/jpeg,image/webp"
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) upload.mutate(file);
						event.target.value = "";
					}}
				/>
			</div>

			{hasLoras && (
				<div className="flex flex-col gap-2.5">
					<span className={LABEL}>{t("composer.styles")}</span>
					<LoraPicker bases={loraBases} value={loras} onChange={setLoras} />
				</div>
			)}
		</div>
	);

	return (
		<>
			{wide && (
				<aside
					aria-label={t("composer.parameters")}
					className="min-h-0 overflow-y-auto border-r border-[#1a1a1e] px-5 py-6"
				>
					{settings}
				</aside>
			)}
			<section
				aria-label={t("composer.promptAndResults")}
				className="flex min-h-0 min-w-0 flex-col"
			>
				<div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
				<div className="flex shrink-0 flex-col gap-2.5 px-3 pt-2.5 pb-3 max-lg:border-t max-lg:border-[#1a1a1e] max-lg:bg-[#0c0c0f] lg:px-7 lg:pt-2 lg:pb-6">
					{!wide && (
						<div className="flex gap-2 overflow-x-auto">
							<Button
								variant="outline"
								onClick={() => setSetting(true)}
								className="h-10 shrink-0 gap-2 rounded-full border-[#2c2c32] bg-panel px-3.5 dark:bg-panel"
							>
								<SlidersHorizontal />
								{summary}
							</Button>
							<Button
								variant="outline"
								onClick={() => inspector.onOpenChange(true)}
								className="h-10 shrink-0 gap-2 rounded-full border-[#2c2c32] bg-panel px-3.5 dark:bg-panel"
							>
								{inspector.thumb && (
									<img
										src={inspector.thumb}
										alt=""
										className="size-5 rounded-md object-cover"
									/>
								)}
								{t("inspector.chip")}
							</Button>
						</div>
					)}
					{suggestion != null && (
						<section
							aria-label={t("composer.suggestion")}
							className="rise-in rounded-2xl border border-line bg-panel p-4"
						>
							<h3 className={LABEL}>{t("composer.suggestion")}</h3>
							<p className="mt-1.5 leading-relaxed">{suggestion}</p>
							<div className="mt-3 flex flex-wrap gap-1.5">
								<Button
									onClick={() => {
										setPrompt(suggestion);
										setSuggestion(null);
									}}
								>
									{t("composer.suggestionUse")}
								</Button>
								<Button
									variant="outline"
									onClick={improve}
									disabled={improving != null}
								>
									{t("composer.suggestionAnother")}
								</Button>
								<Button
									variant="ghost"
									onClick={() => setSuggestion(null)}
									className="text-dim"
								>
									{t("composer.suggestionDiscard")}
								</Button>
							</div>
						</section>
					)}
					<p role="alert" className="text-sm text-danger empty:hidden">
						{error}
					</p>
					<PromptInput
						value={prompt}
						onValueChange={(value) => {
							setPrompt(value);
							setImproveError(null);
						}}
						onSubmit={submit}
						className="flex flex-col gap-1.5 rounded-[20px] bg-panel pl-4 lg:pl-[18px]"
					>
						<label htmlFor={ids.prompt} className="sr-only">
							{t("composer.prompt")}
						</label>
						<PromptInputTextarea
							id={ids.prompt}
							placeholder={
								references.length > 0
									? media === "video"
										? t("composer.placeholder.motion")
										: t("composer.placeholder.change")
									: media === "video"
										? t("composer.placeholder.video")
										: t("composer.placeholder.image")
							}
						/>
						<PromptInputActions className="justify-between gap-2">
							{demo ? (
								<span />
							) : improving ? (
								<Button
									variant="ghost"
									onClick={(event) => {
										event.stopPropagation();
										stopImproving();
									}}
									className="-ml-2 gap-2 text-dim"
								>
									<Square className="size-3 fill-current" />
									<span className="animate-pulse">
										{t("composer.improving")}
									</span>
									<span className="sr-only">{t("composer.improveStop")}</span>
								</Button>
							) : (
								<Button
									variant="ghost"
									onClick={(event) => {
										event.stopPropagation();
										void improve();
									}}
									disabled={prompt.trim() === ""}
									className="-ml-2 gap-2 text-dim"
								>
									<Sparkles />
									{t("composer.improve")}
								</Button>
							)}
							<Button
								variant="aurora"
								onClick={(event) => {
									event.stopPropagation();
									submit();
								}}
								disabled={!canSend}
								className="h-11 px-5 text-[15px]"
							>
								{total > 0
									? t("composer.make", { count: total })
									: t("composer.generate")}
							</Button>
						</PromptInputActions>
					</PromptInput>
				</div>
			</section>
			{wide && (
				<aside
					aria-label={t("inspector.label")}
					className="min-h-0 overflow-y-auto border-l border-[#1a1a1e] bg-[#0c0c0f] px-5 py-6"
				>
					{inspector.content}
				</aside>
			)}
			{!wide && (
				<>
					<Sheet open={setting} onOpenChange={setSetting}>
						<SheetContent
							side="bottom"
							className="max-h-[85dvh] gap-0 rounded-t-3xl border-line bg-rail"
						>
							<SheetHeader className="px-5 pt-5 pb-3">
								<SheetTitle className="font-display text-xl font-bold">
									{t("composer.parameters")}
								</SheetTitle>
							</SheetHeader>
							<div className="min-h-0 overflow-y-auto px-5 pb-8">
								{settings}
							</div>
						</SheetContent>
					</Sheet>
					<Sheet open={inspector.open} onOpenChange={inspector.onOpenChange}>
						<SheetContent
							side="bottom"
							className="max-h-[85dvh] gap-0 rounded-t-3xl border-line bg-rail"
						>
							<SheetHeader className="px-5 pt-5 pb-3">
								<SheetTitle className="font-display text-xl font-bold">
									{t("inspector.label")}
								</SheetTitle>
							</SheetHeader>
							<div className="min-h-0 overflow-y-auto px-5 pb-8">
								{inspector.content}
							</div>
						</SheetContent>
					</Sheet>
				</>
			)}
			{adjusting != null && (
				<Adjust
					src={assetUrl(adjusting)}
					onDone={async (picture) => {
						const asset = await api.upload(
							new File([picture], "adjusted", { type: picture.type }),
						);
						// Takes the old one's place; a mask drawn on it no longer fits.
						setReferences((current) =>
							current.map((id) => (id === adjusting ? asset.id : id)),
						);
						setAdjusting(null);
					}}
					onClose={() => setAdjusting(null)}
				/>
			)}
			{extending && only != null && (
				<Extend
					src={assetUrl(only)}
					onDone={async (picture, area, marks) => {
						const [larger, mask] = await Promise.all([
							api.upload(
								new File([picture], "extended", { type: picture.type }),
							),
							api.upload(new File([area], "mask.png", { type: area.type })),
						]);
						// The larger picture takes the old one's place, its new part
						// marked to be drawn.
						setReferences((current) =>
							current.map((id) => (id === only ? larger.id : id)),
						);
						setMask({ reference: larger.id, id: mask.id, marks });
						setExtending(false);
					}}
					onClose={() => setExtending(false)}
				/>
			)}
			{painting && only != null && (
				<MaskPainter
					src={assetUrl(only)}
					mask={maskId ? assetUrl(maskId) : null}
					onDone={async (blob, marks) => {
						const asset = await api.upload(
							new File([blob], "mask.png", { type: "image/png" }),
						);
						setMask({ reference: only, id: asset.id, marks });
						setPainting(false);
					}}
					onClose={() => setPainting(false)}
				/>
			)}
			{picking && (
				<PickerDialog
					media={media}
					onClose={() => setPicking(false)}
					onUse={(modelId, kind) => {
						setMedia(kind);
						setChosen((current) =>
							current.includes(modelId) ? current : [...current, modelId],
						);
						setPicking(false);
					}}
				/>
			)}
		</>
	);
}
