import type * as React from "react";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

export type MessageProps = React.HTMLAttributes<HTMLDivElement>;

/** One entry in the conversation: an avatar or nothing, then its content. */
function Message({ className, ...props }: MessageProps) {
	return <div className={cn("flex gap-3", className)} {...props} />;
}

export type MessageContentProps = {
	children: string;
	className?: string;
};

/** A reply from the assistant, written in markdown. */
function MessageContent({ children, className }: MessageContentProps) {
	return (
		<Markdown
			className={cn(
				"min-w-0 break-words text-[15px] leading-relaxed text-ink/90",
				className,
			)}
		>
			{children}
		</Markdown>
	);
}

export type MessageActionsProps = React.HTMLAttributes<HTMLDivElement>;

function MessageActions({ className, ...props }: MessageActionsProps) {
	return (
		<div
			className={cn("flex items-center gap-2 text-muted-foreground", className)}
			{...props}
		/>
	);
}

export { Message, MessageActions, MessageContent };
