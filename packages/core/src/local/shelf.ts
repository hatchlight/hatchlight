import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type ErrorCode, NotFoundError, ValidationError } from "../errors";
import { type LinkedFrom, LORA_ID } from "../types";

/**
 * A folder of files people add themselves (LoRAs, checkpoints), each kept
 * beside a small JSON file of notes about it.
 */

/** A file's id: also its name on disk, and safe inside `<lora:id:1>`. */
export const SHELF_ID = LORA_ID;
/** A safetensors header larger than this is not a model's. */
const MAX_HEADER_BYTES = 100 * 1024 * 1024;
/** An upload that stopped half way: older than this, nobody is writing it. */
const STALE_PART_MS = 60 * 60 * 1000;

export interface SafetensorsHeader {
	/** Tensor names, e.g. "lora_unet_input_blocks_4_1_proj_in.alpha". */
	keys: string[];
	/** What the trainer wrote down, such as `ss_tag_frequency`. */
	metadata: Record<string, string>;
}

/** Reads the names and metadata at the start of a safetensors file. */
export async function readSafetensorsHeader(
	file: Blob,
	unreadable: () => Error,
): Promise<SafetensorsHeader> {
	if (file.size < 8) throw unreadable();
	const head = new DataView(await file.slice(0, 8).arrayBuffer());
	const length = Number(head.getBigUint64(0, true));
	if (length < 2 || length > MAX_HEADER_BYTES || 8 + length > file.size) {
		throw unreadable();
	}
	let header: unknown;
	try {
		header = JSON.parse(await file.slice(8, 8 + length).text());
	} catch {
		throw unreadable();
	}
	if (!header || typeof header !== "object" || Array.isArray(header)) {
		throw unreadable();
	}
	const { __metadata__: raw, ...tensors } = header as Record<string, unknown>;
	const metadata: Record<string, string> = {};
	if (raw && typeof raw === "object") {
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value === "string") metadata[key] = value;
		}
	}
	return { keys: Object.keys(tensors), metadata };
}

/** A name people can read: the author's title, else the file's name. */
export function nameOf(
	metadata: Record<string, string>,
	fileName: string,
	fallback: string,
): string {
	const named =
		metadata["modelspec.title"]?.trim() || metadata.ss_output_name?.trim();
	const fromFile = fileName.replace(/\.safetensors$/i, "").trim();
	return (named || fromFile || fallback).slice(0, 80);
}

/** An id made from a name, never one already taken. */
export function shelfId(
	name: string,
	taken: (id: string) => boolean,
	fallback: string,
): string {
	const base =
		name
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			// One dash at most at each end, after the line above.
			.replace(/^-|-$/g, "")
			.slice(0, 56) || fallback;
	if (!taken(base)) return base;
	for (let n = 2; ; n++) {
		const id = `${base}-${n}`;
		if (!taken(id)) return id;
	}
}

/** What every kept file says about itself. */
export interface ShelfItem {
	id: string;
	name: string;
	size: number;
	addedAt: number;
	/** Set when the file is in another app's folder. */
	linked?: LinkedFrom;
}

/** Notes as written to disk: the item without what the file itself says. */
export type Notes<T extends ShelfItem> = Omit<
	T,
	"id" | "size" | "addedAt" | "linked"
>;

/** What one kind of file is, and how it is checked. */
export interface ShelfKind<T extends ShelfItem> {
	/** The folder in the models folder, e.g. "loras". */
	folder: string;
	maxBytes: number;
	errors: {
		missing: ErrorCode;
		tooLarge: ErrorCode;
		unreadable: ErrorCode;
		/** Settings changed to something that is not valid. */
		invalid: ErrorCode;
	};
	/** Reads a new file's header into its notes; throws when it is not one. */
	inspect(header: SafetensorsHeader, fileName: string): Notes<T>;
	/** Notes read back from disk, or null when they are not valid. */
	parse(notes: Record<string, unknown>): Notes<T> | null;
}

/**
 * Files of one kind found in other apps' folders (see linked.ts), shown
 * beside the shelf's own and used where they are. Their ids never clash
 * with the shelf's.
 */
export interface LinkedFiles<T extends ShelfItem> {
	list(): Promise<T[]>;
	/** The file's notes, when it is still there. */
	get(id: string): Promise<T | null>;
	/** Where the file is, once the list was read. */
	path(id: string): string | null;
	/** Resolves once what is known of the files was read. */
	ready(): Promise<void>;
	/** Keeps changed notes, already checked by the kind. */
	update(id: string, notes: Notes<T>): Promise<void>;
	/** Whether a linked file has this id, so a new file takes another. */
	taken(id: string): boolean;
}

