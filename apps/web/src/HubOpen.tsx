import {
	type HubFile,
	type HubTarget,
	type HubUnsupported,
	hubRepoUrl,
} from "@hatchlight/core/hugging-face";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "./Accounts";
import { api } from "./api";
import { type I18n, useI18n } from "./i18n";
import { baseText } from "./Loras";
import { forgetHubDownload, useHubEnd, useHubProgress } from "./live";
import { href, redirect } from "./route";
import { Bar } from "./Training";

/** Why a repository cannot be opened yet, in a sentence. */
function reasonText(t: I18n["t"], reason: HubUnsupported): string {
	switch (reason) {
		case "notFound":
			return t("hub.reason.notFound");
		case "gated":
			return t("hub.reason.gated");
		case "noFile":
			return t("hub.reason.noFile");
		case "manyFiles":
			return t("hub.reason.manyFiles");
		case "fileNotFound":
			return t("hub.reason.fileNotFound");
		case "notSafetensors":
			return t("hub.reason.notSafetensors");
		case "unknownFile":
			return t("hub.reason.unknownFile");
		case "tooLarge":
			return t("hub.reason.tooLarge");
	}
}

/** The repository's page, opened in the browser. */
function RepoLink({ repo }: { repo: string }) {
	const { t } = useI18n();
	return (
		<a
			href={hubRepoUrl(repo)}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1.5 text-ink underline underline-offset-4"
		>
			{t("hub.openOnHub")}
			<ExternalLinkIcon aria-hidden="true" className="size-3.5" />
		</a>
	);
}

/** What the file is, for the person to agree to before it is downloaded. */
function FileDetails({ file }: { file: HubFile }) {
	const { t, bytes } = useI18n();
	const rows = [
		[t("hub.repository"), file.repo],
		[t("hub.file"), file.file],
		[
			t("hub.kind"),
			file.kind === "checkpoint"
				? t("hub.checkpoint", { base: baseText(t, file.base) })
				: t("hub.lora", { base: baseText(t, file.base) }),
		],
		[t("hub.size"), bytes(file.size)],
		[t("hub.license"), file.license ?? t("hub.noLicense")],
	];
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<dt className="text-dim">{label}</dt>
					<dd className="min-w-0 break-words font-mono text-xs leading-5">
						{value}
					</dd>
				</div>
			))}
		</dl>
	);
}

/** How far the download is. */
function Downloading({ file }: { file: HubFile }) {
	const { t, bytes } = useI18n();
	const progress = useHubProgress(file.repo, file.file);
	const received = progress?.receivedBytes ?? 0;
	const label = t("hub.downloading", {
		received: bytes(received),
		size: bytes(file.size),
	});
	return (
		<div className="flex flex-col gap-2" role="status">
			<Bar value={Math.round((received / file.size) * 100)} label={label} />
			<p className="font-mono text-xs text-dim">{label}</p>
		</div>
	);
}

/**
 * A repository opened from Hugging Face, from a link or `#/hf/<repo>`: the
 * catalog's install, or a file to add once the person confirms, or why it
 * cannot be opened yet. Nothing is downloaded without the person's yes.
 */
export function HubOpen({ target }: { target: HubTarget | null }) {
	const { t, bytes, explain } = useI18n();
	const can = useCan();
	const choice = useQuery({
		queryKey: ["hub", target?.repo, target?.file],
		queryFn: ({ signal }) => api.openFromHub(target as HubTarget, signal),
		enabled: target != null && can.admin,
		retry: false,
		staleTime: 60_000,
	});
	const found = choice.data;
	const file =
		found?.kind === "checkpoint" || found?.kind === "lora" ? found : null;
	// The download goes on in the background; its end comes as an event.
	const start = useMutation({
		mutationFn: (file: HubFile) => {
			forgetHubDownload(file.repo, file.file);
			return api.startFromHub(file);
		},
	});
	const end = useHubEnd(file?.repo ?? "", file?.file ?? "");
	const started = start.isSuccess;
	const ended = started ? end : undefined;
	const downloading = start.isPending || (started && !ended);

	// A model the catalog has: its card, with the variant that fits.
	useEffect(() => {
		if (found?.kind === "catalog") redirect(href.model(found.modelId));
	}, [found]);

	useEffect(() => {
		if (ended?.type !== "hub.done") return;
		toast.success(t("hub.added", { name: ended.added.item.name }));
		redirect(href.models);
	}, [ended, t]);

	const close = () => {
		if (file && downloading) void api.cancelFromHub(file).catch(() => {});
		redirect(href.models);
	};
	const failure =
		start.error ?? (ended?.type === "hub.failed" ? ended : undefined);

	let body: ReactNode;
	if (!target) {
		body = <p>{t("hub.invalid")}</p>;
	} else if (!can.admin) {
		body = <p>{t("hub.notAllowed")}</p>;
	} else if (choice.error) {
		body = <p className="text-danger">{explain(choice.error)}</p>;
	} else if (!found || found.kind === "catalog") {
		body = (
			<p className="text-dim" role="status">
				{t("hub.looking", { repo: target.repo })}
			</p>
		);
	} else if (found.kind === "unsupported") {
		body = (
			<div className="flex flex-col gap-3">
				<p>{t("hub.unsupported", { repo: found.repo })}</p>
				<p className="text-dim">{reasonText(t, found.reason)}</p>
				<p>
					<RepoLink repo={found.repo} />
				</p>
			</div>
		);
	} else {
		body = (
			<div className="flex flex-col gap-4">
				<FileDetails file={found} />
				<p className="text-xs leading-relaxed text-dim">
					{t("hub.confirmNote")}
				</p>
				<p>
					<RepoLink repo={found.repo} />
				</p>
				{downloading && <Downloading file={found} />}
				{failure && <p className="text-danger">{explain(failure)}</p>}
			</div>
		);
	}

	return (
		<Dialog open onOpenChange={(open) => !open && close()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{file
							? file.kind === "checkpoint"
								? t("hub.addCheckpoint")
								: t("hub.addLora")
							: t("hub.title")}
					</DialogTitle>
					<DialogDescription>{t("hub.from")}</DialogDescription>
				</DialogHeader>
				<div className="text-sm leading-relaxed">{body}</div>
				<DialogFooter>
					<Button variant="outline" onClick={close}>
						{downloading ? t("hub.stop") : t("common.cancel")}
					</Button>
					{file && (
						<Button
							variant="aurora"
							onClick={() => start.mutate(file)}
							disabled={downloading || ended?.type === "hub.done"}
						>
							{t("hub.download", { size: bytes(file.size) })}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
