/**
 * The outlines of a picture, found the way the engine finds them for a
 * guide (stable-diffusion.cpp's `canny=true`, with its thresholds): a
 * preview only, since the engine makes the map it follows itself.
 *
 * `pixels` are RGBA, as a canvas gives them; the result is the same size,
 * white outlines on black, with the picture's own transparency.
 */
export function outlines(
	pixels: Uint8ClampedArray,
	width: number,
	height: number,
): Uint8ClampedArray {
	const size = width * height;
	const at = (x: number, y: number) => y * width + x;
	const gray = new Float32Array(size);
	for (let i = 0; i < size; i++) {
		gray[i] =
			(0.2989 * (pixels[i * 4] ?? 0) +
				0.587 * (pixels[i * 4 + 1] ?? 0) +
				0.114 * (pixels[i * 4 + 2] ?? 0)) /
			255;
	}
	/** Each pixel weighed with its neighbors; those outside count as nothing. */
	const convolve = (input: Float32Array, kernel: number[], side: number) => {
		const pad = Math.floor(side / 2);
		const output = new Float32Array(size);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				let sum = 0;
				for (let ky = 0; ky < side; ky++) {
					const iy = y + ky - pad;
					if (iy < 0 || iy >= height) continue;
					for (let kx = 0; kx < side; kx++) {
						const ix = x + kx - pad;
						if (ix < 0 || ix >= width) continue;
						sum += (input[at(ix, iy)] ?? 0) * (kernel[ky * side + kx] ?? 0);
					}
				}
				output[at(x, y)] = sum;
			}
		}
		return output;
	};
	const sigma = 1.4;
	const gauss: number[] = [];
	for (let y = -2; y <= 2; y++) {
		for (let x = -2; x <= 2; x++) {
			gauss.push(
				Math.exp(-(x * x + y * y) / (2 * sigma ** 2)) /
					(2 * Math.PI * sigma ** 2),
			);
		}
	}
	const smooth = convolve(gray, gauss, 5);
	const gx = convolve(smooth, [-1, 0, 1, -2, 0, 2, -1, 0, 1], 3);
	const gy = convolve(smooth, [1, 2, 1, 0, 0, 0, -1, -2, -1], 3);
	const strength = new Float32Array(size);
	let strongest = 0;
	for (let i = 0; i < size; i++) {
		strength[i] = Math.hypot(gx[i] ?? 0, gy[i] ?? 0);
		strongest = Math.max(strongest, strength[i] ?? 0);
	}
	if (strongest > 0) {
		for (let i = 0; i < size; i++) strength[i] = (strength[i] ?? 0) / strongest;
	}

	// Thinned to the strongest pixel across each edge. The angle tests are
	// the engine's as written, inverted comparisons and all (sic), so the
	// preview matches what it makes: https://github.com/leejet/stable-diffusion.cpp/blob/532d2c15/src/runtime/preprocessing.hpp#L231-L243
	const thin = new Float32Array(size);
	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			let angle =
				(Math.atan2(gy[at(x, y)] ?? 0, gx[at(x, y)] ?? 0) * 180) / Math.PI;
			if (angle < 0) angle += 180;
			let q = 1;
			let r = 1;
			if ((angle <= 0 && angle < 22.5) || (angle <= 157.5 && angle <= 180)) {
				q = strength[at(x, y + 1)] ?? 0;
				r = strength[at(x, y - 1)] ?? 0;
			} else if (angle <= 22.5 && angle < 67.5) {
				q = strength[at(x + 1, y - 1)] ?? 0;
				r = strength[at(x - 1, y + 1)] ?? 0;
			} else if (angle <= 67.5 && angle < 112.5) {
				q = strength[at(x + 1, y)] ?? 0;
				r = strength[at(x - 1, y)] ?? 0;
			} else if (angle <= 112.5 && angle < 157.5) {
				q = strength[at(x - 1, y - 1)] ?? 0;
				r = strength[at(x + 1, y + 1)] ?? 0;
			}
			const here = strength[at(x, y)] ?? 0;
			thin[at(x, y)] = here >= q && here >= r ? here : 0;
		}
	}

	// Strong edges kept, weak ones only beside a strong one.
	const WEAK = 0.8;
	const STRONG = 1;
	let max = 0;
	for (const value of thin) max = Math.max(max, value);
	const high = max * 0.08;
	const low = high * 0.08;
	for (let i = 0; i < size; i++) {
		const value = thin[i] ?? 0;
		if (value >= high) thin[i] = STRONG;
		else if (value >= low) thin[i] = WEAK;
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (!(x >= 3 && x <= width - 3 && y >= 3 && y <= height - 3)) {
				thin[at(x, y)] = 0;
			}
		}
	}
	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			if (thin[at(x, y)] !== WEAK) continue;
			const strong = [
				at(x + 1, y - 1),
				at(x + 1, y),
				at(x, y - 1),
				at(x, y + 1),
				at(x - 1, y - 1),
				at(x - 1, y),
			].some((i) => thin[i] === STRONG);
			thin[at(x, y)] = strong ? STRONG : 0;
		}
	}

	const result = new Uint8ClampedArray(pixels.length);
	for (let i = 0; i < size; i++) {
		const value = Math.round((thin[i] ?? 0) * 255);
		result[i * 4] = value;
		result[i * 4 + 1] = value;
		result[i * 4 + 2] = value;
		result[i * 4 + 3] = pixels[i * 4 + 3] ?? 255;
	}
	return result;
}
