import type {
	Asset,
	GalleryItem,
	TrainerInstallStep,
	TrainerStatus,
	TrainingStage,
	TrainingView,
} from "@hatchlight/core/types";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useCan } from "./Accounts";
import { api, assetUrl, GALLERY_PAGE, sampleUrl } from "./api";
import { remaining } from "./format";
import { type I18n, useI18n } from "./i18n";

// The server's limits (packages/core/src/local/trainer.ts), to guide the form.
const MIN_PICTURES = 3;
const MAX_PICTURES = 200;
const DEFAULT_STEPS = 800;

function stepText(t: I18n["t"], step: TrainerInstallStep): string {
	switch (step) {
		case "uv":
			return t("training.install.uv");
		case "scripts":
			return t("training.install.scripts");
		case "python":
			return t("training.install.python");
		case "packages":
			return t("training.install.packages");
		case "checking":
			return t("training.install.checking");
	}
}

function stageText(t: I18n["t"], stage: TrainingStage): string {
	switch (stage) {
		case "waitingGpu":
			return t("training.stage.waitingGpu");
		case "loading":
			return t("training.stage.loading");
		case "caching":
			return t("training.stage.caching");
		case "training":
			return t("training.stage.training");
		case "saving":
			return t("training.stage.saving");
	}
}

function Bar({ value, label }: { value: number; label: string }) {
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(value * 100)}
			className="h-1.5 overflow-hidden rounded-full bg-line"
		>
			<div
				className="aurora h-full rounded-full transition-[width] duration-500"
				style={{ width: `${Math.max(2, value * 100)}%` }}
			/>
		</div>
	);
}

