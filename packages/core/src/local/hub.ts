import { CodedError } from "../errors";
import {
	HUB_ORIGIN,
	type HubChoice,
	type HubFile,
	type HubTarget,
	type HubUnsupported,
	isHubFile,
} from "../hugging-face";
import type { LocalModelSpec } from "../types";
import { checkpointBaseOf, MAX_CHECKPOINT_BYTES } from "./checkpoints";
import { loraBaseOf, MAX_LORA_BYTES } from "./loras";
import { readSafetensorsHeader, type SafetensorsHeader } from "./shelf";

/**
 * What Hatchlight does with a Hugging Face repository someone opened: the
 * catalog's install when it knows the model, else a single checkpoint or
 * LoRA file, read from its first bytes before anything is downloaded.
 * Requests go to huggingface.co only, and follow redirects only to its own
 * file servers.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Hugging Face's site and the servers it sends file downloads to. */
const HUB_HOSTS = /(^|\.)(huggingface\.co|hf\.co)$/;
const MAX_REDIRECTS = 5;
/** A checkpoint's header is a few hundred kilobytes; more is not a model's. */
const MAX_REMOTE_HEADER = 16 * 1024 * 1024;
/** A commit id, as Hugging Face gives it. */
export const HUB_REVISION = /^[0-9a-f]{40}$/;

const unreachable = (status?: number) =>
	new CodedError(
		status ? `Hugging Face answered ${status}` : "Could not reach Hugging Face",
		"hubUnreachable",
		{ status: status ?? 0 },
	);

/** Fetches from Hugging Face, following redirects only to its own servers. */
export async function hubFetch(
	fetcher: Fetch,
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	let target = new URL(url);
	for (let hop = 0; ; hop++) {
		if (
			target.protocol !== "https:" ||
			!HUB_HOSTS.test(target.hostname) ||
			target.username ||
			target.password ||
			target.port
		) {
			throw unreachable();
		}
		let response: Response;
		try {
			response = await fetcher(target.href, { ...init, redirect: "manual" });
		} catch (error) {
			if (init.signal?.aborted) throw error;
			throw unreachable();
		}
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get("location");
		await response.body?.cancel().catch(() => {});
		if (!location || hop >= MAX_REDIRECTS) throw unreachable(response.status);
		target = new URL(location, target);
	}
}

/** A file's address at a fixed revision. */
export const hubFileUrl = (repo: string, revision: string, file: string) =>
	`${HUB_ORIGIN}/${repo}/resolve/${revision}/${file
		.split("/")
		.map(encodeURIComponent)
		.join("/")}`;

interface HubSibling {
	rfilename: string;
	size?: number;
	lfs?: { sha256?: string; size?: number };
}

interface HubInfo {
	sha: string;
	gated: boolean;
	siblings: HubSibling[];
	license: string | null;
}

/**
 * Text from Hugging Face, made safe to print: no control characters, and no
 * invisible format characters (such as bidi overrides) that could reorder
 * what the person reads. Cut by characters, never inside one.
 */
export const plain = (text: string, max = 80) =>
	[...text.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()].slice(0, max).join("");

function licenseOf(raw: Record<string, unknown>): string | null {
	const card = (
		raw.cardData && typeof raw.cardData === "object" ? raw.cardData : {}
	) as Record<string, unknown>;
	const named = Array.isArray(card.license) ? card.license[0] : card.license;
	const tag = Array.isArray(raw.tags)
		? raw.tags.find(
				(tag): tag is string =>
					typeof tag === "string" && tag.startsWith("license:"),
			)
		: undefined;
	const id = typeof named === "string" ? named : tag?.slice(8);
	if (id === "other" && typeof card.license_name === "string") {
		return plain(card.license_name) || id;
	}
	return id ? plain(id) || null : null;
}

/** A repository's files and license at a revision; null when there is none. */
async function hubInfo(
	fetcher: Fetch,
	repo: string,
	revision: string,
	signal?: AbortSignal,
): Promise<HubInfo | null> {
	const response = await hubFetch(
		fetcher,
		`${HUB_ORIGIN}/api/models/${repo}/revision/${revision}?blobs=true`,
		{ headers: { accept: "application/json" }, signal },
	);
	// Private repositories answer as if they did not exist.
	if ([401, 403, 404].includes(response.status)) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	if (!response.ok) throw unreachable(response.status);
	const raw = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (
		!raw ||
		typeof raw.sha !== "string" ||
		!HUB_REVISION.test(raw.sha) ||
		!Array.isArray(raw.siblings)
	) {
		throw unreachable(response.status);
	}
	const siblings = raw.siblings.filter(
		(file): file is HubSibling =>
			!!file &&
			typeof file === "object" &&
			typeof (file as HubSibling).rfilename === "string" &&
			isHubFile((file as HubSibling).rfilename),
	);
	return {
		sha: raw.sha,
		gated: raw.gated != null && raw.gated !== false,
		siblings,
		license: licenseOf(raw),
	};
}

