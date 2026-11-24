import {
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "./i18n";

interface Props {
	/** The picture to make room around. */
	src: string;
	/**
	 * Gets the larger picture, its new part filled with the colours nearby,
	 * and the mask a model redraws it by: white where it is new.
	 */
	onDone(picture: Blob, mask: Blob, marks: string): Promise<void>;
	onClose(): void;
}

type Shape = "same" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

const SHAPES: Shape[] = ["same", "1:1", "4:3", "3:4", "16:9", "9:16"];
/** How much room is added all around, as a share of the picture. */
const ROOMS = [0, 0.25, 0.5, 1];
/** The result is never longer than this: models redraw at about 1024. */
const MAX_SIDE = 2048;
/**
 * How far into the picture the mask reaches, as a share of its shorter
 * side, so the new part is drawn into the old one instead of beside it.
 */
const OVERLAP = 0.04;

/** A choice that stays lit while it holds, among the tools. */
const CHOICE =
	"h-10 rounded-xl px-3.5 aria-pressed:border-transparent aria-pressed:bg-ink aria-pressed:text-bg";

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

/** The new canvas and where the picture sits on it, in pixels. */
function layout(
	width: number,
	height: number,
	shape: Shape,
	room: number,
): { width: number; height: number } {
	let w = width * (1 + room);
	let h = height * (1 + room);
	if (shape !== "same") {
		const [a = 1, b = 1] = shape.split(":").map(Number);
		const ratio = a / b;
		// Only ever grows: the picture always fits whole.
		if (w / h < ratio) w = h * ratio;
		else h = w / ratio;
	}
	return { width: Math.round(w), height: Math.round(h) };
}

const canvasBlob = (canvas: HTMLCanvasElement, type: string) =>
	new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.95));

