import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { type DemoInfo, startVisitor, whenVisitorChanged } from "./api";
import { useI18n } from "./i18n";

/** Where to get Hatchlight, and its source. */
const SITE = "https://hatchlight.app";
const SOURCE = "https://github.com/hatchlight/hatchlight";

/** Whether the page is shown inside another site's frame, as on huggingface.co. */
function framed(): boolean {
	try {
		return window.self !== window.top;
	} catch {
		// A frame on another site may not even be asked.
		return true;
	}
}

/**
 * A public demo: starts this tab's visit before anything asks the server
 * for the visitor's things, then shows the app under a notice.
 */
export function DemoGate({
	demo,
	children,
}: {
	demo: DemoInfo | undefined;
	children: ReactNode;
}) {
	const { t, explain } = useI18n();
	const client = useQueryClient();
	const visit = useQuery({
		queryKey: ["visitor"],
		queryFn: () => startVisitor(),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	// A visitor the demo forgot starts again, with nothing of before.
	useEffect(
		() =>
			whenVisitorChanged(() => {
				void client.invalidateQueries({
					predicate: (query) =>
						!["visitor", "server"].includes(String(query.queryKey[0])),
				});
			}),
		[client],
	);
	if (visit.isPending) return null;
	if (visit.isError) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
				<p className="text-sm text-soft">
					{t("demo.startFailed")} {explain(visit.error)}
				</p>
				<Button variant="outline" onClick={() => void visit.refetch()}>
					{t("demo.retry")}
				</Button>
			</div>
		);
	}
	return (
		<div className="flex h-full flex-col">
			{demo && <DemoNotice demo={demo} />}
			<div className="min-h-0 flex-1">{children}</div>
		</div>
	);
}

/**
 * Says, above the app, that this is a public demo: what it keeps and for
 * how long, and where to get Hatchlight for one's own GPU. Inside another
 * site's frame, it offers the demo in a tab of its own, where the browser
 * keeps its cookie.
 */
export function DemoNotice({ demo }: { demo: DemoInfo }) {
	const { t } = useI18n();
	const link = "font-medium text-ink underline underline-offset-2";
	return (
		<p
			role="note"
			className="shrink-0 border-b border-line bg-panel px-4 py-1.5 text-center text-xs leading-relaxed text-soft"
		>
			{t("demo.notice", { count: demo.ttlHours })}{" "}
			<a href={SITE} target="_blank" rel="noreferrer" className={link}>
				{t("demo.install")}
			</a>
			{" · "}
			<a
				href={SOURCE}
				target="_blank"
				rel="noreferrer"
				className="underline underline-offset-2 hover:text-ink"
			>
				{t("demo.source")}
			</a>
			{framed() && (
				<>
					{" · "}
					<a
						href={window.location.origin}
						target="_blank"
						rel="noreferrer"
						className={link}
					>
						{t("demo.newTab")}
					</a>
				</>
			)}
		</p>
	);
}
