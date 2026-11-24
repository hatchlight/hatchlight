import { crc32, deflateRawSync, deflateSync, gzipSync } from "node:zlib";

export interface ZipItem {
	name: string;
	data?: Uint8Array;
	/** 0 stores the bytes, 8 deflates them. */
	method?: number;
	/** Overrides what the archive claims, to make a damaged one. */
	crc?: number;
}

/** Writes a zip archive the way common tools do. */
export function zip(
	items: ZipItem[],
	options: { zip64?: boolean } = {},
): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const item of items) {
		const data = Buffer.from(item.data ?? new Uint8Array());
		const method = item.method ?? 8;
		const body = method === 8 ? deflateRawSync(data) : data;
		const name = Buffer.from(item.name);
		const crc = item.crc ?? crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, body);

		const extra = options.zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
		if (options.zip64) {
			extra.writeUInt16LE(0x0001, 0);
			extra.writeUInt16LE(24, 2);
			extra.writeBigUInt64LE(BigInt(data.length), 4);
			extra.writeBigUInt64LE(BigInt(body.length), 12);
			extra.writeBigUInt64LE(BigInt(offset), 20);
		}
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(options.zip64 ? 0xffffffff : body.length, 20);
		central.writeUInt32LE(options.zip64 ? 0xffffffff : data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(extra.length, 30);
		central.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 42);
		centrals.push(central, name, extra);
		offset += local.length + name.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(items.length, 8);
	end.writeUInt16LE(items.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

export interface TarItem {
	name: string;
	data?: Uint8Array;
	/** "0" a file (the default), "5" a folder, "2" a link, or any other. */
	type?: string;
	linkname?: string;
	mode?: number;
	/** Gives the name in a pax header, as tools do for long names. */
	pax?: boolean;
	/** Overrides the header checksum, to make a damaged archive. */
	checksum?: number;
}

function tarHeader(item: TarItem, name: string, size: number): Buffer {
	const header = Buffer.alloc(512);
	const field = (value: string, start: number, length: number) => {
		header.write(value.slice(0, length), start, length, "utf8");
	};
	const octal = (value: number, start: number, length: number) =>
		field(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length);
	field(name, 0, 100);
	octal(item.mode ?? (item.type === "5" ? 0o755 : 0o644), 100, 8);
	octal(0, 108, 8);
	octal(0, 116, 8);
	octal(size, 124, 12);
	octal(0, 136, 12);
	field(item.type ?? "0", 156, 1);
	field(item.linkname ?? "", 157, 100);
	field("ustar\0", 257, 6);
	field("00", 263, 2);
	header.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of header) sum += byte;
	octal(item.checksum ?? sum, 148, 7);
	return header;
}

const pad = (length: number) => Buffer.alloc((512 - (length % 512)) % 512);

/** Writes a gzip-compressed tar archive the way GNU tar does. */
export function tarGz(items: TarItem[]): Uint8Array {
	const blocks: Buffer[] = [];
	for (const item of items) {
		const data = Buffer.from(item.data ?? new Uint8Array());
		if (item.pax) {
			const body = ` path=${item.name}\n`;
			// The length counts its own digits.
			let length = body.length + 1;
			while (`${length}${body}`.length !== length) length++;
			const record = Buffer.from(`${length}${body}`);
			blocks.push(
				tarHeader({ name: "PaxHeader", type: "x" }, "PaxHeader", record.length),
				record,
				pad(record.length),
			);
		}
		const name = item.pax ? item.name.slice(-100) : item.name;
		blocks.push(tarHeader(item, name, data.length), data, pad(data.length));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

/** A real, flat grey PNG picture of the given size. */
export function picture(
	width: number,
	height: number,
): Uint8Array<ArrayBuffer> {
	const text = new TextEncoder();
	const chunk = (type: string, data: Uint8Array) => {
		const body = new Uint8Array([...text.encode(type), ...data]);
		const out = new DataView(new ArrayBuffer(12 + data.byteLength));
		out.setUint32(0, data.byteLength);
		new Uint8Array(out.buffer).set(body, 4);
		out.setUint32(8 + data.byteLength, crc32(body));
		return new Uint8Array(out.buffer);
	};
	const header = new DataView(new ArrayBuffer(13));
	header.setUint32(0, width);
	header.setUint32(4, height);
	header.setUint8(8, 8); // bits per channel
	header.setUint8(9, 2); // RGB
	const row = 1 + width * 3;
	const rows = new Uint8Array(row * height).fill(128);
	for (let y = 0; y < height; y++) rows[y * row] = 0; // no filter
	return new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...chunk("IHDR", new Uint8Array(header.buffer)),
		...chunk("IDAT", deflateSync(rows)),
		...chunk("IEND", new Uint8Array()),
	]);
}

/** A safetensors file with these tensor names (no real weights) and notes. */
export function safetensors(
	keys: string[],
	metadata: Record<string, string> = {},
): Uint8Array {
	const header: Record<string, unknown> = { __metadata__: metadata };
	let offset = 0;
	for (const key of keys) {
		header[key] = {
			dtype: "F16",
			shape: [1],
			data_offsets: [offset, offset + 2],
		};
		offset += 2;
	}
	const json = new TextEncoder().encode(JSON.stringify(header));
	const file = new Uint8Array(8 + json.length + offset);
	new DataView(file.buffer).setBigUint64(0, BigInt(json.length), true);
	file.set(json, 8);
	return file;
}
