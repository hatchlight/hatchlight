import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDemo } from "./api";
import { useI18n } from "./i18n";
import { navigate } from "./route";
import {
	type ChapterId,
	chaptersFor,
	loadProgress,
	type Step,
	saveProgress,
	stepsFor,
	type TourProgress,
	tourReducer,
} from "./tour";

/** How long a step waits for what it points at to appear. */
const WAIT_MS = 3000;
/** Room around what a step points at, and between it and the card. */
const PAD = 6;
const GAP = 12;
const EDGE = 16;
/** One toast for the offer, so it is not shown twice. */
const OFFER_ID = "tour-offer";

interface Tour {
	/** The chapters this app offers, and which ones were read to the end. */
	chapters: ChapterId[];
	done: ChapterId[];
	start(chapter: ChapterId): void;
	/** Offers the tour once, after the welcome. */
	offer(): void;
	/** Forgets what was read, so every chapter can be offered again. */
	reset(): void;
}

const TourContext = createContext<Tour | null>(null);

export function useTour(): Tour {
	const value = useContext(TourContext);
	if (!value) throw new Error("useTour must be used inside a TourProvider");
	return value;
}

export function TourProvider({ children }: { children: ReactNode }) {
	const { t } = useI18n();
	const demo = useDemo() !== null;
	const [progress, setProgress] = useState(() => loadProgress());
	const count = useCallback(
		(chapter: ChapterId) => stepsFor(chapter, { demo }).length,
		[demo],
	);
	const [state, dispatch] = useReducer(
		(
			current: Parameters<typeof tourReducer>[0],
			action: Parameters<typeof tourReducer>[1],
		) => tourReducer(current, action, count),
		null,
	);

	const keep = useCallback((next: (current: TourProgress) => TourProgress) => {
		setProgress((current) => {
			const updated = next(current);
			saveProgress(updated);
			return updated;
		});
	}, []);

	const value = useMemo<Tour>(
		() => ({
			chapters: chaptersFor({ demo }),
			done: progress.done,
			start: (chapter) => {
				toast.dismiss(OFFER_ID);
				dispatch({ type: "start", chapter });
			},
			offer: () => {
				// A demo's visitors came to try it, not to be shown around.
				if (demo || progress.offered || progress.done.includes("basics"))
					return;
				keep((current) => ({ ...current, offered: true }));
				toast(t("tour.offer"), {
					id: OFFER_ID,
					description: t("tour.offerBody"),
					duration: 15000,
					action: {
						label: t("tour.offerStart"),
						onClick: () => dispatch({ type: "start", chapter: "basics" }),
					},
					cancel: { label: t("tour.offerLater"), onClick: () => {} },
				});
			},
			reset: () => keep(() => ({ done: [], offered: true })),
		}),
		[demo, progress, keep, t],
	);

	// While the tour runs, the app behind it takes neither focus nor clicks.
	const running = state !== null;
	useEffect(() => {
		const root = document.getElementById("root");
		if (!running || !root) return;
		root.inert = true;
		return () => {
			root.inert = false;
		};
	}, [running]);

	const steps = state ? stepsFor(state.chapter, { demo }) : [];
	const step = state ? steps[state.index] : undefined;

	return (
		<TourContext.Provider value={value}>
			{children}
			{state && step && (
				<Overlay
					key={`${state.chapter}/${step.id}`}
					step={step}
					index={state.index}
					total={steps.length}
					onBack={() => dispatch({ type: "back" })}
					onNext={() => {
						if (state.index === steps.length - 1) {
							const chapter = state.chapter;
							keep((current) => ({
								...current,
								done: current.done.includes(chapter)
									? current.done
									: [...current.done, chapter],
							}));
						}
						dispatch({ type: "next" });
					}}
					onMissing={() => dispatch({ type: "missing" })}
					onStop={() => dispatch({ type: "stop" })}
				/>
			)}
		</TourContext.Provider>
	);
}

/** The first element named `name` that is on screen. */
function visible(name: string): HTMLElement | null {
	for (const element of document.querySelectorAll<HTMLElement>(
		`[data-tour="${name}"]`,
	)) {
		const box = element.getBoundingClientRect();
		if (box.width > 0 && box.height > 0) return element;
	}
	return null;
}

const reducedMotion = () =>
	window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

type Box = { top: number; left: number; width: number; height: number };

/** Where the card goes: under what it points at, else above, else at the bottom. */
function place(target: Box | null, card: { width: number; height: number }) {
	const width = window.innerWidth;
	const height = window.innerHeight;
	if (!target) {
		return {
			top: Math.max(EDGE, (height - card.height) / 2),
			left: Math.max(EDGE, (width - card.width) / 2),
		};
	}
	const left = Math.min(
		Math.max(EDGE, target.left + target.width / 2 - card.width / 2),
		Math.max(EDGE, width - card.width - EDGE),
	);
	const below = target.top + target.height + PAD + GAP;
	if (below + card.height <= height - EDGE) return { top: below, left };
	const above = target.top - PAD - GAP - card.height;
	if (above >= EDGE) return { top: above, left };
	return { top: Math.max(EDGE, height - card.height - EDGE), left };
}

