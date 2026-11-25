import {
	copyFile,
	link,
	mkdir,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { NotFoundError, ValidationError } from "../errors";
import { pathHere } from "../paths";
import type {
	CheckpointInfo,
	LoraInfo,
	ModelFolder,
	ModelFolderApp,
	ModelFolderSuggestion,
} from "../types";
import { CHECKPOINT_KIND } from "./checkpoints";
import { LORA_KIND } from "./loras";
import {
	type LinkedFiles,
	readSafetensorsHeader,
	type ShelfItem,
	type ShelfKind,
	shelfId,
} from "./shelf";

/**
 * Folders of other apps (ComfyUI, AUTOMATIC1111, Forge, Stability Matrix)
 * whose checkpoints and LoRAs Hatchlight uses where they are: nothing is
 * copied or moved, and nothing there is ever deleted. Each file's header is
 * read once and kept with its size and time, so a look again reads only
 * what changed.
 */

export type LinkedKind = "lora" | "checkpoint";
/** Why a file found is not used. */
type Skip = keyof ModelFolder["skipped"];

/** Subfolders below this are not looked in: a model is never that deep. */
const MAX_DEPTH = 8;
/** Files read in one folder at most; more is not a models folder. */
const MAX_FILES = 20_000;
/** Folders and entries looked at in one folder at most, for the same reason. */
const MAX_DIRS = 5_000;
const MAX_ENTRIES = 100_000;
/** A job's LoRA folder older than this was left by a job that crashed. */
const STALE_MS = 6 * 60 * 60 * 1000;
const JOB_FOLDER = /^loras-[0-9a-f-]{36}$/;

/** Where copies of linked LoRAs no link can reach are kept, in the scratch folder. */
export const linkedLoraCache = (scratch: string) =>
	join(scratch, "linked-loras");
/** A new folder for one job's LoRAs, in the scratch folder. */
export const jobLorasDir = (scratch: string) =>
	join(scratch, `loras-${crypto.randomUUID()}`);

/**
 * Where each app keeps checkpoints and LoRAs, below each folder a person
 * may point at: the app's own, its portable package's, or its models one.
 */
const LAYOUTS: {
	app: ModelFolderApp;
	roots: string[][];
	checkpoint: string[];
	lora: string[];
}[] = [
	{
		app: "comfyui",
		roots: [["models"], ["ComfyUI", "models"], []],
		checkpoint: ["checkpoints"],
		lora: ["loras"],
	},
	{
		app: "a1111",
		// Forge's one-click package keeps the app in `webui`.
		roots: [["models"], ["webui", "models"], []],
		checkpoint: ["Stable-diffusion"],
		lora: ["Lora", "LyCORIS"],
	},
	{
		app: "stabilityMatrix",
		roots: [["Data", "Models"], ["Models"], []],
		checkpoint: ["StableDiffusion"],
		lora: ["Lora", "LyCORIS"],
	},
];

/** The subfolder `names` below `base`, whatever their case. */
async function findDir(base: string, names: string[]): Promise<string | null> {
	let dir = base;
	for (const name of names) {
		const entries = await readdir(dir).catch(() => [] as string[]);
		const match = entries.find((e) => e.toLowerCase() === name.toLowerCase());
		if (!match) return null;
		const info = await stat(join(dir, match)).catch(() => null);
		if (!info?.isDirectory()) return null;
		dir = join(dir, match);
	}
	return dir;
}

export interface Layout {
	/** Null when no app's layout was found: the folder is read whole. */
	app: ModelFolderApp | null;
	/** Where to look, and for what; a null kind is told from each file. */
	dirs: { dir: string; kind: LinkedKind | null }[];
}

/**
 * Which app's layout a folder has, and where its models are. The layout
 * with the most kinds of models found wins. On a tie, Stability Matrix
 * wins when its `Data/Models` is there (A1111's `models` matches that
 * folder too, whatever the case), else the first one.
 */
export async function detectLayout(folder: string): Promise<Layout> {
	let best: Layout | null = null;
	let bestScore = 0;
	for (const layout of LAYOUTS) {
		for (const root of layout.roots) {
			const base = await findDir(folder, root);
			if (!base) continue;
			const dirs: Layout["dirs"] = [];
			for (const kind of ["checkpoint", "lora"] as const) {
				for (const name of layout[kind]) {
					const dir = await findDir(base, [name]);
					if (dir) dirs.push({ dir, kind });
				}
			}
			const kinds = new Set(dirs.map((d) => d.kind)).size;
			const matrix =
				layout.app === "stabilityMatrix" && /[\\/]data[\\/]models$/i.test(base);
			const score = kinds > 0 ? kinds * 2 + (matrix ? 1 : 0) : 0;
			if (score > bestScore) {
				best = { app: layout.app, dirs };
				bestScore = score;
			}
		}
	}
	return best ?? { app: null, dirs: [{ dir: folder, kind: null }] };
}

interface Found {
	size: number;
	mtimeMs: number;
	kind: LinkedKind | null;
}

/** What one look in a folder found, and how much it looked at. */
interface Walk {
	found: Map<string, Found>;
	seen: Set<string>;
	/** Never looked in: Hatchlight's own models folder, as `canonical` names it. */
	skip: string;
	dirs: number;
	entries: number;
	truncated: boolean;
}

/**
 * The safetensors files below `dir`, following links within `bound` (a
 * folder as `canonical` names it) but never into a folder twice, so a link
 * to a parent ends. Past the limits it stops and says so in `truncated`.
 */
async function walk(
	dir: string,
	kind: LinkedKind | null,
	state: Walk,
	bound: string,
	depth = 0,
): Promise<void> {
	if (state.truncated) return;
	const real = await canonical(dir);
	if (!below(real, bound) || below(real, state.skip)) return;
	const info = await stat(dir, { bigint: true }).catch(() => null);
	if (!info?.isDirectory()) return;
	const key = `${info.dev}:${info.ino}`;
	if (state.seen.has(key)) return;
	state.seen.add(key);
	if (++state.dirs > MAX_DIRS) {
		state.truncated = true;
		return;
	}
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (++state.entries > MAX_ENTRIES) {
			state.truncated = true;
			return;
		}
		if (entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (/\.safetensors$/i.test(entry.name)) {
			const file = await stat(path).catch(() => null);
			if (!file?.isFile() || state.found.has(path)) continue;
			if (state.found.size >= MAX_FILES) {
				state.truncated = true;
				return;
			}
			// Whole milliseconds: what every file system and copy keeps.
			state.found.set(path, {
				size: file.size,
				mtimeMs: Math.floor(file.mtimeMs),
				kind,
			});
		} else if (
			(entry.isDirectory() || entry.isSymbolicLink()) &&
			depth < MAX_DEPTH
		) {
			await walk(path, kind, state, bound, depth + 1);
		}
	}
}

const KINDS: Record<
	LinkedKind,
	ShelfKind<LoraInfo> | ShelfKind<CheckpointInfo>
> = { lora: LORA_KIND, checkpoint: CHECKPOINT_KIND };

class Unreadable extends Error {}

/** Notes a person sets, which a file read again keeps. */
const SETTINGS = ["steps", "cfgScale", "clipSkip"];

/** What a file is, read from its header: a kind and its notes, or why not. */
async function classify(
	path: string,
	size: number,
	kind: LinkedKind | null,
): Promise<
	{ kind: LinkedKind; notes: Record<string, unknown> } | { skip: Skip }
> {
	const max = (kind ? KINDS[kind] : CHECKPOINT_KIND).maxBytes;
	if (size > max) return { skip: "tooLarge" };
	let header: Awaited<ReturnType<typeof readSafetensorsHeader>>;
	try {
		header = await readSafetensorsHeader(
			Bun.file(path),
			() => new Unreadable(),
		);
	} catch {
		return { skip: "unreadable" };
	}
	// In a plain folder, a whole model is told by its denoiser.
	const told: LinkedKind =
		kind ??
		(header.keys.some((key) => key.startsWith("model.diffusion_model.")) ||
		size > LORA_KIND.maxBytes
			? "checkpoint"
			: "lora");
	if (size > KINDS[told].maxBytes) return { skip: "tooLarge" };
	try {
		const notes = KINDS[told].inspect(header, basename(path));
		return { kind: told, notes: { ...notes } };
	} catch {
		// A family or a part of a model Hatchlight does not run.
		return { skip: "unknown" };
	}
}

/** A folder as compared with another: Windows and macOS ignore case. */
async function canonical(path: string): Promise<string> {
	const real = await realpath(path).catch(() => resolve(path));
	return ["win32", "darwin"].includes(process.platform) ||
		real.startsWith("/mnt/")
		? real.toLowerCase()
		: real;
}

/** Whether `path` is `outer` or below it, both as `canonical` names them. */
function below(path: string, outer: string): boolean {
	const rel = relative(outer, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether `path` is `outer` or below it. */
async function within(path: string, outer: string): Promise<boolean> {
	return below(await canonical(path), await canonical(outer));
}

/**
 * A drive, or a home folder: read whole, they would take minutes and find
 * anything but one app's models.
 */
function tooBroad(path: string): boolean {
	const plain = path.replace(/[\\/]+$/, "") || path;
	return (
		dirname(plain) === plain ||
		/^\/mnt(\/[a-z])?$/i.test(plain) ||
		/^[a-z]:$/i.test(plain) ||
		/^(\/home|\/Users|\/mnt\/[a-z]\/Users|[a-z]:\\Users)[\\/][^\\/]+$/i.test(
			plain,
		) ||
		resolve(plain) === resolve(homedir())
	);
}

interface FolderRecord {
	id: string;
	path: string;
	addedAt: number;
	app: ModelFolderApp | null;
	available: boolean;
	truncated: boolean;
	scannedAt: number | null;
}

/** A file found in a folder, and what its header said. */
interface FileRecord {
	path: string;
	folder: string;
	size: number;
	mtimeMs: number;
	addedAt: number;
	kind?: LinkedKind;
	/** Kept for the file's path while it is there, so prompts keep working. */
	id?: string;
	notes?: Record<string, unknown>;
	skip?: Skip;
}

export interface LinkedFoldersOptions {
	/** Where the folders and what was read in them are kept; else in memory. */
	file?: string;
	/** Hatchlight's own models folder, which is never linked. */
	root: () => string;
	/** The ids of the shelves' own files, which linked files never take. */
	ownIds: Record<LinkedKind, () => Promise<string[]>>;
	/** Told when the linked files of a kind changed. */
	changed?: (kind: LinkedKind) => void;
	/** Folders where other apps are often installed, for suggestions. */
	places?: () => Promise<string[]>;
}

/** The folders of other apps linked here, and the models found in them. */
export class LinkedFolders {
	private folders: FolderRecord[] = [];
	private files: FileRecord[] = [];
	private ids: Record<LinkedKind, Map<string, FileRecord>> = {
		lora: new Map(),
		checkpoint: new Map(),
	};
	private loaded: Promise<void> | null = null;
	/** Changes happen one at a time. */
	private queue: Promise<unknown> = Promise.resolve();
	private places: Promise<string[]> | null = null;
	readonly loras: LinkedFiles<LoraInfo>;
	readonly checkpoints: LinkedFiles<CheckpointInfo>;

	constructor(private options: LinkedFoldersOptions) {
		this.loras = this.source("lora", LORA_KIND);
		this.checkpoints = this.source("checkpoint", CHECKPOINT_KIND);
	}

	private load(): Promise<void> {
		this.loaded ??= (async () => {
			const file = this.options.file;
			const raw = file
				? await Bun.file(file)
						.json()
						.catch(() => null)
				: null;
			if (raw && typeof raw === "object") {
				const { folders, files } = raw as Record<string, unknown>;
				if (Array.isArray(folders)) {
					this.folders = folders.filter(
						(f): f is FolderRecord =>
							typeof f?.id === "string" && typeof f?.path === "string",
					);
				}
				if (Array.isArray(files)) {
					this.files = files.filter(
						(f): f is FileRecord =>
							typeof f?.path === "string" &&
							typeof f?.folder === "string" &&
							typeof f?.size === "number" &&
							typeof f?.mtimeMs === "number",
					);
				}
			}
			this.index();
		})();
		return this.loaded;
	}

	private index(): void {
		this.ids = { lora: new Map(), checkpoint: new Map() };
		for (const file of this.files) {
			if (file.kind && file.id) this.ids[file.kind].set(file.id, file);
		}
	}

	private serial<R>(task: () => Promise<R>): Promise<R> {
		const run = this.queue.then(async () => {
			await this.load();
			return task();
		});
		this.queue = run.catch(() => {});
		return run;
	}

	/** Written whole, then renamed: a reader never sees half of it. */
	private async save(): Promise<void> {
		const file = this.options.file;
		if (!file) return;
		await mkdir(dirname(file), { recursive: true });
		const temporary = `${file}.${crypto.randomUUID()}.tmp`;
		await Bun.write(
			temporary,
			JSON.stringify({ folders: this.folders, files: this.files }),
		);
		try {
			await rename(temporary, file);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}

	private view(folder: FolderRecord): ModelFolder {
		const counts = { checkpoints: 0, loras: 0 };
		const skipped = { unknown: 0, unreadable: 0, tooLarge: 0 };
		for (const file of this.files) {
			if (file.folder !== folder.id) continue;
			if (file.kind === "lora") counts.loras++;
			else if (file.kind === "checkpoint") counts.checkpoints++;
			else if (file.skip) skipped[file.skip]++;
		}
		return {
			id: folder.id,
			path: folder.path,
			app: folder.app,
			available: folder.available,
			...counts,
			skipped,
			truncated: folder.truncated,
			addedAt: folder.addedAt,
			scannedAt: folder.scannedAt,
		};
	}

	async list(): Promise<ModelFolder[]> {
		await this.load();
		return this.folders.map((folder) => this.view(folder));
	}

	/** Links a folder, after checking it, and reads what is in it. */
	add(path: string): Promise<ModelFolder> {
		return this.serial(async () => {
			const here = pathHere(path.trim());
			if (!here) {
				throw new ValidationError(
					`Not a full path: ${path}`,
					"folderNotAbsolute",
					{ path },
				);
			}
			const info = await stat(here).catch(() => null);
			if (!info?.isDirectory()) {
				throw new ValidationError(
					`There is no folder at ${here}`,
					"modelFolderMissing",
					{ path: here },
				);
			}
			const root = this.options.root();
			if ((await within(here, root)) || (await within(root, here))) {
				throw new ValidationError(
					"Hatchlight's own models folder cannot be linked, nor a folder holding it",
					"modelFolderInside",
					{ path: here },
				);
			}
			const name = await canonical(here);
			for (const folder of this.folders) {
				const other = await canonical(folder.path);
				if (other === name) {
					throw new ValidationError(
						`${here} is linked already`,
						"modelFolderLinked",
						{ path: here },
					);
				}
				// Its files would show twice, under two ids.
				if (below(name, other) || below(other, name)) {
					throw new ValidationError(
						`${here} holds, or is inside, ${folder.path}, which is linked already`,
						"modelFolderOverlaps",
						{ path: here, linked: folder.path },
					);
				}
			}
			if (tooBroad(here) && !(await detectLayout(here)).app) {
				throw new ValidationError(
					`${here} is a whole drive or home folder; choose the app's folder in it`,
					"modelFolderTooBroad",
					{ path: here },
				);
			}
			const folder: FolderRecord = {
				id: crypto.randomUUID().slice(0, 8),
				path: here,
				addedAt: Date.now(),
				app: null,
				available: true,
				truncated: false,
				scannedAt: null,
			};
			await this.changing(async () => {
				this.folders.push(folder);
				await this.scan(folder);
			});
			return this.view(folder);
		});
	}

	/** Forgets a folder, by its id or path; its files stay where they are. */
	remove(idOrPath: string): Promise<void> {
		return this.serial(async () => {
			const here = pathHere(idOrPath.trim());
			let folder = this.folders.find((f) => f.id === idOrPath);
			for (const f of this.folders) {
				if (folder || !here) break;
				if ((await canonical(f.path)) === (await canonical(here))) folder = f;
			}
			if (!folder) {
				throw new NotFoundError(
					`No linked folder ${idOrPath}`,
					"modelFolderNotFound",
					{ id: idOrPath },
				);
			}
			const gone = folder.id;
			await this.changing(async () => {
				this.folders = this.folders.filter((f) => f.id !== gone);
				this.files = this.files.filter((f) => f.folder !== gone);
			});
		});
	}

	/** Looks in every folder again, reading only files that changed. */
	rescan(): Promise<ModelFolder[]> {
		return this.serial(async () => {
			if (this.folders.length === 0) {
				await this.tidy();
				return [];
			}
			await this.changing(async () => {
				for (const folder of this.folders) await this.scan(folder);
			});
			return this.folders.map((folder) => this.view(folder));
		});
	}

	/** Installs of other apps on this computer that are not linked yet. */
	async suggestions(): Promise<ModelFolderSuggestion[]> {
		await this.load();
		this.places ??= (this.options.places?.() ?? Promise.resolve([])).catch(
			() => [],
		);
		const linked = await Promise.all(
			this.folders.map((f) => canonical(f.path)),
		);
		const found: ModelFolderSuggestion[] = [];
		const named = new Set(linked);
		for (const place of await this.places) {
			const name = await canonical(place);
			if (named.has(name)) continue;
			if (!(await stat(place).catch(() => null))?.isDirectory()) continue;
			const { app } = await detectLayout(place);
			if (!app) continue;
			named.add(name);
			found.push({ path: place, app });
		}
		return found;
	}

	/** Runs `change`, saves, and tells which kinds of files changed. */
	private async changing(change: () => Promise<void>): Promise<void> {
		const before = {
			lora: this.signature("lora"),
			checkpoint: this.signature("checkpoint"),
		};
		await change();
		this.index();
		await this.save();
		for (const kind of ["lora", "checkpoint"] as const) {
			if (this.signature(kind) !== before[kind]) this.options.changed?.(kind);
		}
		await this.tidy();
	}

	/**
	 * Deletes copies of LoRAs no linked folder has any more, and the LoRA
	 * folders of jobs that crashed, in the models folder's scratch folder.
	 */
	private async tidy(): Promise<void> {
		const scratch = join(this.options.root(), "tmp");
		const cache = linkedLoraCache(scratch);
		const ids = new Set(
			this.files.filter((f) => f.kind === "lora" && f.id).map((f) => f.id),
		);
		for (const id of await readdir(cache).catch(() => [] as string[])) {
			if (!ids.has(id)) {
				await rm(join(cache, id), { recursive: true, force: true });
			}
		}
		for (const name of await readdir(scratch).catch(() => [] as string[])) {
			if (!JOB_FOLDER.test(name)) continue;
			const info = await stat(join(scratch, name)).catch(() => null);
			if (info && Date.now() - info.mtimeMs > STALE_MS) {
				await rm(join(scratch, name), { recursive: true, force: true });
			}
		}
	}

	/** What the shelves show of a kind, to tell whether it changed. */
	private signature(kind: LinkedKind): string {
		const available = new Set(
			this.folders.filter((f) => f.available).map((f) => f.id),
		);
		return this.files
			.filter((f) => f.kind === kind && available.has(f.folder))
			.map((f) => `${f.id}:${f.size}:${f.mtimeMs}:${JSON.stringify(f.notes)}`)
			.sort()
			.join("\n");
	}

	/**
	 * Reads one folder again. A folder that is not there keeps what was
	 * found in it, hidden, so its ids come back with it.
	 */
	private async scan(folder: FolderRecord): Promise<void> {
		folder.scannedAt = Date.now();
		if (!(await stat(folder.path).catch(() => null))?.isDirectory()) {
			folder.available = false;
			return;
		}
		folder.available = true;
		const layout = await detectLayout(folder.path);
		folder.app = layout.app;
		const state: Walk = {
			found: new Map(),
			seen: new Set(),
			skip: await canonical(this.options.root()),
			dirs: 0,
			entries: 0,
			truncated: false,
		};
		// Each folder of models may itself be a link, to another drive.
		for (const { dir, kind } of layout.dirs) {
			await walk(dir, kind, state, await canonical(dir));
		}
		folder.truncated = state.truncated;
		const found = state.found;
		const old = this.files.filter((f) => f.folder === folder.id);
		const byPath = new Map(old.map((f) => [f.path, f]));
		// Renamed by the other app: the same size and time, at a path now gone.
		const gone = old.filter((f) => f.id && !found.has(f.path));
		const next: FileRecord[] = [];
		const fresh: FileRecord[] = [];
		for (const [path, file] of found) {
			const known = byPath.get(path);
			if (known && known.size === file.size && known.mtimeMs === file.mtimeMs) {
				next.push(known);
				continue;
			}
			const moved = known
				? undefined
				: gone.find(
						(f) =>
							f.size === file.size &&
							f.mtimeMs === file.mtimeMs &&
							(file.kind == null || f.kind === file.kind),
					);
			if (moved) {
				gone.splice(gone.indexOf(moved), 1);
				next.push({ ...moved, path });
				continue;
			}
			const read = await classify(path, file.size, file.kind);
			const record: FileRecord = {
				path,
				folder: folder.id,
				size: file.size,
				mtimeMs: file.mtimeMs,
				addedAt: known?.addedAt ?? Date.now(),
			};
			if ("skip" in read) {
				next.push({ ...record, skip: read.skip });
				continue;
			}
			// Settings changed by hand stay while it is the same family.
			const kept =
				known?.kind === read.kind && known.notes?.base === read.notes.base
					? Object.fromEntries(
							SETTINGS.filter((key) => key in (known.notes ?? {})).map(
								(key) => [key, known.notes?.[key]],
							),
						)
					: {};
			const entry: FileRecord = {
				...record,
				kind: read.kind,
				notes: { ...read.notes, ...kept },
				...(known?.kind === read.kind && known.id && { id: known.id }),
			};
			next.push(entry);
			if (!entry.id) fresh.push(entry);
		}
		this.files = [...this.files.filter((f) => f.folder !== folder.id), ...next];
		// Ids last, so a new file never takes one kept for another.
		for (const kind of ["lora", "checkpoint"] as const) {
			const mine = fresh.filter((f) => f.kind === kind);
			if (mine.length === 0) continue;
			const own = new Set(await this.options.ownIds[kind]());
			const taken = new Set(
				this.files.filter((f) => f.kind === kind && f.id).map((f) => f.id),
			);
			for (const file of mine) {
				const name =
					typeof file.notes?.name === "string" ? file.notes.name : "";
				file.id = shelfId(
					name,
					(id) => own.has(id) || taken.has(id),
					kind === "lora" ? "lora" : "model",
				);
				taken.add(file.id);
			}
		}
	}

	/** The files of one kind, as a shelf shows them beside its own. */
	private source<T extends ShelfItem>(
		kind: LinkedKind,
		shelf: ShelfKind<T>,
	): LinkedFiles<T> {
		const item = (file: FileRecord): T | null => {
			const notes = file.notes && shelf.parse(file.notes);
			const folder = this.folders.find((f) => f.id === file.folder);
			if (!notes || !file.id || !folder?.available) return null;
			return {
				...notes,
				id: file.id,
				size: file.size,
				addedAt: file.addedAt,
				linked: { folder: folder.id, app: folder.app },
			} as T;
		};
		return {
			list: async () => {
				await this.load();
				return [...this.ids[kind].values()]
					.map(item)
					.filter((found): found is T => found != null);
			},
			get: async (id) => {
				await this.load();
				const file = this.ids[kind].get(id);
				const found = file && item(file);
				if (!file || !found) return null;
				// An unplugged drive, or a file the other app deleted.
				const info = await stat(file.path).catch(() => null);
				return info?.isFile() ? found : null;
			},
			path: (id) => this.ids[kind].get(id)?.path ?? null,
			ready: () => this.load(),
			update: (id, notes) =>
				this.serial(async () => {
					const file = this.ids[kind].get(id);
					if (!file) {
						throw new NotFoundError("Not found", shelf.errors.missing, { id });
					}
					file.notes = { ...notes };
					await this.save();
				}),
			// Live, so ids a look is giving out count before it ends.
			taken: (id) => this.files.some((f) => f.kind === kind && f.id === id),
		};
	}
}

/** Where other apps are often installed, below home folders and drives. */
export function installPlaces(
	homes: string[],
	drives: string[],
	join: (...parts: string[]) => string,
): string[] {
	const inHome = [
		["ComfyUI"],
		["Documents", "ComfyUI"],
		["ComfyUI_windows_portable", "ComfyUI"],
		["Desktop", "ComfyUI_windows_portable", "ComfyUI"],
		["Downloads", "ComfyUI_windows_portable", "ComfyUI"],
		["stable-diffusion-webui"],
		["stable-diffusion-webui-forge"],
		["StabilityMatrix", "Data"],
		["AppData", "Roaming", "StabilityMatrix"],
		[".config", "StabilityMatrix"],
	];
	const onDrive = [
		["ComfyUI_windows_portable", "ComfyUI"],
		["ComfyUI"],
		["stable-diffusion-webui"],
		["stable-diffusion-webui-forge"],
		["StabilityMatrix", "Data"],
	];
	return [
		...homes.flatMap((home) => inHome.map((parts) => join(home, ...parts))),
		...drives.flatMap((drive) => onDrive.map((parts) => join(drive, ...parts))),
	];
}

/** How a file is put in a job's LoRA folder; stand-ins in tests. */
export interface FileLinks {
	link(from: string, to: string): Promise<void>;
	symlink(from: string, to: string): Promise<void>;
	copy(from: string, to: string): Promise<void>;
}

const FILE_LINKS: FileLinks = {
	link: (from, to) => link(from, to),
	symlink: (from, to) => symlink(from, to),
	copy: (from, to) => copyFile(from, to),
};

/**
 * A copy of a linked LoRA in `cache/<id>/`, made once and reused while the
 * file stays the same: for a file no link can reach, as on another drive.
 * Older finished copies of the same LoRA go; copies still being written by
 * another job stay, unless they were left long ago.
 */
async function cachedCopy(
	id: string,
	from: string,
	cache: string,
	links: FileLinks,
): Promise<string> {
	const info = await stat(from);
	const dir = join(cache, id);
	const name = `${info.size}-${Math.trunc(info.mtimeMs)}.safetensors`;
	const copy = join(dir, name);
	if ((await stat(copy).catch(() => null))?.size === info.size) return copy;
	await mkdir(dir, { recursive: true });
	for (const old of await readdir(dir).catch(() => [] as string[])) {
		const path = join(dir, old);
		const stale = old.endsWith(".part")
			? Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? 0) >
				STALE_MS
			: old !== name;
		if (stale) await rm(path, { force: true });
	}
	const part = `${copy}.${crypto.randomUUID()}.part`;
	try {
		await links.copy(from, part);
		await rename(part, copy);
	} finally {
		await rm(part, { force: true });
	}
	return copy;
}

/**
 * A folder for one job holding each of its LoRAs as `<id>.safetensors`:
 * the engine takes one folder of LoRAs, and linked ones live in other
 * apps' folders under other names. Each is a hard link to its file, else
 * a symbolic link (not for Windows engines, which cannot follow the ones
 * WSL makes), else a hard link to a copy kept in `cache`.
 */
export async function lorasFolder(
	loras: { id: string; path: string }[],
	options: {
		dir: string;
		cache: string;
		throughWindows: boolean;
		links?: Partial<FileLinks>;
	},
): Promise<{ dir: string; remove(): Promise<void> }> {
	const links = { ...FILE_LINKS, ...options.links };
	const { dir } = options;
	const remove = () => rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	try {
		for (const lora of loras) {
			const to = join(dir, `${lora.id}.safetensors`);
			const placed =
				(await links.link(lora.path, to).then(
					() => true,
					() => false,
				)) ||
				(!options.throughWindows &&
					(await links.symlink(lora.path, to).then(
						() => true,
						() => false,
					)));
			if (placed) continue;
			const copy = await cachedCopy(lora.id, lora.path, options.cache, links);
			await links.link(copy, to).catch(() => links.copy(copy, to));
		}
	} catch (error) {
		await remove();
		throw error;
	}
	return { dir, remove };
}
