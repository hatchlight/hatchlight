import type { CheckpointInfo } from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useCan } from "./Accounts";
import { ApiError, api } from "./api";

/** The largest file the server takes, as it says. */
const MAX_CHECKPOINT_BYTES = 16 * 1024 ** 3;

import { useI18n } from "./i18n";
import { baseText } from "./Loras";

/** One model added by hand: how it runs, and a way to delete it. */
function CheckpointRow({ checkpoint }: { checkpoint: CheckpointInfo }) {
	const { t, bytes, explain } = useI18n();
	const can = useCan();
	const client = useQueryClient();
	const refresh = () => client.invalidateQueries({ queryKey: ["checkpoints"] });
	const [confirming, setConfirming] = useState(false);
	const [steps, setSteps] = useState(String(checkpoint.steps));
	const [cfgScale, setCfgScale] = useState(String(checkpoint.cfgScale));
	const [clipSkip, setClipSkip] = useState(
		checkpoint.clipSkip == null ? "" : String(checkpoint.clipSkip),
	);
	const save = useMutation({
		mutationFn: () =>
			api.updateCheckpoint(checkpoint.id, {
				steps: Number(steps),
				cfgScale: Number(cfgScale),
				clipSkip: clipSkip === "" ? null : Number(clipSkip),
			}),
		onSuccess: refresh,
	});
	const remove = useMutation({
		mutationFn: () => api.deleteCheckpoint(checkpoint.id),
		onSuccess: refresh,
	});
	// Compared as numbers: "7.0" is what is saved as 7.
	const changed =
		Number(steps) !== checkpoint.steps ||
		Number(cfgScale) !== checkpoint.cfgScale ||
		(clipSkip === "" ? null : Number(clipSkip)) !== checkpoint.clipSkip;
	const complete = steps.trim() !== "" && cfgScale.trim() !== "";
	const field =
		"w-20 rounded-md border border-line bg-bg px-2 py-1 font-mono text-sm";
	return (
		<li className="flex flex-col gap-3 rounded-lg border border-line bg-panel px-4 py-3">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				<div className="min-w-0 flex-1 basis-60">
					<p className="truncate font-medium" title={checkpoint.name}>
						{checkpoint.name}
					</p>
					<p className="text-sm text-dim">
						{t("checkpoints.family", { base: baseText(t, checkpoint.base) })}
					</p>
				</div>
				<span className="font-mono text-xs text-dim">
					{bytes(checkpoint.size)}
				</span>
				{!can.admin ? null : confirming ? (
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => remove.mutate()}
							disabled={remove.isPending}
							className="rounded-md bg-danger px-3 py-1 text-sm font-medium text-bg disabled:opacity-40"
						>
							{t("checkpoints.deleteConfirm")}
						</button>
						<button
							type="button"
							onClick={() => setConfirming(false)}
							className="rounded-md px-3 py-1 text-sm text-dim hover:text-ink"
						>
							{t("common.cancel")}
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setConfirming(true)}
						aria-label={t("checkpoints.deleteNamed", { name: checkpoint.name })}
						className="rounded-md border border-line px-3 py-1 text-sm text-dim hover:border-dim hover:text-ink"
					>
						{t("checkpoints.delete")}
					</button>
				)}
			</div>
			{/* Settings are shared: only admins change them. */}
			<fieldset disabled={!can.admin} className="contents">
				<form
					className="flex flex-wrap items-end gap-3 text-sm text-dim"
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<label className="flex flex-col gap-1">
						{t("checkpoints.steps")}
						<input
							type="number"
							min={1}
							max={150}
							step={1}
							value={steps}
							onChange={(event) => setSteps(event.target.value)}
							className={field}
						/>
					</label>
					<label className="flex flex-col gap-1">
						{t("checkpoints.guidance")}
						<input
							type="number"
							min={0}
							max={30}
							step={0.5}
							value={cfgScale}
							onChange={(event) => setCfgScale(event.target.value)}
							className={field}
						/>
					</label>
					<label className="flex flex-col gap-1">
						{t("checkpoints.clipSkip")}
						<select
							value={clipSkip}
							onChange={(event) => setClipSkip(event.target.value)}
							className={field}
						>
							<option value="">{t("checkpoints.clipSkipNone")}</option>
							{Array.from({ length: 12 }, (_, i) => String(i + 1)).map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</select>
					</label>
					{changed && (
						<button
							type="submit"
							disabled={save.isPending || !complete}
							className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-ink disabled:opacity-40"
						>
							{t("checkpoints.save")}
						</button>
					)}
				</form>
			</fieldset>
			<p className="text-xs leading-relaxed text-dim">
				{t("checkpoints.settingsHint")}
			</p>
			{(save.error || remove.error) && (
				<p className="text-sm text-danger">
					{explain(save.error ?? remove.error)}
				</p>
			)}
		</li>
	);
}

/** Whole models added from a file: community fine-tunes of SDXL or SD 1.5. */
export function CheckpointShelf() {
	const { t, bytes, explain } = useI18n();
	const can = useCan();
	const client = useQueryClient();
	const checkpoints = useQuery({
		queryKey: ["checkpoints"],
		queryFn: api.checkpoints,
	});
	const input = useRef<HTMLInputElement>(null);
	const add = useMutation({
		mutationFn: (file: File) => {
			// Refused before minutes of uploading, in the reader's language.
			if (file.size > MAX_CHECKPOINT_BYTES) {
				throw new ApiError("This file is too large", "checkpointTooLarge");
			}
			return api.addCheckpoint(file);
		},
		onSuccess: () => client.invalidateQueries({ queryKey: ["checkpoints"] }),
	});
	const adding = add.isPending ? add.variables : null;
	return (
		<section className="mt-10">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2 className="font-display text-xl font-bold tracking-tight">
						{t("checkpoints.title")}
					</h2>
					<p className="mt-1 max-w-2xl text-sm leading-relaxed text-dim">
						{t("checkpoints.intro")}
					</p>
				</div>
				{can.admin && (
					<button
						type="button"
						onClick={() => input.current?.click()}
						disabled={adding != null}
						className="rounded-md border border-line px-4 py-2 text-sm hover:border-dim disabled:opacity-40"
					>
						{t("checkpoints.add")}
					</button>
				)}
				<input
					ref={input}
					type="file"
					accept=".safetensors"
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) add.mutate(file);
					}}
				/>
			</div>
			{adding && (
				<p className="mt-3 text-sm text-dim" role="status">
					{t("checkpoints.adding", {
						name: adding.name,
						size: bytes(adding.size),
					})}
				</p>
			)}
			{add.error && (
				<p className="mt-3 text-sm text-danger">{explain(add.error)}</p>
			)}
			{checkpoints.error && (
				<p className="mt-3 text-sm text-danger">{explain(checkpoints.error)}</p>
			)}
			{checkpoints.data && checkpoints.data.length === 0 && !adding && (
				<p className="mt-3 text-sm text-dim">{t("checkpoints.empty")}</p>
			)}
			{checkpoints.data && checkpoints.data.length > 0 && (
				<ul className="mt-3 flex flex-col gap-2">
					{checkpoints.data.map((checkpoint) => (
						// Settings changed elsewhere start the row anew.
						<CheckpointRow
							key={`${checkpoint.id}:${checkpoint.steps}:${checkpoint.cfgScale}:${checkpoint.clipSkip}`}
							checkpoint={checkpoint}
						/>
					))}
				</ul>
			)}
		</section>
	);
}