function Overlay({
	step,
	index,
	total,
	onBack,
	onNext,
	onMissing,
	onStop,
}: {
	step: Step;
	index: number;
	total: number;
	onBack(): void;
	onNext(): void;
	onMissing(): void;
	onStop(): void;
}) {
	const { t, number } = useI18n();
	const id = useId();
	const card = useRef<HTMLDivElement>(null);
	// Undefined while the step looks for what it points at.
	const [target, setTarget] = useState<HTMLElement | null | undefined>(
		step.targets.length === 0 ? null : undefined,
	);
	const [box, setBox] = useState<Box | null>(null);
	const [spot, setSpot] = useState<{ top: number; left: number } | null>(null);
	const { title, body } = step.text(t);
	const last = index === total - 1;
	// The latest handlers, so a new render does not start the wait again.
	const handlers = useRef({ onBack, onNext, onMissing, onStop });
	handlers.current = { onBack, onNext, onMissing, onStop };

	// Go to the step's view, then wait for what it points at.
	useEffect(() => {
		if ((window.location.hash || "#/") !== step.to) navigate(step.to);
		if (step.targets.length === 0) return;
		const started = Date.now();
		const timer = window.setInterval(() => {
			const found = step.targets.map(visible).find(Boolean) ?? null;
			if (found) {
				window.clearInterval(timer);
				found.scrollIntoView({
					block: "center",
					behavior: reducedMotion() ? "auto" : "smooth",
				});
				setTarget(found);
			} else if (Date.now() - started > WAIT_MS) {
				window.clearInterval(timer);
				handlers.current.onMissing();
			}
		}, 100);
		return () => window.clearInterval(timer);
	}, [step]);

	// Follow what the step points at while the page scrolls or resizes.
	useEffect(() => {
		if (!target) {
			setBox(null);
			return;
		}
		let frame = 0;
		let previous = "";
		let element = target;
		const follow = () => {
			// The page may draw the element again, such as when its data
			// arrives anew: find the new one rather than measure the old.
			if (!element.isConnected) {
				element = step.targets.map(visible).find(Boolean) ?? element;
			}
			const r = element.getBoundingClientRect();
			const next = {
				top: r.top,
				left: r.left,
				width: r.width,
				height: r.height,
			};
			const key = `${next.top}|${next.left}|${next.width}|${next.height}`;
			if (key !== previous) {
				previous = key;
				setBox(next);
			}
			frame = requestAnimationFrame(follow);
		};
		follow();
		return () => cancelAnimationFrame(frame);
	}, [target, step]);

	useLayoutEffect(() => {
		if (target === undefined || !card.current) return;
		const size = card.current.getBoundingClientRect();
		setSpot(place(box, { width: size.width, height: size.height }));
	}, [box, target]);

	// The card takes the keyboard once it shows.
	const shown = spot !== null;
	useEffect(() => {
		if (!shown) return;
		const take = () => {
			if (!card.current?.contains(document.activeElement)) {
				card.current?.focus({ preventScroll: true });
			}
		};
		take();
		// A menu or drawer that just closed hands focus back to what opened
		// it, behind the tour: take it back once it has.
		const frame = requestAnimationFrame(take);
		document.addEventListener("focusin", take);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("focusin", take);
		};
	}, [shown]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// Shortcuts such as Alt+Left, held keys and keys already used stay
			// with the browser and the page.
			if (
				event.defaultPrevented ||
				event.repeat ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey
			)
				return;
			const { onBack, onNext, onStop } = handlers.current;
			if (event.key === "Escape") onStop();
			else if (event.key === "ArrowRight") onNext();
			else if (event.key === "ArrowLeft" && index > 0) onBack();
			else return;
			event.preventDefault();
			// Not also for a dialog under the tour.
			event.stopPropagation();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [index]);

	return createPortal(
		<div className="fixed inset-0 z-[60]">
			{/* Holds the page still: the tour points, the reader looks. */}
			<div
				aria-hidden="true"
				className={cn("absolute inset-0", !box && "bg-black/75")}
			/>
			{box && (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute rounded-xl ring-2 ring-orange/70 shadow-[0_0_0_9999px_rgb(0_0_0/0.75)] motion-safe:transition-all motion-safe:duration-300"
					style={{
						top: box.top - PAD,
						left: box.left - PAD,
						width: box.width + PAD * 2,
						height: box.height + PAD * 2,
					}}
				/>
			)}
			<div
				ref={card}
				role="dialog"
				aria-modal="true"
				aria-labelledby={`${id}-title`}
				aria-describedby={`${id}-body`}
				tabIndex={-1}
				className={cn(
					"absolute flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl border border-line bg-panel p-5 text-ink shadow-2xl outline-none motion-safe:transition-[top,left] motion-safe:duration-300",
					(target === undefined || !spot) && "invisible",
				)}
				// Focus moves here for the keyboard; the card itself needs no outline.
				style={{ ...(spot ?? { top: 0, left: 0 }), outline: "none" }}
			>
				<p aria-live="polite" className="font-mono text-[11px] text-dim">
					{t("tour.counter", {
						current: number(index + 1),
						total: number(total),
					})}
				</p>
				<h2
					id={`${id}-title`}
					className="font-display text-lg font-bold tracking-tight"
				>
					{title}
				</h2>
				<p id={`${id}-body`} className="text-sm leading-relaxed text-soft">
					{body}
				</p>
				<div className="mt-1 flex items-center gap-2">
					<Button variant="ghost" onClick={onStop} className="-ml-2 text-dim">
						{t("tour.skip")}
					</Button>
					<span className="flex-1" />
					{index > 0 && (
						<Button variant="outline" onClick={onBack}>
							{t("tour.back")}
						</Button>
					)}
					<Button variant="aurora" onClick={onNext}>
						{last ? t("tour.done") : t("tour.next")}
					</Button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