/** Installing the trainer, before anything can be trained. */
function Install({ status }: { status: TrainerStatus }) {
	const i18n = useI18n();
	const { t, bytes, explain } = i18n;
	const install = useMutation({ mutationFn: api.installTrainer });
	const cancel = useMutation({ mutationFn: api.cancelTrainerInstall });
	const step = status.install;
	if (step) {
		const fraction =
			step.totalBytes && step.receivedBytes != null
				? step.receivedBytes / step.totalBytes
				: null;
		return (
			<div className="flex flex-col gap-2" role="status">
				<p className="text-sm">{stepText(t, step.step)}</p>
				{fraction != null && (
					<>
						<Bar value={fraction} label={stepText(t, step.step)} />
						<p className="font-mono text-xs text-dim">
							{t("training.install.received", {
								received: bytes(step.receivedBytes ?? 0),
								total: bytes(step.totalBytes ?? 0),
							})}
						</p>
					</>
				)}
				{step.step === "packages" && (
					<p className="text-xs leading-relaxed text-dim">
						{t("training.install.packagesHint")}
					</p>
				)}
				<div>
					<button
						type="button"
						onClick={() => cancel.mutate()}
						className="rounded-md border border-line px-3 py-1 text-sm text-dim hover:border-dim hover:text-ink"
					>
						{t("common.cancel")}
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			<p className="text-sm leading-relaxed text-dim">
				{t("training.install.intro", { size: bytes(status.downloadBytes) })}
			</p>
			{status.error && (
				<p className="text-sm text-danger">{explain(status.error)}</p>
			)}
			{/* A failed install may leave gigabytes behind. */}
			{status.error && <Remove />}
			{install.error && (
				<p className="text-sm text-danger">{explain(install.error)}</p>
			)}
			<div>
				<button
					type="button"
					onClick={() => install.mutate()}
					disabled={install.isPending}
					className="aurora rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
				>
					{t("training.install.start")}
				</button>
			</div>
		</div>
	);
}

/** The pictures a training drew along the way, the latest largest. */
function Samples({ training }: { training: TrainingView }) {
	const { t } = useI18n();
	if (training.samples.length === 0) return null;
	const latest = training.samples.at(-1) as number;
	return (
		<div className="flex flex-col gap-2">
			<p className="text-sm">{t("training.samples")}</p>
			<div className="flex flex-wrap items-end gap-2">
				{training.samples.map((step) => (
					<figure key={step} className="flex flex-col gap-1">
						<a
							href={sampleUrl(training.id, step)}
							target="_blank"
							rel="noreferrer"
						>
							<img
								src={sampleUrl(training.id, step)}
								alt={t("training.sampleAt", { step })}
								className={`rounded border border-line object-cover ${
									step === latest ? "h-40 w-40" : "h-20 w-20"
								}`}
							/>
						</a>
						<figcaption className="font-mono text-xs text-dim">
							{t("training.sampleAt", { step })}
						</figcaption>
					</figure>
				))}
			</div>
		</div>
	);
}

/** A training under way, or how the last one ended. */
function Progress({ training }: { training: TrainingView }) {
	const i18n = useI18n();
	const { t, bytes, explain } = i18n;
	const cancel = useMutation({ mutationFn: api.cancelTraining });
	const finish = useMutation({ mutationFn: api.finishTraining });
	if (training.state !== "running") {
		return (
			<div className="flex flex-col gap-3">
				{training.state === "done" && (
					<p className="text-sm text-good" role="status">
						{training.keptStep != null
							? t("training.doneKept", {
									name: training.name,
									trigger: training.trigger,
									step: training.keptStep,
								})
							: t("training.done", {
									name: training.name,
									trigger: training.trigger,
								})}
					</p>
				)}
				{training.state === "canceled" && (
					<p className="text-sm text-dim" role="status">
						{t("training.canceled", { name: training.name })}
					</p>
				)}
				{training.state === "failed" && (
					<p className="text-sm text-danger" role="alert">
						{training.error
							? explain(training.error)
							: t("training.failed", { name: training.name })}
					</p>
				)}
				<Samples training={training} />
			</div>
		);
	}
	const fraction = training.steps > 0 ? training.step / training.steps : 0;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-baseline justify-between gap-2">
					<p className="font-medium">{training.name}</p>
					<p className="text-sm text-dim" role="status">
						{stageText(t, training.stage)}
					</p>
				</div>
				<Bar value={fraction} label={stageText(t, training.stage)} />
				<p className="font-mono text-xs text-dim">
					{t("training.steps", { step: training.step, steps: training.steps })}
					{training.secondsLeft != null &&
						` · ${remaining(i18n, training.secondsLeft)}`}
					{training.freeMemoryBytes != null &&
						` · ${t("training.freeMemory", { free: bytes(training.freeMemoryBytes) })}`}
				</p>
				<p className="text-xs leading-relaxed text-dim">
					{t("training.runningHint")}
				</p>
			</div>
			<Samples training={training} />
			<p className="text-xs leading-relaxed text-dim">
				{t("training.samplesHint")}
			</p>
			{finish.error && (
				<p className="text-sm text-danger">{explain(finish.error)}</p>
			)}
			<div className="flex flex-wrap gap-2">
				{training.savedStep != null && training.step < training.steps && (
					<button
						type="button"
						onClick={() => finish.mutate()}
						disabled={finish.isPending}
						className="rounded-md border border-line px-3 py-1 text-sm hover:border-dim disabled:opacity-40"
					>
						{t("training.keep", { step: training.savedStep })}
					</button>
				)}
				<button
					type="button"
					onClick={() => cancel.mutate()}
					className="rounded-md border border-line px-3 py-1 text-sm text-dim hover:border-dim hover:text-ink"
				>
					{t("training.cancel")}
				</button>
			</div>
		</div>
	);
}

/** A picture to train on, and what it shows. */
interface Picture {
	asset: Asset;
	caption: string;
	/** Its size once shown, to warn about small ones. */
	size?: { width: number; height: number };
}

/** The pictures that can be trained on. */
const TRAINABLE = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Below this on the short side, a picture trains blurry. */
const SMALL_SIDE = 768;

