import { type HubTarget, hubTarget } from "@hatchlight/core/hugging-face";
import { useSyncExternalStore } from "react";

export type Route =
	/** A session; `talk` shows the conversation with the assistant. */
	| { view: "chat"; sessionId?: string; talk: boolean }
	| { view: "gallery" }
	/** `focus` is a catalog model to bring into view. */
	| { view: "models"; focus?: string }
	/** A repository opened from Hugging Face; null when the link was not valid. */
	| { view: "hub"; target: HubTarget | null }
	| { view: "ranking" }
	/** The person's characters and styles. */
	| { view: "library" }
	| { view: "settings" };

export function parse(hash: string): Route {
	const path = hash.replace(/^#\/?/, "");
	if (path.startsWith("hf/")) {
		const [repo = "", query = ""] = path.slice(3).split("?", 2);
		return {
			view: "hub",
			target: hubTarget(repo, new URLSearchParams(query).get("file")),
		};
	}
	const [, first, second, third] = hash.replace(/^#/, "").split("/");
	if (first === "gallery") return { view: "gallery" };
	if (first === "models") {
		// A broken escape in someone's link opens the page, not a blank screen.
		let focus: string | undefined;
		try {
			focus = second ? decodeURIComponent(second) : undefined;
		} catch {
			focus = undefined;
		}
		return focus ? { view: "models", focus } : { view: "models" };
	}
	if (first === "ranking") return { view: "ranking" };
	if (first === "library") return { view: "library" };
	if (first === "settings") return { view: "settings" };
	if (first === "talk") return { view: "chat", talk: true };
	if (first === "s" && second) {
		return { view: "chat", sessionId: second, talk: third === "talk" };
	}
	return { view: "chat", talk: false };
}

const subscribe = (notify: () => void) => {
	window.addEventListener("hashchange", notify);
	return () => window.removeEventListener("hashchange", notify);
};

export function useRoute(): Route {
	const hash = useSyncExternalStore(subscribe, () => window.location.hash);
	return parse(hash);
}

export const href = {
	newChat: "#/",
	session: (id: string) => `#/s/${id}`,
	newTalk: "#/talk",
	talk: (id: string) => `#/s/${id}/talk`,
	gallery: "#/gallery",
	models: "#/models",
	model: (id: string) => `#/models/${encodeURIComponent(id)}`,
	hub: (target: HubTarget) =>
		`#/hf/${target.repo}${target.file ? `?${new URLSearchParams({ file: target.file })}` : ""}`,
	/** A link that was not one to a repository. */
	hubInvalid: "#/hf/",
	ranking: "#/ranking",
	library: "#/library",
	settings: "#/settings",
};

export function navigate(to: string): void {
	window.location.hash = to;
}

/** Goes to `to` in place of where the app is, so Back does not come here again. */
export function redirect(to: string): void {
	window.location.replace(to);
}