/** `count` bytes from `start` of a file, or null when it has fewer. */
async function readRange(
	fetcher: Fetch,
	url: string,
	start: number,
	count: number,
	signal?: AbortSignal,
): Promise<Uint8Array | null> {
	const response = await hubFetch(fetcher, url, {
		headers: { range: `bytes=${start}-${start + count - 1}` },
		signal,
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	// A server that ignores the range sends the file from its start.
	const skip = response.status === 206 ? 0 : start;
	const out = new Uint8Array(count);
	let seen = 0;
	let kept = 0;
	const reader = response.body.getReader();
	try {
		while (kept < count) {
			const { done, value } = await reader.read();
			if (done) break;
			const from = Math.max(0, skip - seen);
			seen += value.byteLength;
			if (from >= value.byteLength) continue;
			const piece = value.subarray(from, from + (count - kept));
			out.set(piece, kept);
			kept += piece.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return kept === count ? out : null;
}

/** The names and notes at the start of a file on Hugging Face. */
async function remoteHeader(
	fetcher: Fetch,
	url: string,
	signal?: AbortSignal,
): Promise<SafetensorsHeader | null> {
	const head = await readRange(fetcher, url, 0, 8, signal);
	if (!head) return null;
	const length = Number(new DataView(head.buffer).getBigUint64(0, true));
	if (length < 2 || length > MAX_REMOTE_HEADER) return null;
	const rest = await readRange(fetcher, url, 8, length, signal);
	if (!rest) return null;
	return readSafetensorsHeader(
		new Blob([head, rest]),
		() => new Error("unreadable"),
	).catch(() => null);
}

/**
 * The catalog model that comes from this repository: one that uses the
 * file named, else one whose page it is, else one that uses any file of it.
 */
export function catalogModelFor(
	catalog: LocalModelSpec[],
	target: HubTarget,
): string | null {
	const repo = `${HUB_ORIGIN}/${target.repo}`.toLowerCase();
	// The prompt translator and the assistant are set up elsewhere.
	const models = catalog.filter((model) => model.media !== "text");
	const urls = (model: LocalModelSpec) =>
		model.variants.flatMap((v) => v.files.map((f) => f.url.toLowerCase()));
	const fromRepo = (url: string) => url.startsWith(`${repo}/resolve/`);
	const file = target.file?.toLowerCase();
	const usesFile = (url: string) =>
		fromRepo(url) &&
		url.slice(repo.length + "/resolve/".length).replace(/^[^/]+\//, "") ===
			file;
	const found =
		(file && models.find((model) => urls(model).some(usesFile))) ||
		models.find(
			(model) => model.homepage.toLowerCase().replace(/\/+$/, "") === repo,
		) ||
		models.find((model) => urls(model).some(fromRepo));
	return found?.id ?? null;
}

/**
 * What a file in a repository is, at a revision ("main" for the latest),
 * read from its first bytes: a checkpoint or a LoRA Hatchlight can add, or
 * why it is not one.
 */
export async function inspectHubFile(
	target: HubTarget,
	revision: string,
	fetcher: Fetch,
	signal?: AbortSignal,
): Promise<HubFile | Extract<HubChoice, { kind: "unsupported" }>> {
	const unsupported = (reason: HubUnsupported) => ({
		kind: "unsupported" as const,
		repo: target.repo,
		file: target.file,
		reason,
	});
	const info = await hubInfo(fetcher, target.repo, revision, signal);
	if (!info) return unsupported("notFound");
	// Its files need a signed-in person who accepted its terms.
	if (info.gated) return unsupported("gated");
	const safetensors = (file: HubSibling) =>
		/\.safetensors$/i.test(file.rfilename);
	let found: HubSibling | undefined;
	if (target.file) {
		found = info.siblings.find((file) => file.rfilename === target.file);
		if (!found) return unsupported("fileNotFound");
		if (!safetensors(found)) return unsupported("notSafetensors");
	} else {
		// Only a file at the top: one in a folder is part of a pipeline.
		const top = info.siblings.filter(
			(file) => safetensors(file) && !file.rfilename.includes("/"),
		);
		if (top.length === 0) return unsupported("noFile");
		if (top.length > 1) return unsupported("manyFiles");
		found = top[0] as HubSibling;
	}
	const size = found.lfs?.size ?? found.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
		return unsupported("unknownFile");
	}
	const header = await remoteHeader(
		fetcher,
		hubFileUrl(target.repo, info.sha, found.rfilename),
		signal,
	);
	if (!header) return unsupported("unknownFile");
	const common = {
		repo: target.repo,
		file: found.rfilename,
		revision: info.sha,
		size,
		sha256:
			typeof found.lfs?.sha256 === "string" &&
			/^[0-9a-f]{64}$/.test(found.lfs.sha256)
				? found.lfs.sha256
				: null,
		license: info.license,
	};
	const checkpoint = checkpointBaseOf(header);
	if (checkpoint) {
		if (size > MAX_CHECKPOINT_BYTES) return unsupported("tooLarge");
		return { kind: "checkpoint", ...common, base: checkpoint };
	}
	const lora = loraBaseOf(header);
	if (lora) {
		if (size > MAX_LORA_BYTES) return unsupported("tooLarge");
		return { kind: "lora", ...common, base: lora };
	}
	return unsupported("unknownFile");
}

/** What Hatchlight does with a repository, and the file it would add. */
export async function resolveHub(
	target: HubTarget,
	catalog: LocalModelSpec[],
	fetcher: Fetch,
	signal?: AbortSignal,
): Promise<HubChoice> {
	const modelId = catalogModelFor(catalog, target);
	if (modelId) return { kind: "catalog", repo: target.repo, modelId };
	return inspectHubFile(target, "main", fetcher, signal);
}