/** Pictures made here, to train on. */
function GalleryChooser({
	chosen,
	toggle,
	close,
}: {
	chosen: Set<string>;
	toggle(asset: Asset): void;
	close(): void;
}) {
	const { t, explain } = useI18n();
	const pages = useInfiniteQuery({
		queryKey: ["gallery", ""],
		queryFn: ({ pageParam }) => api.gallery("", pageParam),
		initialPageParam: undefined as GalleryItem | undefined,
		getNextPageParam: (last) =>
			last.length < GALLERY_PAGE ? undefined : last.at(-1),
	});
	const items = (pages.data?.pages.flat() ?? []).filter((item) =>
		TRAINABLE.has(item.mime),
	);
	return (
		<div className="flex flex-col gap-2 rounded-md border border-line bg-bg p-2">
			{pages.error && (
				<p className="text-sm text-danger">{explain(pages.error)}</p>
			)}
			{pages.isSuccess && items.length === 0 && (
				<p className="text-sm text-dim">{t("training.galleryEmpty")}</p>
			)}
			<ul className="grid max-h-72 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-6">
				{items.map((item) => {
					const on = chosen.has(item.id);
					return (
						<li key={item.id}>
							<button
								type="button"
								onClick={() => toggle(item)}
								aria-pressed={on}
								aria-label={t("training.pickPicture")}
								title={item.prompt ?? undefined}
								className={`block aspect-square w-full overflow-hidden rounded border-2 ${
									on ? "border-accent" : "border-transparent hover:border-line"
								}`}
							>
								<img
									src={assetUrl(item.id)}
									alt=""
									loading="lazy"
									className="h-full w-full object-cover"
								/>
							</button>
						</li>
					);
				})}
			</ul>
			<div className="flex flex-wrap gap-2">
				{pages.hasNextPage && (
					<button
						type="button"
						onClick={() => void pages.fetchNextPage()}
						disabled={pages.isFetchingNextPage}
						className="rounded-md px-2 py-1 text-sm text-dim hover:text-ink disabled:opacity-40"
					>
						{t("training.galleryMore")}
					</button>
				)}
				<button
					type="button"
					onClick={close}
					className="rounded-md border border-line px-3 py-1 text-sm hover:border-dim"
				>
					{t("training.galleryClose")}
				</button>
			</div>
		</div>
	);
}

