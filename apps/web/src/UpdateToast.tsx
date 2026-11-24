import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { installUpdate, onUpdateReady, pendingUpdate } from "./desktop";
import { useI18n } from "./i18n";

/** One toast for the update, so a second notice replaces the first. */
const TOAST_ID = "update";

/** Offers a downloaded update in the desktop app. Nothing shows in a browser. */
export function UpdateToast() {
	const { t } = useI18n();
	const [version, setVersion] = useState<string | null>(null);
	// Answered once, the offer is not shown again until the next start, even
	// when the language changes and the words are written anew.
	const answered = useRef(false);
	const { mutate: install } = useMutation({
		mutationFn: installUpdate,
		onError: () =>
			toast.error(t("update.failed"), { id: TOAST_ID, duration: 10_000 }),
	});

	useEffect(() => {
		// Listening first, so an update that lands meanwhile is not missed.
		const stop = onUpdateReady(setVersion);
		pendingUpdate()
			.then((found) => found && setVersion(found))
			.catch(() => {});
		return stop;
	}, []);

	useEffect(() => {
		if (!version || answered.current) return;
		// Stays until answered: Later puts it away until the next start.
		toast(t("update.ready", { version }), {
			id: TOAST_ID,
			description: t("update.body"),
			duration: Number.POSITIVE_INFINITY,
			action: {
				label: t("update.restart"),
				onClick: (event) => {
					// Kept open, saying it is installing, until Hatchlight restarts.
					event.preventDefault();
					answered.current = true;
					toast.loading(t("update.installing"), { id: TOAST_ID });
					install();
				},
			},
			cancel: {
				label: t("update.later"),
				onClick: () => {
					answered.current = true;
				},
			},
			onDismiss: () => {
				answered.current = true;
			},
		});
	}, [version, t, install]);

	return null;
}
