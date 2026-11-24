import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const BLOCK = 512;

/** Reads a stream in pieces of exactly the length asked for. */
class Reader {
	private chunks: AsyncIterator<Buffer>;
	private rest: Buffer = Buffer.alloc(0);

	constructor(source: AsyncIterable<Buffer>) {
		this.chunks = source[Symbol.asyncIterator]();
	}

	/** Up to `max` bytes, or null once the stream ends. */
	private async next(max: number): Promise<Buffer | null> {
		while (this.rest.length === 0) {
			const { value, done } = await this.chunks.next();
			if (done) return null;
			this.rest = value;
		}
		const chunk = this.rest.subarray(0, max);
		this.rest = this.rest.subarray(chunk.length);
		return chunk;
	}

	/** The next `length` bytes, as they arrive. */
	async *take(length: number): AsyncGenerator<Buffer> {
		for (let left = length; left > 0; ) {
			const chunk = await this.next(left);
			if (!chunk) throw new Error("The archive is truncated");
			left -= chunk.length;
			yield chunk;
		}
	}

	async read(length: number): Promise<Buffer> {
		const parts: Buffer[] = [];
		for await (const chunk of this.take(length)) parts.push(chunk);
		return Buffer.concat(parts, length);
	}

	/** The next block, or null where the stream ends between blocks. */
	async block(): Promise<Buffer | null> {
		const first = await this.next(BLOCK);
		if (!first) return null;
		if (first.length === BLOCK) return first;
		return Buffer.concat([first, await this.read(BLOCK - first.length)]);
	}

	async skip(length: number): Promise<void> {
		for await (const _ of this.take(length));
	}

	async drain(): Promise<void> {
		this.rest = Buffer.alloc(0);
		while (!(await this.chunks.next()).done);
	}
}

/** Text in a header field, up to its first NUL. */
function text(header: Buffer, start: number, length: number): string {
	const field = header.subarray(start, start + length);
	const end = field.indexOf(0);
	return field.toString("utf8", 0, end === -1 ? length : end);
}

/** A number in a header field: octal, or base-256 for large values. */
function number(header: Buffer, start: number, length: number): number {
	const field = header.subarray(start, start + length);
	const first = field[0] ?? 0;
	if (first & 0x80) {
		let value = first & 0x7f;
		for (const byte of field.subarray(1)) value = value * 256 + byte;
		return value;
	}
	const digits = text(header, start, length).trim();
	if (digits === "") return 0;
	if (!/^[0-7]+$/.test(digits)) throw new Error("The archive is damaged");
	return Number.parseInt(digits, 8);
}

/** Whether the header's checksum is right; it counts its own field as spaces. */
function checksumMatches(header: Buffer): boolean {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) {
		sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
	}
	return sum === number(header, 148, 8);
}

/** The records of a pax extended header: `<length> <key>=<value>\n`. */
function paxRecords(data: Buffer): Map<string, string> {
	const records = new Map<string, string>();
	let at = 0;
	while (at < data.length) {
		const space = data.indexOf(0x20, at);
		const length = Number(data.toString("utf8", at, space));
		if (space === -1 || !Number.isInteger(length) || length <= 0) break;
		const record = data.toString("utf8", space + 1, at + length - 1);
		const equals = record.indexOf("=");
		if (equals > 0) {
			records.set(record.slice(0, equals), record.slice(equals + 1));
		}
		at += length;
	}
	return records;
}

/** Where an entry goes under `dir`, refusing names that would leave it. */
function target(dir: string, name: string): string {
	const parts = name.split("/");
	if (name.startsWith("/") || parts.some((part) => part === "..")) {
		throw new Error(`The archive holds an unsafe path: ${name}`);
	}
	const path = join(
		dir,
		...parts.filter((part) => part !== "" && part !== "."),
	);
	if (path !== dir && !path.startsWith(dir + sep)) {
		throw new Error(`The archive holds an unsafe path: ${name}`);
	}
	return path;
}

/**
 * Extracts a gzip-compressed tar archive into `dir`, streaming each file.
 * Files keep their permission bits (without setuid and the like), so the
 * programs in it can run. Links may only name a file next to them, as
 * `libggml.so -> libggml.so.0` does: nothing can point outside `dir`.
 */
export async function extractTarGz(
	archive: string,
	dir: string,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	await pipeline(
		createReadStream(archive),
		createGunzip(),
		async (source: AsyncIterable<Buffer>) => {
			const reader = new Reader(source);
			await extractEntries(reader, dir);
			// Tools pad the archive past its end: read it to the last byte.
			await reader.drain();
		},
	);
}

async function extractEntries(reader: Reader, dir: string): Promise<void> {
	/** What a pax or GNU header said about the entry after it. */
	let next: { path?: string; linkpath?: string; size?: number } = {};
	for (;;) {
		const header = await reader.block();
		// The end is marked by empty blocks; some tools leave them out.
		if (!header || header.every((byte) => byte === 0)) break;
		if (!checksumMatches(header)) throw new Error("The archive is damaged");

		const type = String.fromCharCode(header[156] ?? 0);
		const size = next.size ?? number(header, 124, 12);
		const padding = (BLOCK - (size % BLOCK)) % BLOCK;

		// Headers that describe the next entry, or the whole archive.
		if (type === "x" || type === "g" || type === "L" || type === "K") {
			const data = await reader.read(size);
			await reader.skip(padding);
			if (type === "x") {
				const records = paxRecords(data);
				const path = records.get("path");
				const linkpath = records.get("linkpath");
				const paxSize = records.get("size");
				next = {
					...next,
					...(path != null && { path }),
					...(linkpath != null && { linkpath }),
					...(paxSize != null && { size: Number(paxSize) }),
				};
			} else if (type === "L") {
				next = { ...next, path: text(data, 0, data.length) };
			} else if (type === "K") {
				next = { ...next, linkpath: text(data, 0, data.length) };
			}
			continue;
		}

		const prefix =
			text(header, 257, 5) === "ustar" ? text(header, 345, 155) : "";
		const name =
			next.path ??
			(prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
		const linkname = next.linkpath ?? text(header, 157, 100);
		next = {};
		const path = target(dir, name);
		if (path === dir && type !== "5") {
			throw new Error(`The archive holds an unsafe path: ${name}`);
		}

		if (type === "5") {
			await mkdir(path, { recursive: true });
			await reader.skip(size + padding);
		} else if (type === "0" || type === "\0" || type === "7") {
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.${crypto.randomUUID()}.tmp`;
			try {
				await pipeline(
					Readable.from(reader.take(size)),
					createWriteStream(tmp),
				);
			} catch (error) {
				await rm(tmp, { force: true });
				throw error;
			}
			await reader.skip(padding);
			await chmod(tmp, number(header, 100, 8) & 0o755);
			await rename(tmp, path);
		} else if (type === "2") {
			if (
				!linkname ||
				linkname.includes("/") ||
				linkname === "." ||
				linkname === ".."
			) {
				throw new Error(`The archive holds an unsafe link: ${name}`);
			}
			await mkdir(dirname(path), { recursive: true });
			await rm(path, { force: true });
			await symlink(linkname, path);
			await reader.skip(size + padding);
		} else {
			throw new Error(`${name} is a kind of file that is not supported`);
		}
	}
}
