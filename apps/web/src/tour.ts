import { storedValue } from "@hatchlight/core/legacy";
import type { I18n } from "./i18n";
import { href, parse, type Route } from "./route";

/** The parts of the guided tour, each one started on its own. */
export const CHAPTERS = ["basics", "styles", "cloud"] as const;
export type ChapterId = (typeof CHAPTERS)[number];

export interface Step {
	id: string;
	/** Where the app goes before the step shows. */
	to: string;
	/**
	 * The `data-tour` names of what the step points at, tried in order: the
	 * first one on screen wins, so a step can point at the sidebar on a wide
	 * screen and at the bottom bar on a phone. None: a card in the middle.
	 */
	targets: string[];
	/** Not in a public demo, even where its view is open there. */
	hideInDemo?: boolean;
	/** The step's title and text, in the reader's language. */
	text(t: I18n["t"]): { title: string; body: string };
}

const STEPS: Record<ChapterId, Step[]> = {
	basics: [
		{
			id: "welcome",
			to: href.newChat,
			targets: [],
			text: (t) => ({
				title: t("tour.basics.welcome.title"),
				body: t("tour.basics.welcome.body"),
			}),
		},
		{
			id: "catalog",
			to: href.models,
			targets: ["models-catalog"],
			text: (t) => ({
				title: t("tour.basics.catalog.title"),
				body: t("tour.basics.catalog.body"),
			}),
		},
		{
			id: "machine",
			to: href.models,
			targets: ["models-machine"],
			text: (t) => ({
				title: t("tour.basics.machine.title"),
				body: t("tour.basics.machine.body"),
			}),
		},
		{
			id: "prompt",
			to: href.newChat,
			targets: ["composer-prompt"],
			text: (t) => ({
				title: t("tour.basics.prompt.title"),
				body: t("tour.basics.prompt.body"),
			}),
		},
		{
			id: "models",
			to: href.newChat,
			targets: ["composer-models", "composer-settings"],
			text: (t) => ({
				title: t("tour.basics.models.title"),
				body: t("tour.basics.models.body"),
			}),
		},
		{
			id: "generate",
			to: href.newChat,
			targets: ["composer-generate"],
			text: (t) => ({
				title: t("tour.basics.generate.title"),
				body: t("tour.basics.generate.body"),
			}),
		},
		{
			id: "modes",
			to: href.newChat,
			targets: ["session-tabs"],
			hideInDemo: true,
			text: (t) => ({
				title: t("tour.basics.modes.title"),
				body: t("tour.basics.modes.body"),
			}),
		},
		{
			id: "gallery",
			to: href.gallery,
			targets: ["gallery-header", "nav-gallery"],
			text: (t) => ({
				title: t("tour.basics.gallery.title"),
				body: t("tour.basics.gallery.body"),
			}),
		},
		{
			id: "done",
			to: href.gallery,
			targets: [],
			text: (t) => ({
				title: t("tour.basics.done.title"),
				body: t("tour.basics.done.body"),
			}),
		},
	],
	styles: [
		{
			id: "intro",
			to: href.models,
			targets: [],
			text: (t) => ({
				title: t("tour.styles.intro.title"),
				body: t("tour.styles.intro.body"),
			}),
		},
		{
			id: "shelf",
			to: href.models,
			targets: ["lora-shelf"],
			text: (t) => ({
				title: t("tour.styles.shelf.title"),
				body: t("tour.styles.shelf.body"),
			}),
		},
		{
			id: "train",
			to: href.models,
			targets: ["lora-train"],
			text: (t) => ({
				title: t("tour.styles.train.title"),
				body: t("tour.styles.train.body"),
			}),
		},
		{
			id: "choose",
			to: href.newChat,
			targets: ["composer-styles", "composer-settings", "composer-models"],
			// A demo has one model and no styles to choose.
			hideInDemo: true,
			text: (t) => ({
				title: t("tour.styles.choose.title"),
				body: t("tour.styles.choose.body"),
			}),
		},
		{
			id: "library",
			to: href.library,
			targets: ["library-styles"],
			text: (t) => ({
				title: t("tour.styles.library.title"),
				body: t("tour.styles.library.body"),
			}),
		},
		{
			id: "done",
			to: href.library,
			targets: [],
			text: (t) => ({
				title: t("tour.styles.done.title"),
				body: t("tour.styles.done.body"),
			}),
		},
	],
	cloud: [
		{
			id: "intro",
			to: href.settings,
			targets: [],
			text: (t) => ({
				title: t("tour.cloud.intro.title"),
				body: t("tour.cloud.intro.body"),
			}),
		},
		{
			id: "keys",
			to: href.settings,
			targets: ["settings-keys"],
			text: (t) => ({
				title: t("tour.cloud.keys.title"),
				body: t("tour.cloud.keys.body"),
			}),
		},
		{
			id: "helpers",
			to: href.settings,
			targets: ["settings-helpers"],
			text: (t) => ({
				title: t("tour.cloud.helpers.title"),
				body: t("tour.cloud.helpers.body"),
			}),
		},
		{
			id: "agents",
			to: href.settings,
			targets: ["settings-agents"],
			text: (t) => ({
				title: t("tour.cloud.agents.title"),
				body: t("tour.cloud.agents.body"),
			}),
		},
		{
			id: "server",
			to: href.settings,
			targets: [],
			text: (t) => ({
				title: t("tour.cloud.server.title"),
				body: t("tour.cloud.server.body"),
			}),
		},
	],
};