/** Makes room around a picture for a model to fill. */
export function Extend({ src, onDone, onClose }: Props) {
	const { t, explain, number } = useI18n();
	const shapeLabel = useId();
	const roomLabel = useId();
	const frame = useRef<HTMLDivElement>(null);
	const [image, setImage] = useState<HTMLImageElement | null>(null);
	const [shape, setShape] = useState<Shape>("16:9");
	const [room, setRoom] = useState(0);
	/** Where the picture sits in the room left, 0 at one edge, 1 at the other. */
	const [place, setPlace] = useState({ x: 0.5, y: 0.5 });
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const drag = useRef<{
		start: { x: number; y: number };
		place: { x: number; y: number };
	} | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: loaded once per picture
	useEffect(() => {
		const loaded = new Image();
		loaded.onload = () => setImage(loaded);
		loaded.onerror = () => setError(t("extend.cannotLoad"));
		loaded.src = src;
	}, [src]);

	const size = image
		? layout(image.naturalWidth, image.naturalHeight, shape, room)
		: null;
	const scale = size
		? Math.min(1, MAX_SIDE / Math.max(size.width, size.height))
		: 1;
	const result = size && {
		width: Math.round(size.width * scale),
		height: Math.round(size.height * scale),
	};
	const grows = Boolean(
		image &&
			size &&
			(size.width > image.naturalWidth || size.height > image.naturalHeight),
	);

	/** The picture's box on the new canvas, as fractions of it. */
	const box =
		image && size
			? {
					w: image.naturalWidth / size.width,
					h: image.naturalHeight / size.height,
					x: (1 - image.naturalWidth / size.width) * place.x,
					y: (1 - image.naturalHeight / size.height) * place.y,
				}
			: null;

	/**
	 * A tiny copy, stretched over the whole canvas, is a blur every browser
	 * can draw, and gives the new part the picture's light and colours.
	 */
	const tiny = useMemo(() => {
		if (!image) return null;
		const canvas = document.createElement("canvas");
		canvas.width = 12;
		canvas.height = 12;
		canvas.getContext("2d")?.drawImage(image, 0, 0, 12, 12);
		return canvas;
	}, [image]);

	/** Draws the larger picture: the new part blurred from the old one's colours. */
	const draw = (canvas: HTMLCanvasElement, width: number, height: number) => {
		const context = canvas.getContext("2d");
		if (!context || !image || !box || !tiny) return false;
		canvas.width = width;
		canvas.height = height;
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = "high";
		context.drawImage(tiny, 0, 0, width, height);
		context.drawImage(
			image,
			box.x * width,
			box.y * height,
			box.w * width,
			box.h * height,
		);
		return true;
	};

	const preview = useRef<HTMLCanvasElement>(null);
	useLayoutEffect(() => {
		if (!preview.current || !size) return;
		const shown = Math.min(1, 1200 / Math.max(size.width, size.height));
		draw(
			preview.current,
			Math.round(size.width * shown),
			Math.round(size.height * shown),
		);
	});

	const onPointerMove = (event: React.PointerEvent) => {
		const held = drag.current;
		const area = frame.current?.getBoundingClientRect();
		if (!held || !area || !box) return;
		// A pixel dragged moves the picture a pixel, across the room it has.
		const roomX = 1 - box.w;
		const roomY = 1 - box.h;
		const dx = (event.clientX - held.start.x) / area.width;
		const dy = (event.clientY - held.start.y) / area.height;
		setPlace({
			x: roomX > 0 ? clamp(held.place.x + dx / roomX, 0, 1) : 0.5,
			y: roomY > 0 ? clamp(held.place.y + dy / roomY, 0, 1) : 0.5,
		});
	};

	const onKey = (event: React.KeyboardEvent) => {
		const moves: Record<string, [number, number]> = {
			ArrowLeft: [-0.05, 0],
			ArrowRight: [0.05, 0],
			ArrowUp: [0, -0.05],
			ArrowDown: [0, 0.05],
		};
		const move = moves[event.key];
		if (!move) return;
		event.preventDefault();
		const [dx, dy] = move;
		setPlace((at) => ({
			x: clamp(at.x + dx, 0, 1),
			y: clamp(at.y + dy, 0, 1),
		}));
	};

	const done = async () => {
		if (!result || !box || !image) return;
		setSaving(true);
		setError(null);
		try {
			const picture = document.createElement("canvas");
			if (!draw(picture, result.width, result.height)) {
				throw new Error(t("adjust.cannotDraw"));
			}
			const mask = document.createElement("canvas");
			mask.width = result.width;
			mask.height = result.height;
			const context = mask.getContext("2d");
			if (!context) throw new Error(t("adjust.cannotDraw"));
			context.fillStyle = "#fff";
			context.fillRect(0, 0, mask.width, mask.height);
			// Kept: the picture, less a little at each edge that has new room.
			const inset = Math.round(
				OVERLAP * Math.min(box.w * mask.width, box.h * mask.height),
			);
			const left = box.x * mask.width;
			const top = box.y * mask.height;
			const right = left + box.w * mask.width;
			const bottom = top + box.h * mask.height;
			const keep = {
				left: left > 0.5 ? left + inset : 0,
				top: top > 0.5 ? top + inset : 0,
				right: right < mask.width - 0.5 ? right - inset : mask.width,
				bottom: bottom < mask.height - 0.5 ? bottom - inset : mask.height,
			};
			context.fillStyle = "#000";
			context.fillRect(
				keep.left,
				keep.top,
				keep.right - keep.left,
				keep.bottom - keep.top,
			);
			// The marks as the mask painter shows them, to show over the picture.
			const marks = document.createElement("canvas");
			marks.width = mask.width;
			marks.height = mask.height;
			const shown = marks.getContext("2d");
			if (shown) {
				shown.fillStyle = "rgb(255 61 139)";
				shown.fillRect(0, 0, marks.width, marks.height);
				shown.clearRect(
					keep.left,
					keep.top,
					keep.right - keep.left,
					keep.bottom - keep.top,
				);
			}
			const [pictureBlob, maskBlob] = await Promise.all([
				canvasBlob(picture, "image/webp"),
				canvasBlob(mask, "image/png"),
			]);
			if (!pictureBlob || !maskBlob) throw new Error(t("adjust.cannotSave"));
			await onDone(pictureBlob, maskBlob, marks.toDataURL("image/png"));
		} catch (problem) {
			setError(explain(problem));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => !open && !saving && onClose()}
			disablePointerDismissal
		>
			<DialogContent
				showCloseButton={false}
				className="flex max-h-[96dvh] w-full max-w-[calc(100%-2rem)] sm:w-fit flex-col gap-4 overflow-y-auto rounded-2xl bg-panel p-5 ring-line sm:max-w-[calc(100%-2rem)] sm:p-6"
			>
				<div className="flex flex-col gap-1">
					<DialogTitle className="font-display text-2xl font-bold tracking-tight">
						{t("extend.title")}
					</DialogTitle>
					<DialogDescription className="text-dim">
						{t("extend.hint")}
					</DialogDescription>
				</div>
				<div
					ref={frame}
					onPointerMove={onPointerMove}
					onPointerUp={() => {
						drag.current = null;
					}}
					onPointerCancel={() => {
						drag.current = null;
					}}
					className="relative mx-auto w-fit touch-none select-none overflow-hidden rounded-xl"
				>
					<canvas
						ref={preview}
						role="img"
						aria-label={t("extend.preview")}
						className="block max-h-[56vh] max-w-full"
					/>
					{box && (
						<>
							{/* The new part, dimmed so the picture stands out. */}
							<div
								aria-hidden="true"
								className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(45deg,rgb(0_0_0/0.35)_0_8px,rgb(0_0_0/0.15)_8px_16px)]"
								style={{
									clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${box.x * 100}% ${box.y * 100}%, ${(box.x + box.w) * 100}% ${box.y * 100}%, ${(box.x + box.w) * 100}% ${(box.y + box.h) * 100}%, ${box.x * 100}% ${(box.y + box.h) * 100}%, ${box.x * 100}% ${box.y * 100}%)`,
								}}
							/>
							<button
								type="button"
								aria-label={t("extend.place")}
								onKeyDown={onKey}
								onPointerDown={(event) => {
									event.currentTarget.setPointerCapture(event.pointerId);
									drag.current = {
										start: { x: event.clientX, y: event.clientY },
										place,
									};
								}}
								className="absolute cursor-move border border-white/90 focus-visible:outline-2 focus-visible:outline-pink"
								style={{
									left: `${box.x * 100}%`,
									top: `${box.y * 100}%`,
									width: `${box.w * 100}%`,
									height: `${box.h * 100}%`,
								}}
							/>
						</>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<span id={shapeLabel} className="mr-1 text-sm text-dim">
						{t("extend.shape")}
					</span>
					<ToggleGroup
						aria-labelledby={shapeLabel}
						value={[shape]}
						onValueChange={([which]) => {
							const next = SHAPES.find((s) => s === which);
							if (next) setShape(next);
						}}
						className="flex-wrap"
					>
						{SHAPES.map((which) => (
							<ToggleGroupItem
								key={which}
								value={which}
								variant="outline"
								className={CHOICE}
							>
								{which === "same" ? t("extend.same") : which}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<span id={roomLabel} className="mr-1 text-sm text-dim">
						{t("extend.room")}
					</span>
					<ToggleGroup
						aria-labelledby={roomLabel}
						value={[String(room)]}
						onValueChange={([value]) => {
							const next = ROOMS.find((r) => String(r) === value);
							if (next != null) setRoom(next);
						}}
						className="flex-wrap"
					>
						{ROOMS.map((value) => (
							<ToggleGroupItem
								key={value}
								value={String(value)}
								variant="outline"
								className={CHOICE}
							>
								{value === 0
									? t("extend.none")
									: `+${number(value, { style: "percent" })}`}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</div>
				<div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
					<span className="mr-auto flex flex-wrap items-center gap-3">
						{result && (
							<span className="font-mono text-xs text-dim">
								{t("adjust.result", {
									width: number(result.width),
									height: number(result.height),
								})}
							</span>
						)}
						{image && !grows && (
							<span className="text-sm text-dim">{t("extend.noRoom")}</span>
						)}
						<span className="text-sm text-danger" role="alert">
							{error}
						</span>
					</span>
					<Button variant="ghost" onClick={onClose} disabled={saving}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="aurora"
						size="lg"
						onClick={done}
						disabled={!grows || saving}
					>
						{saving ? t("mask.saving") : t("extend.done")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