/** What to train: pictures with captions, a name, a trigger word and steps. */
function Form({ hidden }: { hidden: boolean }) {
	const client = useQueryClient();
	const { t, explain } = useI18n();
	const input = useRef<HTMLInputElement>(null);
	const [pictures, setPictures] = useState<Picture[]>([]);
	// The latest pictures, for describing that goes on across renders.
	const latest = useRef(pictures);
	latest.current = pictures;
	const [name, setName] = useState("");
	const [trigger, setTrigger] = useState("");
	const [steps, setSteps] = useState(String(DEFAULT_STEPS));
	const [consent, setConsent] = useState(false);
	const [choosing, setChoosing] = useState(false);
	const captioner = useQuery({
		queryKey: ["captioner"],
		queryFn: api.captioner,
	});
	const add = (asset: Asset) =>
		setPictures((current) =>
			current.length >= MAX_PICTURES ||
			current.some((p) => p.asset.id === asset.id)
				? current
				: [...current, { asset, caption: "" }],
		);
	const change = (id: string, change: Partial<Picture>) =>
		setPictures((current) =>
			current.map((p) => (p.asset.id === id ? { ...p, ...change } : p)),
		);
	const upload = useMutation({
		mutationFn: async (files: File[]) => {
			for (const file of files) add(await api.upload(file));
		},
	});
	// Describing goes one picture at a time: each takes the model a while.
	const describing = useRef<AbortController | null>(null);
	const [described, setDescribed] = useState<{
		id: string;
		n: number;
		total: number;
	} | null>(null);
	const [describeError, setDescribeError] = useState<unknown>(null);
	// Stopped when the form goes away: each picture is half a minute of work.
	useEffect(() => () => describing.current?.abort(), []);
	/** Describes pictures one by one; with `onlyEmpty`, those still without a caption. */
	const describe = async (which: Picture[], onlyEmpty: boolean) => {
		describing.current?.abort();
		const controller = new AbortController();
		describing.current = controller;
		setDescribeError(null);
		try {
			for (const [i, picture] of which.entries()) {
				const now = latest.current.find((p) => p.asset.id === picture.asset.id);
				// Removed, or captioned by hand meanwhile.
				if (!now || (onlyEmpty && now.caption.trim())) continue;
				setDescribed({ id: picture.asset.id, n: i + 1, total: which.length });
				const { caption } = await api.caption(
					picture.asset.id,
					controller.signal,
				);
				const typed = latest.current.find(
					(p) => p.asset.id === picture.asset.id,
				)?.caption;
				if (!onlyEmpty || !typed?.trim()) change(picture.asset.id, { caption });
			}
		} catch (error) {
			if (!controller.signal.aborted) setDescribeError(error);
		} finally {
			if (describing.current === controller) {
				describing.current = null;
				setDescribed(null);
			}
		}
	};
	const stopDescribing = () => {
		describing.current?.abort();
		describing.current = null;
		setDescribed(null);
	};
	const train = useMutation({
		mutationFn: () =>
			api.train({
				name: name.trim(),
				trigger: trigger.trim(),
				steps: Number(steps),
				pictures: pictures.map((p) => ({
					assetId: p.asset.id,
					caption: p.caption,
				})),
				consent,
			}),
		// Shown as running at once, not when the next event arrives.
		onSuccess: (training) =>
			client.setQueryData<TrainerStatus>(["trainer"], (status) =>
				status ? { ...status, training } : status,
			),
	});
	const ready =
		pictures.length >= MIN_PICTURES &&
		name.trim() !== "" &&
		/^[\p{L}\p{N}_-]{2,40}$/u.test(trigger.trim()) &&
		Number(steps) >= 100 &&
		Number(steps) <= 4000 &&
		consent &&
		!described;
	const uncaptioned = pictures.filter((p) => !p.caption.trim());
	const field = "rounded-md border border-line bg-bg px-3 py-2 text-sm";
	const small =
		"rounded-md border border-line px-3 py-1 text-sm hover:border-dim disabled:opacity-40";
	return (
		<form
			hidden={hidden}
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (ready) train.mutate();
			}}
		>
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="text-sm">
						{t("training.pictures", {
							count: pictures.length,
							min: MIN_PICTURES,
						})}
					</p>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={() => input.current?.click()}
							disabled={upload.isPending}
							className={small}
						>
							{upload.isPending
								? t("training.adding")
								: t("training.addPictures")}
						</button>
						<button
							type="button"
							onClick={() => setChoosing((open) => !open)}
							aria-expanded={choosing}
							className={small}
						>
							{t("training.fromGallery")}
						</button>
					</div>
					<input
						ref={input}
						type="file"
						accept="image/png,image/jpeg,image/webp"
						multiple
						hidden
						onChange={(event) => {
							const files = [...(event.target.files ?? [])];
							event.target.value = "";
							if (files.length) upload.mutate(files);
						}}
					/>
				</div>
				<p className="text-xs leading-relaxed text-dim">
					{t("training.picturesHint")}
				</p>
				{upload.error && (
					<p className="text-sm text-danger">{explain(upload.error)}</p>
				)}
				{choosing && (
					<GalleryChooser
						chosen={new Set(pictures.map((p) => p.asset.id))}
						toggle={(asset) =>
							setPictures((current) =>
								current.some((p) => p.asset.id === asset.id)
									? current.filter((p) => p.asset.id !== asset.id)
									: current.length >= MAX_PICTURES
										? current
										: [...current, { asset, caption: "" }],
							)
						}
						close={() => setChoosing(false)}
					/>
				)}
				{pictures.length > 0 && (
					<ul className="grid gap-2 sm:grid-cols-2">
						{pictures.map((picture, index) => {
							const size = picture.size;
							const tooSmall =
								size != null && Math.min(size.width, size.height) < SMALL_SIDE;
							const busy = described?.id === picture.asset.id;
							return (
								<li
									key={picture.asset.id}
									className="flex items-start gap-2 rounded-md border border-line bg-bg p-1.5"
								>
									<div className="relative shrink-0">
										<img
											src={assetUrl(picture.asset.id)}
											alt=""
											onLoad={(event) => {
												const { naturalWidth, naturalHeight } =
													event.currentTarget;
												change(picture.asset.id, {
													size: { width: naturalWidth, height: naturalHeight },
												});
											}}
											className={`h-20 w-20 rounded object-cover ${busy ? "animate-pulse" : ""}`}
										/>
										{tooSmall && (
											<span
												title={t("training.smallHint", {
													width: size.width,
													height: size.height,
												})}
												className="absolute bottom-0.5 left-0.5 rounded bg-bg/80 px-1 text-[10px] text-danger"
											>
												{t("training.small")}
											</span>
										)}
									</div>
									<textarea
										value={picture.caption}
										onChange={(event) =>
											change(picture.asset.id, { caption: event.target.value })
										}
										placeholder={t("training.captionPlaceholder")}
										aria-label={t("training.captionOf", { n: index + 1 })}
										maxLength={500}
										rows={3}
										disabled={busy}
										className="min-w-0 flex-1 resize-none rounded border border-line bg-panel px-2 py-1 text-sm"
									/>
									<div className="flex flex-col items-center">
										<button
											type="button"
											onClick={() =>
												setPictures((current) =>
													current.filter(
														(p) => p.asset.id !== picture.asset.id,
													),
												)
											}
											aria-label={t("training.removePicture", { n: index + 1 })}
											className="rounded px-1.5 text-dim hover:text-ink"
										>
											×
										</button>
										{captioner.data?.ready && (
											<button
												type="button"
												onClick={() => void describe([picture], false)}
												disabled={described != null}
												aria-label={t("training.describe", { n: index + 1 })}
												title={t("training.describe", { n: index + 1 })}
												className="rounded px-1.5 text-dim hover:text-ink disabled:opacity-40"
											>
												✎
											</button>
										)}
									</div>
								</li>
							);
						})}
					</ul>
				)}
				{pictures.length > 0 && (
					<div className="flex flex-col gap-2">
						{captioner.data?.ready ? (
							<div className="flex flex-wrap items-center gap-2">
								{described ? (
									<>
										<p className="text-sm" role="status">
											{t("training.describing", {
												n: described.n,
												total: described.total,
											})}
										</p>
										<button
											type="button"
											onClick={stopDescribing}
											className={small}
										>
											{t("training.describeStop")}
										</button>
									</>
								) : (
									uncaptioned.length > 0 && (
										<button
											type="button"
											onClick={() => void describe(uncaptioned, true)}
											className={small}
										>
											{t("training.describeAll")}
										</button>
									)
								)}
							</div>
						) : (
							captioner.isSuccess && (
								<p className="text-xs leading-relaxed text-dim">
									{t("training.describeNeedsModel")}
								</p>
							)
						)}
						<p className="text-xs leading-relaxed text-dim">
							{t("training.describeHint")}
						</p>
						{describeError != null && (
							<p className="text-sm text-danger">{explain(describeError)}</p>
						)}
					</div>
				)}
			</div>
			<div className="flex flex-wrap gap-3">
				<label className="flex min-w-48 flex-1 flex-col gap-1 text-sm text-dim">
					{t("training.name")}
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={80}
						placeholder={t("training.namePlaceholder")}
						className={field}
					/>
				</label>
				<label className="flex min-w-48 flex-1 flex-col gap-1 text-sm text-dim">
					{t("training.trigger")}
					<input
						value={trigger}
						onChange={(event) => setTrigger(event.target.value)}
						maxLength={40}
						placeholder={t("training.triggerPlaceholder")}
						spellCheck={false}
						className={`${field} font-mono`}
					/>
				</label>
				<label className="flex w-32 flex-col gap-1 text-sm text-dim">
					{t("training.stepsLabel")}
					<input
						type="number"
						min={100}
						max={4000}
						step={50}
						value={steps}
						onChange={(event) => setSteps(event.target.value)}
						className={`${field} font-mono`}
					/>
				</label>
			</div>
			<p className="text-xs leading-relaxed text-dim">
				{t("training.triggerHint")}
			</p>
			<label className="flex items-start gap-2 text-sm">
				<input
					type="checkbox"
					checked={consent}
					onChange={(event) => setConsent(event.target.checked)}
					className="mt-0.5 accent-accent"
				/>
				{t("training.consent")}
			</label>
			{train.error && (
				<p className="text-sm text-danger">{explain(train.error)}</p>
			)}
			<div>
				<button
					type="submit"
					disabled={!ready || train.isPending}
					className="aurora rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
				>
					{t("training.start")}
				</button>
			</div>
		</form>
	);
}

