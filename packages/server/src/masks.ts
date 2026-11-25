import { crc32, deflateSync, inflateSync } from "node:zlib";
import { ValidationError } from "@hatchlight/core";

/**
 * The longest side a picture given to the image APIs may have: more than
 * the models make (SDXL and FLUX make 1024 to 2048), and at most 64 MB of
 * pixels once decoded.
 */
export const MAX_SIDE = 4096;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const unreadable = () =>
	new ValidationError("The mask cannot be read as a picture");

/** A picture's pixels, four bytes each: red, green, blue and opacity. */
interface Pixels {
	width: number;
	height: number;
	rgba: Uint8Array;
}

/** Undoes PNG's per-row filters, for rows of `stride` bytes. */
function unfilter(data: Uint8Array, stride: number, height: number) {
	const out = new Uint8Array(stride * height);
	const bpp = 4;
	for (let y = 0; y < height; y++) {
		const type = data[y * (stride + 1)];
		const row = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const at = y * stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= bpp ? (out[at + x - bpp] ?? 0) : 0;
			const up = y > 0 ? (out[at + x - stride] ?? 0) : 0;
			const corner = x >= bpp && y > 0 ? (out[at + x - stride - bpp] ?? 0) : 0;
			const raw = row[x] ?? 0;
			let value: number;
			switch (type) {
				case 0:
					value = raw;
					break;
				case 1:
					value = raw + left;
					break;
				case 2:
					value = raw + up;
					break;
				case 3:
					value = raw + ((left + up) >> 1);
					break;
				case 4: {
					const p = left + up - corner;
					const pa = Math.abs(p - left);
					const pb = Math.abs(p - up);
					const pc = Math.abs(p - corner);
					value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner);
					break;
				}
				default:
					throw unreadable();
			}
			out[at + x] = value & 0xff;
		}
	}
	return out;
}

/**
 * Refuses a picture larger than MAX_SIDE, from its header alone, before
 * anything decodes it. One that cannot be read is left to whoever reads it.
 */
export async function assertPictureSize(data: Uint8Array): Promise<void> {
	const size = await new Bun.Image(data).metadata().catch(() => null);
	if (size && (size.width > MAX_SIDE || size.height > MAX_SIDE)) {
		throw new ValidationError(
			`A picture may be at most ${MAX_SIDE} pixels on a side`,
		);
	}
}

/** Reads any picture Bun can open, through PNG, as 8-bit RGBA pixels. */
async function pixels(data: Uint8Array): Promise<Pixels> {
	await assertPictureSize(data);
	let png: Uint8Array;
	try {
		// Bun writes every PNG as 8-bit RGBA, not interlaced.
		png = await new Bun.Image(data).png().bytes();
	} catch (error) {
		if (error instanceof ValidationError) throw error;
		throw unreadable();
	}
	if (SIGNATURE.some((byte, i) => png[i] !== byte)) throw unreadable();
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let width = 0;
	let height = 0;
	const parts: Uint8Array[] = [];
	for (let at = 8; at + 8 <= png.byteLength; ) {
		const length = view.getUint32(at);
		const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
		const body = png.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = view.getUint32(at + 8);
			height = view.getUint32(at + 12);
			// 8 bits, RGBA, not interlaced: what Bun writes.
			if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
				throw unreadable();
			}
		} else if (type === "IDAT") {
			parts.push(body);
		} else if (type === "IEND") {
			break;
		}
		at += 12 + length;
	}
	if (width === 0 || height === 0) throw unreadable();
	const rgba = unfilter(
		new Uint8Array(inflateSync(Buffer.concat(parts))),
		width * 4,
		height,
	);
	return { width, height, rgba };
}

/** A grey PNG of these pixels, one byte each. */
function greyPng(width: number, height: number, grey: Uint8Array): Uint8Array {
	const text = new TextEncoder();
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.byteLength);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.byteLength);
		out.set(text.encode(type), 4);
		out.set(data, 8);
		view.setUint32(
			8 + data.byteLength,
			crc32(out.subarray(4, 8 + data.length)),
		);
		return out;
	};
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8; // bits per channel
	header[9] = 0; // grey
	const rows = new Uint8Array((width + 1) * height);
	for (let y = 0; y < height; y++) {
		// Filter 0: each row as it is.
		rows.set(grey.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
	}
	return new Uint8Array(
		Buffer.concat([
			Buffer.from(SIGNATURE),
			chunk("IHDR", header),
			chunk("IDAT", deflateSync(rows)),
			chunk("IEND", new Uint8Array()),
		]),
	);
}

/**
 * Hatchlight's mask (white is redrawn, black kept) from one in another
 * app's convention:
 *
 * - `transparent`: OpenAI's, where transparent pixels are the ones to
 *   change. One with no transparency is read as black and white already.
 * - `black`: white is kept and black redrawn, as AUTOMATIC1111 reads a mask
 *   with `inpainting_mask_invert`.
 */
export async function hatchlightMask(
	data: Uint8Array,
	convention: "transparent" | "black",
): Promise<Uint8Array> {
	const { width, height, rgba } = await pixels(data);
	const grey = new Uint8Array(width * height);
	let transparent = false;
	for (let i = 0; i < grey.length; i++) {
		if ((rgba[i * 4 + 3] ?? 255) < 128) transparent = true;
	}
	for (let i = 0; i < grey.length; i++) {
		const r = rgba[i * 4] ?? 0;
		const g = rgba[i * 4 + 1] ?? 0;
		const b = rgba[i * 4 + 2] ?? 0;
		const alpha = rgba[i * 4 + 3] ?? 255;
		const light = (r * 299 + g * 587 + b * 114) / 1000 >= 128;
		grey[i] =
			convention === "transparent"
				? (transparent ? alpha < 128 : light)
					? 255
					: 0
				: light
					? 0
					: 255;
	}
	return greyPng(width, height, grey);
}

/** Pixels of a mask, for tests: whether each is white. */
export async function maskPixels(
	data: Uint8Array,
): Promise<{ width: number; height: number; white: boolean[] }> {
	const { width, height, rgba } = await pixels(data);
	const white: boolean[] = [];
	for (let i = 0; i < width * height; i++)
		white.push((rgba[i * 4] ?? 0) >= 128);
	return { width, height, white };
}
