import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { useI18n } from "./i18n";
import { href, navigate } from "./route";

/** One toast for the notice, so it is not shown twice. */
const TOAST_ID = "keys-lost";

/**
 * Says that saved keys could not be read at start (the secret changed) and
 * must be entered again; shown to whoever relied on them, until dismissed.
 */
export function KeysLostToast() {
	const { t } = useI18n();
	const client = useQueryClient();
	const lost = useQuery({ queryKey: ["keys-lost"], queryFn: api.keysLost });
	const { mutate: dismiss } = useMutation({
		mutationFn: api.dismissKeysLost,
		onSuccess: () => client.invalidateQueries({ queryKey: ["keys-lost"] }),
	});

	useEffect(() => {
		if (!lost.data?.lost) {
			toast.dismiss(TOAST_ID);
			return;
		}
		// Stays until answered: either way, it is not shown again.
		toast.warning(t("keys.lost"), {
			id: TOAST_ID,
			duration: Number.POSITIVE_INFINITY,
			action: {
				label: t("keys.lostOpen"),
				onClick: () => {
					dismiss();
					navigate(href.settings);
				},
			},
			cancel: { label: t("update.later"), onClick: () => dismiss() },
		});
	}, [lost.data?.lost, t, dismiss]);

	return null;
}
