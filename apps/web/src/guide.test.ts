import { expect, test } from "bun:test";
import { outlines } from "./guide";

/** A white picture with a black square in the middle, half transparent. */
function square(side: number) {
	const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
	for (let y = 0; y < side; y++) {
		for (let x = 0; x < side; x++) {
			const i = (y * side + x) * 4;
			const inside = x >= 10 && x < 22 && y >= 10 && y < 22;
			if (inside) pixels.fill(0, i, i + 3);
			pixels[i + 3] = 128;
		}
	}
	return pixels;
}

test("outlines are drawn where the picture changes, and nowhere else", () => {
	const side = 32;
	const edges = outlines(square(side), side, side);
	const value = (x: number, y: number) => edges[(y * side + x) * 4] ?? 0;
	// Beside the square's top there is an outline; inside it and far away,
	// none. (Like the engine's, it misses some sides of a sharp square.)
	expect(value(16, 9)).toBe(255);
	expect(value(16, 16)).toBe(0);
	expect(value(1, 1)).toBe(0);
	// Gray, as the engine's map: the same in every channel, its alpha kept.
	const i = (9 * side + 16) * 4;
	expect([edges[i + 1], edges[i + 2]]).toEqual([edges[i], edges[i]]);
	expect(edges[i + 3]).toBe(128);
});

test("a picture of one color has no outlines", () => {
	const flat = new Uint8ClampedArray(16 * 16 * 4).fill(200);
	expect(
		outlines(flat, 16, 16)
			.filter((_, i) => i % 4 !== 3)
			.every((v) => v === 0),
	).toBe(true);
});