export interface ShelfOptions<T extends ShelfItem = ShelfItem> {
	/** The models folder, which can change while the app runs. */
	root: () => string;
	/** Throws when the folder cannot be written now, e.g. while it moves. */
	check?: () => void;
	/** Told after a file is added, changed or deleted. */
	changed?: () => void;
	/** Lets go of files held open (a loaded model) before one is deleted. */
	release?: () => Promise<void>;
	/** Files of this kind in other apps' folders. */
	linked?: LinkedFiles<T>;
}

/** The files of one kind kept in the models folder, each with its notes. */
export class Shelf<T extends ShelfItem> {
	/** Uploads being written, which a move of the folder must wait for. */
	private uploads = 0;
	/** Ids are chosen and notes written one at a time. */
	private naming: Promise<unknown> = Promise.resolve();

	constructor(
		private kind: ShelfKind<T>,
		private options: ShelfOptions<T>,
	) {}

	/** An upload is being written into the folder. */
	get busy(): boolean {
		return this.uploads > 0;
	}

	private get dir(): string {
		return join(this.options.root(), this.kind.folder);
	}

	private missing(id: string): NotFoundError {
		return new NotFoundError("Not found", this.kind.errors.missing, { id });
	}

	unreadable(): ValidationError {
		return new ValidationError(
			"This file cannot be read as a safetensors model",
			this.kind.errors.unreadable,
		);
	}

	/** The file the engine reads: the shelf's own, else a linked one. */
	path(id: string): string {
		if (!SHELF_ID.test(id)) throw this.missing(id);
		const own = this.ownPath(id);
		const linked = this.options.linked?.path(id);
		return linked && !existsSync(own) ? linked : own;
	}

	private ownPath(id: string): string {
		return join(this.dir, `${id}.safetensors`);
	}

	/** The ids of the shelf's own files, for linked files to avoid. */
	async ownIds(): Promise<string[]> {
		const names = await readdir(this.dir).catch(() => [] as string[]);
		return [
			...new Set(
				names.map((name) => name.replace(/\.(safetensors|json)$/, "")),
			),
		];
	}

	private notes(id: string): string {
		return join(this.dir, `${id}.json`);
	}

