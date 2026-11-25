import type { DemoInfo } from "./api";
import { useI18n } from "./i18n";

/** Where to get Hatchlight, and its source. */
const SITE = "https://hatchlight.app";
const SOURCE = "https://github.com/hatchlight/hatchlight";

/**
 * Says, above the app, that this is a public demo: what it keeps and for
 * how long, and where to get Hatchlight for one's own GPU.
 */
export function DemoNotice({ demo }: { demo: DemoInfo }) {
	const { t } = useI18n();
	return (
		<p
			role="note"
			className="shrink-0 border-b border-line bg-panel px-4 py-1.5 text-center text-xs leading-relaxed text-soft"
		>
			{t("demo.notice", { count: demo.ttlHours })}{" "}
			<a
				href={SITE}
				target="_blank"
				rel="noreferrer"
				className="font-medium text-ink underline underline-offset-2"
			>
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
		</p>
	);
}