/** Deletes the trainer, to give its gigabytes back. */
function Remove() {
	const { t, explain } = useI18n();
	const [confirming, setConfirming] = useState(false);
	const remove = useMutation({ mutationFn: api.removeTrainer });
	return (
		<div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
			{confirming ? (
				<>
					<span className="text-dim">{t("training.removeAsk")}</span>
					<button
						type="button"
						onClick={() => remove.mutate()}
						disabled={remove.isPending}
						className="rounded-md bg-danger px-3 py-1 font-medium text-bg disabled:opacity-40"
					>
						{t("training.removeConfirm")}
					</button>
					<button
						type="button"
						onClick={() => setConfirming(false)}
						className="rounded-md px-3 py-1 text-dim hover:text-ink"
					>
						{t("common.cancel")}
					</button>
				</>
			) : (
				<button
					type="button"
					onClick={() => setConfirming(true)}
					className="rounded-md px-2 py-1 text-dim hover:text-ink"
				>
					{t("training.remove")}
				</button>
			)}
			{remove.error && <p className="text-danger">{explain(remove.error)}</p>}
		</div>
	);
}

/** Training a LoRA from the person's own pictures. */
export function TrainPanel() {
	const { t, explain } = useI18n();
	const can = useCan();
	const status = useQuery({ queryKey: ["trainer"], queryFn: api.trainer });
	const data = status.data;
	return (
		<section className="mt-4 flex flex-col gap-4 rounded-lg border border-line bg-panel p-4">
			<div>
				<h3 className="font-display text-lg font-bold tracking-tight">
					{t("training.title")}
				</h3>
				<p className="mt-1 text-sm leading-relaxed text-dim">
					{t("training.intro")}
				</p>
			</div>
			{status.error && (
				<p className="text-sm text-danger">{explain(status.error)}</p>
			)}
			{data && data.state !== "ready" && can.admin && <Install status={data} />}
			{data && data.state !== "ready" && !can.admin && (
				<p className="text-sm text-dim">{t("training.askAdmin")}</p>
			)}
			{data?.state === "ready" && (
				<>
					{data.training && <Progress training={data.training} />}
					{/* Kept while it trains: after a failure the pictures are still here. */}
					<Form hidden={data.training?.state === "running"} />
					{data.training?.state !== "running" && can.admin && <Remove />}
				</>
			)}
		</section>
	);
}