	/** Writes notes whole: a reader never sees half of them. */
	private async writeNotes(file: string, notes: object): Promise<void> {
		const temporary = `${file}.${crypto.randomUUID()}.tmp`;
		await Bun.write(temporary, JSON.stringify(notes, null, "\t"));
		try {
			await rename(temporary, file);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}

	/** Removes what uploads that stopped half way left behind. */
	async sweep(): Promise<void> {
		for (const name of await readdir(this.dir).catch(() => [] as string[])) {
			if (!name.endsWith(".part")) continue;
			const file = join(this.dir, name);
			const info = await stat(file).catch(() => null);
			if (info && Date.now() - info.mtimeMs > STALE_PART_MS) {
				await rm(file, { force: true });
			}
		}
	}

	async list(): Promise<T[]> {
		const names = await readdir(this.dir).catch(() => [] as string[]);
		const items: T[] = [];
		for (const name of names) {
			const id = name.replace(/\.json$/, "");
			if (id === name || !SHELF_ID.test(id)) continue;
			const item = await this.read(id);
			if (item) items.push(item);
		}
		const own = new Set(items.map((item) => item.id));
		for (const item of (await this.options.linked?.list()) ?? []) {
			if (!own.has(item.id)) items.push(item);
		}
		return items.sort((a, b) => b.addedAt - a.addedAt);
	}

	/** A file's notes, when the file is there too. */
	async get(id: string): Promise<T> {
		const item = SHELF_ID.test(id)
			? ((await this.read(id)) ?? (await this.options.linked?.get(id)))
			: null;
		if (!item) throw this.missing(id);
		return item;
	}

	private async read(id: string): Promise<T | null> {
		const file = await stat(this.ownPath(id)).catch(() => null);
		if (!file?.isFile()) return null;
		const raw = await Bun.file(this.notes(id))
			.json()
			.catch(() => null);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const notes = this.kind.parse(raw as Record<string, unknown>);
		if (!notes) return null;
		const { addedAt } = raw as { addedAt?: unknown };
		return {
			...notes,
			id,
			size: file.size,
			addedAt: typeof addedAt === "number" ? addedAt : file.mtimeMs,
		} as T;
	}

	/**
	 * Keeps a file read from `body`. It is written beside the others first
	 * and kept only once it reads as this kind of file.
	 */
	async add(
		body: ReadableStream<Uint8Array> | Blob,
		fileName: string,
		/**
		 * A lower limit than the kind's, such as what is left of a quota, and
		 * the error to give past it.
		 */
		limit?: { maxBytes: number; error: () => Error },
	): Promise<T> {
		this.options.check?.();
		// Busy before anything else, so a move cannot start in between.
		this.uploads++;
		await this.sweep().catch(() => {});
		const dir = this.dir;
		await mkdir(dir, { recursive: true }).catch((error) => {
			this.uploads--;
			throw error;
		});
		const part = join(dir, `${crypto.randomUUID()}.part`);
		try {
			// Counted as it comes: a file past the limit stops at the limit,
			// not after it is all on disk.
			const tooLarge = () =>
				new ValidationError(
					"This file is too large",
					this.kind.errors.tooLarge,
				);
			const max = Math.min(this.kind.maxBytes, limit?.maxBytes ?? Infinity);
			let seen = 0;
			let overflow: Error | null = null;
			const counted = (body instanceof Blob ? body.stream() : body).pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform: (chunk, controller) => {
						seen += chunk.byteLength;
						if (seen > max) {
							overflow =
								seen > this.kind.maxBytes || !limit
									? tooLarge()
									: limit.error();
							controller.error(overflow);
							return;
						}
						controller.enqueue(chunk);
					},
				}),
			);
			const written = await Bun.write(part, new Response(counted)).catch(
				(error) => {
					throw overflow ?? error;
				},
			);
			if (written > this.kind.maxBytes) {
				throw new ValidationError(
					"This file is too large",
					this.kind.errors.tooLarge,
				);
			}
			const header = await readSafetensorsHeader(Bun.file(part), () =>
				this.unreadable(),
			);
			const notes = this.kind.inspect(header, fileName);
			// Linked ids are known before one is chosen.
			await this.options.linked?.ready();
			const keep = async (): Promise<T> => {
				const existing = new Set(
					(await readdir(dir).catch(() => [] as string[])).map((n) =>
						n.replace(/\.(safetensors|json)$/, ""),
					),
				);
				const id = shelfId(
					notes.name,
					(candidate) =>
						existing.has(candidate) ||
						this.options.linked?.taken(candidate) === true,
					this.kind.folder.replace(/s$/, ""),
				);
				const addedAt = Date.now();
				const notesFile = join(dir, `${id}.json`);
				await this.writeNotes(notesFile, { ...notes, addedAt });
				try {
					await rename(part, join(dir, `${id}.safetensors`));
				} catch (error) {
					await rm(notesFile, { force: true });
					throw error;
				}
				return { ...notes, id, size: written, addedAt } as T;
			};
			const kept = this.naming.then(keep, keep);
			this.naming = kept.catch(() => {});
			const item = await kept;
			this.options.changed?.();
			return item;
		} finally {
			this.uploads--;
			await rm(part, { force: true });
		}
	}

	/** Changes a file's notes; what `change` returns is checked like notes read back. */
	async update(id: string, change: Partial<Notes<T>>): Promise<T> {
		this.options.check?.();
		const current = await this.get(id);
		const { id: _, size: __, linked: ___, ...kept } = current;
		const next = this.kind.parse({ ...kept, ...change });
		if (!next) {
			throw new ValidationError(
				"These settings are not valid",
				this.kind.errors.invalid,
			);
		}
		// A linked file's notes are kept with what was found in its folder.
		if (!(await this.read(id)) && this.options.linked) {
			await this.options.linked.update(id, next);
			this.options.changed?.();
			return this.get(id);
		}
		await this.writeNotes(this.notes(id), {
			...next,
			addedAt: current.addedAt,
		});
		this.options.changed?.();
		return this.get(id);
	}

	async remove(id: string): Promise<void> {
		this.options.check?.();
		const item = await this.get(id);
		// Another app's file is never deleted from here.
		if (item.linked) {
			throw new ValidationError(
				"This file is in another app's folder; remove that folder from Hatchlight instead",
				"modelLinked",
				{ id },
			);
		}
		// Windows deletes no open file: what holds it lets go first.
		await this.options.release?.();
		// The file goes first: notes without a file are not listed.
		await rm(this.path(id), { force: true });
		await rm(this.notes(id), { force: true });
		this.options.changed?.();
	}
}
