import type { CheckpointBase, LoraBase } from "./types";

/**
 * Opening a model from Hugging Face: what a link to a repository says, read
 * strictly, and what Hatchlight can do with it. Links come from web pages
 * and other programs, so nothing in them is trusted. This file has no
 * dependencies, so the app's page and the site can use it too.
 */

/** The only address models are looked up and downloaded from. */
export const HUB_ORIGIN = "https://huggingface.co";

/** A repository, such as "owner/name", and maybe one file in it. */
export interface HubTarget {
	repo: string;
	/** A path inside the repository, such as "lora.safetensors". */
	file: string | null;
}

/** A link longer than this is not one Hatchlight makes or reads. */
export const MAX_HUB_LINK = 2048;

// Hugging Face's own rules for user, organization and repository names:
// letters, digits, "-", "_" and ".", not at either end, no "--" or "..".
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// A folder or file name inside a repository, kept to plain characters.
const SEGMENT = /^[A-Za-z0-9_()+-](?:[A-Za-z0-9._()+ -]*[A-Za-z0-9._()+-])?$/;

/** An owner's or a repository's name, as Hugging Face allows them. */
export function isHubName(part: string): boolean {
	return (
		part.length <= 96 &&
		NAME.test(part) &&
		!part.includes("..") &&
		!part.includes("--")
	);
}

/** A path inside a repository: no "..", no leading "/", no odd characters. */
export function isHubFile(path: string): boolean {
	if (!path || path.length > 256) return false;
	const parts = path.split("/");
	return (
		parts.length <= 8 &&
		parts.every((part) => SEGMENT.test(part) && !part.includes(".."))
	);
}

/** A repository and file, checked; null when either is not valid. */
export function hubTarget(repo: unknown, file?: unknown): HubTarget | null {
	if (typeof repo !== "string") return null;
	const parts = repo.split("/");
	if (parts.length !== 2 || !parts.every(isHubName)) return null;
	if (file == null || file === "") return { repo, file: null };
	if (typeof file !== "string" || !isHubFile(file)) return null;
	return { repo, file };
}

/**
 * Reads `hatchlight://hf/<owner>/<repo>[?file=<path>]`, the link that
 * Hugging Face's "Use this model" menu and hatchlight.app/hf open. Anything
 * else, or anything more, is not one.
 */
export function parseHubLink(link: string): HubTarget | null {
	if (typeof link !== "string" || link.length > MAX_HUB_LINK) return null;
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		return null;
	}
	if (
		url.protocol !== "hatchlight:" ||
		url.host !== "hf" ||
		url.username ||
		url.password ||
		url.hash
	) {
		return null;
	}
	const path = url.pathname.replace(/^\//, "").replace(/\/$/, "");
	const keys = [...url.searchParams.keys()];
	if (keys.some((key) => key !== "file") || keys.length > 1) return null;
	const file = url.searchParams.get("file");
	// An empty `?file=` is a mistake, not "no file".
	if (file === "") return null;
	return hubTarget(path, file);
}

/** Reads `hf:<owner>/<repo>[/<file>]`, as typed after `hatchlight install`. */
export function parseHubSpec(spec: string): HubTarget | null {
	if (!spec.startsWith("hf:")) return null;
	const [owner, repo, ...file] = spec.slice(3).split("/");
	if (!owner || !repo) return null;
	return hubTarget(`${owner}/${repo}`, file.join("/"));
}

/** The link that opens a repository, or a file in it, in Hatchlight. */
export function hubLink(target: HubTarget): string {
	const query = target.file
		? `?${new URLSearchParams({ file: target.file })}`
		: "";
	return `hatchlight://hf/${target.repo}${query}`;
}

/** The repository's page on Hugging Face. */
export const hubRepoUrl = (repo: string) => `${HUB_ORIGIN}/${repo}`;

/** Why a repository cannot be opened in Hatchlight yet. */
export const HUB_UNSUPPORTED = [
	/** No such repository, or a private one. */
	"notFound",
	/** Its files are only given to people who accept its terms there. */
	"gated",
	/** No single model file: such as a diffusers folder of many files. */
	"noFile",
	/** Several model files, and the link does not say which one. */
	"manyFiles",
	/** The file the link names is not in the repository. */
	"fileNotFound",
	/** Not a .safetensors file. */
	"notSafetensors",
	/** Not a whole SDXL or SD 1.5 model, nor a LoRA Hatchlight knows. */
	"unknownFile",
	/** Larger than any model of its kind. */
	"tooLarge",
] as const;
export type HubUnsupported = (typeof HUB_UNSUPPORTED)[number];

/** A file Hatchlight can add, as it was found at one revision. */
export type HubFile =
	| {
			kind: "checkpoint";
			repo: string;
			file: string;
			/** The commit it was found at, so the file confirmed is the one fetched. */
			revision: string;
			size: number;
			/** The file's hash, when Hugging Face keeps one, to check the download. */
			sha256: string | null;
			/** What the repository says its license is, if anything. */
			license: string | null;
			base: CheckpointBase;
	  }
	| {
			kind: "lora";
			repo: string;
			file: string;
			revision: string;
			size: number;
			sha256: string | null;
			license: string | null;
			base: LoraBase;
	  };

/** What Hatchlight does with a repository. */
export type HubChoice =
	/** A model in the catalog: its install, with the variant that fits. */
	| { kind: "catalog"; repo: string; modelId: string }
	/** A file to add once the person confirms. */
	| HubFile
	| {
			kind: "unsupported";
			repo: string;
			file: string | null;
			reason: HubUnsupported;
	  };
