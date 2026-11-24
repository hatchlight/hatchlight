import type { CheckpointInfo } from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError, api } from "./api";

/** The largest file the server takes, as it says. */
const MAX_CHECKPOINT_BYTES = 16 * 1024 ** 3;

import { useCan } from "./Accounts";
import { useI18n } from "./i18n";
import { baseText } from "./Loras";
import { ConfirmButton, LABEL, SECTION } from "./Training";

/** One model added by hand: how it runs, and a way to delete it. */
function CheckpointRow({ checkpoint }: { checkpoint: CheckpointInfo }) {
	const { t, bytes, explain } = useI18n();
	const can = useCan();
	const id = useId();
	const client = useQueryClient();
	const refresh = () => client.invalidateQueries({ queryKey: ["checkpoints"] });
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
	// "None" is the empty choice; the others are how many layers to skip.
	const skips = [
		{ value: null, label: t("checkpoints.clipSkipNone") },
		...Array.from({ length: 12 }, (_, i) => ({
			value: String(i + 1),
			label: String(i + 1),
		})),
	];
	return (
		<li className="flex flex-col gap-4 rounded-xl border border-line bg-bg/60 p-4">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<div className="min-w-0 flex-1 basis-60">
					<p className="truncate font-medium" title={checkpoint.name}>
						{checkpoint.name}
					</p>
					<p className="mt-0.5 text-sm text-dim">
						{t("checkpoints.family", { base: baseText(t, checkpoint.base) })}
					</p>
				</div>
				<span className="font-mono text-xs text-dim">
					{bytes(checkpoint.size)}
				</span>
				{can.admin && (
					<ConfirmButton
						label={t("checkpoints.delete")}
						ariaLabel={t("checkpoints.deleteNamed", { name: checkpoint.name })}
						question={t("checkpoints.deleteAsk", {
							name: checkpoint.name,
							size: bytes(checkpoint.size),
						})}
						confirm={t("checkpoints.deleteConfirm")}
						disabled={remove.isPending}
						onConfirm={() => remove.mutate()}
					/>
				)}
			</div>
			{/* Settings are shared: only admins change them. */}
			<fieldset disabled={!can.admin} className="contents">
				<form
					className="flex flex-wrap items-end gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-steps`} className="text-dim">
							{t("checkpoints.steps")}
						</Label>
						<Input
							id={`${id}-steps`}
							type="number"
							min={1}
							max={150}
							step={1}
							value={steps}
							onChange={(event) => setSteps(event.target.value)}
							className="h-10 w-24 font-mono"
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-guidance`} className="text-dim">
							{t("checkpoints.guidance")}
						</Label>
						<Input
							id={`${id}-guidance`}
							type="number"
							min={0}
							max={30}
							step={0.5}
							value={cfgScale}
							onChange={(event) => setCfgScale(event.target.value)}
							className="h-10 w-24 font-mono"
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-skip`} className="text-dim">
							{t("checkpoints.clipSkip")}
						</Label>
						<Select
							items={skips}
							value={clipSkip === "" ? null : clipSkip}
							onValueChange={(next: string | null) => setClipSkip(next ?? "")}
						>
							<SelectTrigger
								id={`${id}-skip`}
								className="w-28 font-mono data-[size=default]:h-10"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{skips.map((skip) => (
									<SelectItem key={skip.label} value={skip.value}>
										{skip.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{changed && (
						<Button type="submit" disabled={save.isPending || !complete}>
							{t("checkpoints.save")}
						</Button>
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
		<Card className={SECTION}>
			<CardHeader className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex max-w-2xl flex-col gap-2">
					<h2 className={LABEL}>{t("checkpoints.title")}</h2>
					<p className="text-sm leading-relaxed text-dim">
						{t("checkpoints.intro")}
					</p>
				</div>
				{can.admin && (
					<Button
						variant="secondary"
						onClick={() => input.current?.click()}
						disabled={adding != null}
					>
						{t("checkpoints.add")}
					</Button>
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
			</CardHeader>
			<CardContent className="flex flex-col gap-3 empty:hidden">
				{adding && (
					<p className="text-sm text-dim" role="status">
						{t("checkpoints.adding", {
							name: adding.name,
							size: bytes(adding.size),
						})}
					</p>
				)}
				{add.error && (
					<p className="text-sm text-danger">{explain(add.error)}</p>
				)}
				{checkpoints.error && (
					<p className="text-sm text-danger">{explain(checkpoints.error)}</p>
				)}
				{checkpoints.data && checkpoints.data.length === 0 && !adding && (
					<p className="text-sm text-dim">{t("checkpoints.empty")}</p>
				)}
				{checkpoints.data && checkpoints.data.length > 0 && (
					<ul className="flex flex-col gap-2">
						{checkpoints.data.map((checkpoint) => (
							// Settings changed elsewhere start the row anew.
							<CheckpointRow
								key={`${checkpoint.id}:${checkpoint.steps}:${checkpoint.cfgScale}:${checkpoint.clipSkip}`}
								checkpoint={checkpoint}
							/>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}
