import { useId } from "react";
import { cn } from "@/lib/utils";

/** The egg path and its crack, in the 56-unit box the mark was drawn in. */
export const EGG =
	"M28 10 C 40 10, 44 24, 44 32 C 44 42, 37 47, 28 47 C 19 47, 12 42, 12 32 C 12 24, 16 10, 28 10 Z";
export const CRACK = "M14 30 L 21 25 L 27 31 L 34 24 L 42 30";

type MarkProps = {
	className?: string;
	/** The colour of the crack: the surface the egg sits on. */
	crack?: string;
	/** Read out by screen readers; leave empty when text next to it says the name. */
	label?: string;
};

/** Hatchlight's mark: an egg in the Aurora light, cracking open. */
export function Mark({ className, crack = "var(--bg)", label }: MarkProps) {
	const gradient = useId();
	return (
		<svg
			viewBox="10 8 36 41"
			className={cn("h-7 w-auto shrink-0", className)}
			role={label ? "img" : undefined}
			aria-label={label || undefined}
			aria-hidden={label ? undefined : true}
		>
			{label && <title>{label}</title>}
			<defs>
				<linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="#ff3d8b" />
					<stop offset="0.55" stopColor="#ff8a3d" />
					<stop offset="1" stopColor="#ffc861" />
				</linearGradient>
			</defs>
			<path d={EGG} fill={`url(#${gradient})`} />
			<path
				d={CRACK}
				fill="none"
				stroke={crack}
				strokeWidth="3"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** The mark with the name beside it. */
export function Logo({
	className,
	crack,
}: {
	className?: string;
	crack?: string;
}) {
	return (
		<span className={cn("flex items-center gap-2.5", className)}>
			<Mark crack={crack} />
			<span className="font-display text-[22px] font-extrabold tracking-[-0.02em] text-ink">
				Hatchlight
			</span>
		</span>
	);
}
