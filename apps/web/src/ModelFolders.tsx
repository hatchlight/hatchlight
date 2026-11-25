import type {
	LinkedFrom,
	ModelFolder,
	ModelFolderApp,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCan } from "./Accounts";
import { api } from "./api";
import { type I18n, useI18n } from "./i18n";
import { ConfirmButton, LABEL, SECTION } from "./Training";

export function appText(t: I18n["t"], app: ModelFolderApp | null): string {
	switch (app) {
		case "comfyui":
			return t("folders.app.comfyui");
		case "a1111":
			return t("folders.app.a1111");
		case "stabilityMatrix":
			return t("folders.app.stabilityMatrix");
		case null:
			return t("folders.app.none");
	}
}

/** Where a linked model comes from, for its row on a shelf. */
export function LinkedLabel({ linked }: { linked: LinkedFrom }) {
	const { t } = useI18n();
	return (
		<span className="rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-dim">
			{linked.app
				? t("folders.from", { app: appText(t, linked.app) })
				: t("folders.fromFolder")}
		</span>
	);
}

/** The short tag of a model from another app, where models are listed. */
export function linkedTag(t: I18n["t"], linked: LinkedFrom): string {
	return linked.app ? appText(t, linked.app) : t("folders.tag");
}

/** Refreshes what a change of linked folders shows elsewhere too. */
function useRefresh() {
	const client = useQueryClient();
	return () => {
		for (const key of ["model-folders", "loras", "checkpoints", "models"]) {
			void client.invalidateQueries({ queryKey: [key] });
		}
	};
}

/** What one linked folder holds, and a way to stop using it. */
function FolderRow({ folder }: { folder: ModelFolder }) {
	const { t, explain, language } = useI18n();
	const can = useCan();
	const refresh = useRefresh();
	const remove = useMutation({
		mutationFn: () => api.removeModelFolder(folder.id),
		onSuccess: refresh,
	});
	const { unknown, unreadable, tooLarge } = folder.skipped;
	const reasons = [
		unknown > 0 && t("folders.skipped.unknown", { count: unknown }),
		unreadable > 0 && t("folders.skipped.unreadable", { count: unreadable }),
		tooLarge > 0 && t("folders.skipped.tooLarge", { count: tooLarge }),
	].filter((reason): reason is string => typeof reason === "string");
	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-bg/60 px-4 py-3">
			<div className="min-w-0 flex-1 basis-60">
				{/* Only those who change the folders see where they are. */}
				<p className="truncate font-mono text-sm" title={folder.path}>
					{folder.path ?? appText(t, folder.app)}
				</p>
				<p className="mt-0.5 text-sm text-dim">
					{folder.available
						? t("folders.holds", {
								app: appText(t, folder.app),
								checkpoints: t("folders.checkpoints", {
									count: folder.checkpoints,
								}),
								loras: t("folders.loras", { count: folder.loras }),
							})
						: t("folders.unavailable")}
				</p>
				{folder.available && reasons.length > 0 && (
					<p className="mt-1 text-xs text-dim">
						{t("folders.skipped", {
							reasons: new Intl.ListFormat(language).format(reasons),
						})}
					</p>
				)}
				{folder.truncated && (
					<p className="mt-1 text-xs text-dim">{t("folders.truncated")}</p>
				)}
				{remove.error && (
					<p className="mt-1 text-sm text-danger">{explain(remove.error)}</p>
				)}
			</div>
			{can.admin && (
				<ConfirmButton
					label={t("folders.remove")}
					ariaLabel={t("folders.removeNamed", { path: folder.path ?? "" })}
					question={t("folders.removeAsk", { path: folder.path ?? "" })}
					confirm={t("folders.removeConfirm")}
					disabled={remove.isPending}
					onConfirm={() => remove.mutate()}
				/>
			)}
		</li>
	);
}

/**
 * Folders of other apps (ComfyUI, AUTOMATIC1111, Forge, Stability Matrix)
 * whose models are used where they are, and installs found to add.
 */
export function ModelFolders() {
	const { t, explain } = useI18n();
	const can = useCan();
	const id = useId();
	const refresh = useRefresh();
	const folders = useQuery({
		queryKey: ["model-folders"],
		queryFn: api.modelFolders,
	});
	// Only admins may add folders, and see where apps are on the machine.
	const suggestions = useQuery({
		queryKey: ["model-folders", "suggestions"],
		queryFn: api.modelFolderSuggestions,
		enabled: can.admin,
	});
	const [adding, setAdding] = useState(false);
	const [path, setPath] = useState("");
	const add = useMutation({
		mutationFn: (folder: string) => api.addModelFolder(folder),
		onSuccess: () => {
			setAdding(false);
			setPath("");
			refresh();
		},
	});
	const rescan = useMutation({
		mutationFn: api.rescanModelFolders,
		onSuccess: refresh,
	});
	const linked = folders.data ?? [];
	return (
		<Card className={SECTION}>
			<CardHeader className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex max-w-2xl flex-col gap-2">
					<h2 className={LABEL}>{t("folders.title")}</h2>
					<p className="text-sm leading-relaxed text-dim">
						{t("folders.intro")}
					</p>
				</div>
				{can.admin && (
					<div className="flex flex-wrap gap-2">
						{linked.length > 0 && (
							<Button
								variant="outline"
								onClick={() => rescan.mutate()}
								disabled={rescan.isPending}
							>
								{t("folders.rescan")}
							</Button>
						)}
						{!adding && (
							<Button variant="secondary" onClick={() => setAdding(true)}>
								{t("folders.add")}
							</Button>
						)}
					</div>
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-3 empty:hidden">
				{can.admin &&
					suggestions.data?.map((found) => (
						<div
							key={found.path}
							className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed border-line px-4 py-3"
						>
							<p className="min-w-0 flex-1 basis-60 text-sm">
								{t("folders.found", {
									app: appText(t, found.app),
									path: found.path,
								})}
							</p>
							<Button
								variant="secondary"
								onClick={() => add.mutate(found.path)}
								disabled={add.isPending}
								aria-label={t("folders.useNamed", { path: found.path })}
							>
								{t("folders.use")}
							</Button>
						</div>
					))}
				{adding && (
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							add.mutate(path);
						}}
					>
						<Label htmlFor={`${id}-path`} className="text-dim">
							{t("folders.pathLabel")}
						</Label>
						<Input
							id={`${id}-path`}
							value={path}
							onChange={(event) => setPath(event.target.value)}
							spellCheck={false}
							autoFocus
							className="h-10 font-mono"
						/>
						<p className="text-xs leading-relaxed text-dim">
							{t("folders.pathHint")}
						</p>
						<div className="flex flex-wrap gap-2">
							<Button type="submit" disabled={add.isPending || !path.trim()}>
								{t("folders.use")}
							</Button>
							<Button
								variant="outline"
								onClick={() => {
									setAdding(false);
									add.reset();
								}}
							>
								{t("common.cancel")}
							</Button>
						</div>
					</form>
				)}
				{(add.isPending || rescan.isPending) && (
					<p className="text-sm text-dim" role="status">
						{t("folders.reading")}
					</p>
				)}
				{(add.error || rescan.error || folders.error) && (
					<p className="text-sm text-danger">
						{explain(add.error ?? rescan.error ?? folders.error)}
					</p>
				)}
				{folders.data && linked.length === 0 && !adding && (
					<p className="text-sm text-dim">{t("folders.empty")}</p>
				)}
				{linked.length > 0 && (
					<ul className="flex flex-col gap-2">
						{linked.map((folder) => (
							<FolderRow key={folder.id} folder={folder} />
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}