/** Views a public demo opens; the others send its visitors to a session. */
const DEMO_VIEWS: ReadonlySet<Route["view"]> = new Set(["chat", "gallery"]);

/** The steps of a chapter this app can show: a demo leaves out what it hides. */
export function stepsFor(chapter: ChapterId, { demo }: { demo: boolean }) {
	return STEPS[chapter].filter(
		(step) =>
			!demo || (!step.hideInDemo && DEMO_VIEWS.has(parse(step.to).view)),
	);
}

/** The chapters worth offering: those that point at something on screen. */
export function chaptersFor(options: { demo: boolean }): ChapterId[] {
	return CHAPTERS.filter((chapter) =>
		stepsFor(chapter, options).some((step) => step.targets.length > 0),
	);
}

export type TourState = {
	chapter: ChapterId;
	index: number;
	/** Which way the reader last moved, so a step with nothing to show is passed the same way. */
	direction: 1 | -1;
} | null;

export type TourAction =
	| { type: "start"; chapter: ChapterId }
	| { type: "next" }
	| { type: "back" }
	/** The step's target never appeared: pass it in the direction of travel. */
	| { type: "missing" }
	| { type: "stop" };

/**
 * Moves through a chapter of `count` steps. Going past the last step ends the
 * tour; Back on the first step stays there.
 */
export function tourReducer(
	state: TourState,
	action: TourAction,
	count: (chapter: ChapterId) => number,
): TourState {
	if (action.type === "start") {
		return { chapter: action.chapter, index: 0, direction: 1 };
	}
	if (!state || action.type === "stop") return null;
	const total = count(state.chapter);
	const direction =
		action.type === "next" ? 1 : action.type === "back" ? -1 : state.direction;
	const index = state.index + direction;
	if (index >= total) return null;
	if (index < 0) {
		// Nothing to show before the first step: go forward from there instead.
		return action.type === "missing"
			? { ...state, index: 1 < total ? 1 : 0, direction: 1 }
			: state;
	}
	return { ...state, index, direction };
}

export interface TourProgress {
	/** Chapters read to the end. */
	done: ChapterId[];
	/** Whether the tour was offered after the welcome. */
	offered: boolean;
}

const PROGRESS_KEY = "hatchlight.tour";

export function loadProgress(
	storage: Pick<Storage, "getItem"> = localStorage,
): TourProgress {
	try {
		const saved = JSON.parse(storedValue(storage, PROGRESS_KEY) ?? "{}");
		const done = Array.isArray(saved?.done)
			? CHAPTERS.filter((chapter) => saved.done.includes(chapter))
			: [];
		return { done, offered: saved?.offered === true };
	} catch {
		return { done: [], offered: false };
	}
}

export function saveProgress(
	progress: TourProgress,
	storage: Pick<Storage, "setItem"> = localStorage,
): void {
	try {
		storage.setItem(PROGRESS_KEY, JSON.stringify(progress));
	} catch {
		// Without storage, the tour is offered again on the next visit.
	}
}
