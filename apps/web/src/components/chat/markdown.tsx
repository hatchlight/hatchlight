import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export type MarkdownProps = {
	children: string;
	className?: string;
};

// Raw HTML in a reply is never rendered: react-markdown skips it unless a
// plugin asks for it, and none does. Images are shown as their words only, so
// a reply can never make the app fetch an address by itself. Links leave the
// app in a new tab.
const COMPONENTS: Partial<Components> = {
	img: ({ alt }) => (alt ? <span>{alt}</span> : null),
	a: ({ node: _node, ...props }) => (
		<a
			{...props}
			target="_blank"
			rel="noreferrer noopener"
			className="text-gold underline decoration-gold/40 underline-offset-2 hover:decoration-gold"
		/>
	),
	code: ({ node: _node, className, ...props }) => (
		<code
			{...props}
			className={cn(
				"rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-[0.85em]",
				className,
			)}
		/>
	),
	pre: ({ node: _node, ...props }) => (
		<pre
			{...props}
			className="overflow-x-auto rounded-xl border border-line bg-panel p-4 font-mono text-sm [&_code]:bg-transparent [&_code]:p-0"
		/>
	),
};

function MarkdownComponent({ children, className }: MarkdownProps) {
	return (
		<div
			className={cn(
				"space-y-3 [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-5",
				className,
			)}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkBreaks]}
				components={COMPONENTS}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}

export const Markdown = memo(MarkdownComponent);
