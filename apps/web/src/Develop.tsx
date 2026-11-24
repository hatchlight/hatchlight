import { develop, latent, loadImage } from "@hatchlight/motion";
import { useEffect, useRef, useState } from "react";

/** Develop and latent frames redraw at film speed: lively, and cheap. */
export const FRAME_MS = 1000 / 24;
const DEVELOP_MS = 1600;
/** Canvases stay small; they are covered by the real picture once done. */
const CANVAS_MAX = 480;

export const reduceMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function canvasSize(ratio: number): [number, number] {
	return ratio >= 1
		? [CANVAS_MAX, Math.round(CANVAS_MAX / ratio)]
		: [Math.round(CANVAS_MAX * ratio), CANVAS_MAX];
}

/**
 * A picture still being made: soft lights that settle as `fraction` grows,
 * then the model's own preview coming into focus. Nothing is drawn over it;
 * its status goes below.
 */
export function LatentFrame(props: {
	ratio: number;
	fraction: number | undefined;
	/** The picture as the model has it now, when it shows one. */
	preview?: string;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	// Read by the animation loop without restarting it on every progress event.
	const fraction = useRef(props.fraction);
	fraction.current = props.fraction;
	const picture = useRef<HTMLImageElement | null>(null);
	const [width, height] = canvasSize(props.ratio);

	// The real picture replaces the light once the model shows one: drawn
	// through the remaining noise, which clears as the steps go by.
	useEffect(() => {
		if (!props.preview) return;
		let current = true;
		loadImage(props.preview)
			.then((image) => {
				if (!current) return;
				picture.current = image;
				const element = canvas.current;
				if (element && reduceMotion()) develop(element, image, 0.9);
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [props.preview]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: resizing the canvas clears it, so a new size starts the drawing again
	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		if (reduceMotion()) {
			latent(element, 0.3, 0);
			return;
		}
		// Drawn at once, so the frame is never blank while animation frames wait.
		latent(element, fraction.current, performance.now());
		let frame = 0;
		let last = 0;
		const draw = (time: number) => {
			frame = requestAnimationFrame(draw);
			if (time - last < FRAME_MS) return;
			last = time;
			if (picture.current) {
				develop(
					element,
					picture.current,
					0.35 + 0.55 * (fraction.current ?? 0.5),
				);
			} else {
				latent(element, fraction.current, time);
			}
		};
		frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frame);
	}, [width, height]);

	return (
		<div
			className="relative overflow-hidden rounded-2xl bg-panel"
			style={{ aspectRatio: String(props.ratio) }}
		>
			<canvas
				ref={canvas}
				width={width}
				height={height}
				className="absolute inset-0 h-full w-full"
			/>
		</div>
	);
}

/**
 * A finished picture. With `fresh`, it comes out of noise once, as a
 * diffusion model's picture does; otherwise it simply fades in.
 */
export function DevelopedImage(props: {
	src: string;
	alt: string;
	fresh: boolean;
	/**
	 * How developed the picture already looked while forming, 0 to 1, so the
	 * last stretch continues from there instead of starting over from noise.
	 */
	from?: number;
	/** Width over height, to hold the frame's shape before the image loads. */
	ratio: number;
	className?: string;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	// Where the picture was when it finished forming, read once.
	const [from] = useState(() => props.from ?? 0);
	const [developing, setDeveloping] = useState(
		() => props.fresh && !reduceMotion(),
	);

	useEffect(() => {
		if (!developing) return;
		let frame = 0;
		let stopped = false;
		loadImage(props.src)
			.then((image) => {
				const element = canvas.current;
				if (stopped || !element) return;
				[element.width, element.height] = canvasSize(
					image.width / image.height,
				);
				const start = performance.now();
				let last = 0;
				const draw = (time: number) => {
					const t = Math.min(1, (time - start) / DEVELOP_MS);
					if (t < 1) frame = requestAnimationFrame(draw);
					else setDeveloping(false);
					if (t < 1 && time - last < FRAME_MS) return;
					last = time;
					// Fast at first, lingering as the last details come in.
					develop(element, image, from + (1 - from) * (1 - (1 - t) ** 3));
				};
				frame = requestAnimationFrame(draw);
			})
			.catch(() => setDeveloping(false));
		return () => {
			stopped = true;
			cancelAnimationFrame(frame);
		};
	}, [developing, props.src, from]);

	return (
		<span
			className="relative block"
			style={developing ? { aspectRatio: String(props.ratio) } : undefined}
		>
			<img
				src={props.src}
				alt={props.alt}
				loading="lazy"
				className={`${props.className ?? ""} ${
					developing
						? "opacity-0"
						: // A developed print is already on screen; only the others fade in.
							props.fresh
							? ""
							: "print-in"
				}`}
			/>
			{developing && (
				<canvas
					ref={canvas}
					className={`absolute inset-0 h-full w-full ${props.className ?? ""}`}
				/>
			)}
		</span>
	);
}
