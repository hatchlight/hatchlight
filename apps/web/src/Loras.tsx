import {
	type LoraBase,
	type LoraInfo,
	MAX_LORAS,
	type ModelSpec,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useCan } from "./Accounts";
import { api } from "./api";
import { type I18n, useI18n } from "./i18n";
import { TrainPanel } from "./Training";

/** A LoRA chosen for the next picture, and how strongly. */
export interface ChosenLora {
	id: string;
	weight: number;
}

export function baseText(t: I18n["t"], base: LoraBase): string {
	switch (base) {
		case "sd1":
			return t("loras.base.sd1");
		case "sdxl":
			return t("loras.base.sdxl");
		case "flux":
			return t("loras.base.flux");
		case "wan":
			return t("loras.base.wan");
		case "z-image":
			return t("loras.base.zImage");
	}
}

export function useLoras() {
	return useQuery({ queryKey: ["loras"], queryFn: api.loras });
}

/** One LoRA on the shelf: what it is for, and a way to delete it. */
function LoraRow({ lora, models }: { lora: LoraInfo; models: ModelSpec[] }) {
	const { t, bytes, explain } = useI18n();
	const can = useCan();
	const [confirming, setConfirming] = useState(false);
	const client = useQueryClient();
	const remove = useMutation({
		mutationFn: () => api.deleteLora(lora.id),
		onSuccess: () => client.invalidateQueries({ queryKey: ["loras"] }),
	});
	const takers = models.filter((m) => m.capabilities.loraBase === lora.base);
	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-panel px-4 py-3">
			<div className="min-w-0 flex-1 basis-60">
				<p className="truncate font-medium" title={lora.name}>
					{lora.name}
				</p>
				<p className="text-sm text-dim">
					{takers.length > 0
						? t("loras.worksWith", {
								base: baseText(t, lora.base),
								models: takers.map((m) => m.name).join(", "),
							})
						: t("loras.noModel", { base: baseText(t, lora.base) })}
				</p>
				{lora.trigger && (
					<p className="mt-1 text-xs text-dim">
						{t("loras.trigger")}{" "}
						<code className="rounded bg-bg px-1.5 py-0.5 font-mono text-ink">
							{lora.trigger}
						</code>
					</p>
				)}
				{remove.error && (
					<p className="mt-1 text-sm text-danger">{explain(remove.error)}</p>
				)}
			</div>
			<span className="font-mono text-xs text-dim">{bytes(lora.size)}</span>
			{!can.admin ? null : confirming ? (
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => remove.mutate()}
						disabled={remove.isPending}
						className="rounded-md bg-danger px-3 py-1 text-sm font-medium text-bg disabled:opacity-40"
					>
						{t("loras.deleteConfirm")}
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
					aria-label={t("loras.deleteNamed", { name: lora.name })}
					className="rounded-md border border-line px-3 py-1 text-sm text-dim hover:border-dim hover:text-ink"
				>
					{t("loras.delete")}
				</button>
			)}
		</li>
	);
}

/** The LoRAs kept here, and a way to add one from a file. */
export function LoraShelf() {
	const { t, bytes, explain } = useI18n();
	const loras = useLoras();
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const input = useRef<HTMLInputElement>(null);
	const client = useQueryClient();
	const add = useMutation({
		mutationFn: (file: File) => api.addLora(file),
		onSuccess: () => client.invalidateQueries({ queryKey: ["loras"] }),
	});
	const adding = add.isPending ? add.variables : null;
	const [training, setTraining] = useState(false);
	const can = useCan();
	return (
		<section className="mt-10">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2 className="font-display text-xl font-bold tracking-tight">
						{t("loras.title")}
					</h2>
					<p className="mt-1 max-w-2xl text-sm leading-relaxed text-dim">
						{t("loras.intro")}
					</p>
				</div>
				<div className={`flex gap-2 ${can.train ? "" : "hidden"}`}>
					<button
						type="button"
						onClick={() => setTraining((open) => !open)}
						aria-expanded={training}
						className="rounded-md border border-line px-4 py-2 text-sm hover:border-dim"
					>
						{t("training.open")}
					</button>
					<button
						type="button"
						onClick={() => input.current?.click()}
						disabled={adding != null}
						className="rounded-md border border-line px-4 py-2 text-sm hover:border-dim disabled:opacity-40"
					>
						{t("loras.add")}
					</button>
				</div>
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
			{training && can.train && <TrainPanel />}
			{adding && (
				<p className="mt-3 text-sm text-dim" role="status">
					{t("loras.adding", { name: adding.name, size: bytes(adding.size) })}
				</p>
			)}
			{add.error && (
				<p className="mt-3 text-sm text-danger">{explain(add.error)}</p>
			)}
			{loras.error && (
				<p className="mt-3 text-sm text-danger">{explain(loras.error)}</p>
			)}
			{loras.data && loras.data.length === 0 && !adding && (
				<p className="mt-3 text-sm text-dim">{t("loras.empty")}</p>
			)}
			{loras.data && loras.data.length > 0 && (
				<ul className="mt-3 flex flex-col gap-2">
					{loras.data.map((lora) => (
						<LoraRow key={lora.id} lora={lora} models={models.data ?? []} />
					))}
				</ul>
			)}
		</section>
	);
}

/**
 * LoRAs to add to the chosen models: offered only when one of them takes
 * LoRAs, and only those made for such a model.
 */
export function LoraPicker({
	bases,
	value,
	onChange,
}: {
	/** The families the chosen models take. */
	bases: LoraBase[];
	value: ChosenLora[];
	onChange(value: ChosenLora[]): void;
}) {
	const { t, number } = useI18n();
	const loras = useLoras();
	const usable = (loras.data ?? []).filter((l) => bases.includes(l.base));
	if (usable.length === 0) return null;
	const chosen = value.flatMap((c) => {
		const lora = usable.find((l) => l.id === c.id);
		return lora ? [{ ...c, lora }] : [];
	});
	const left = usable.filter((l) => !value.some((c) => c.id === l.id));
	const control = "rounded-md border border-line bg-bg px-2 py-1.5 text-sm";
	return (
		<div className="flex flex-wrap items-center gap-2">
			{chosen.map(({ id, weight, lora }) => (
				<div
					key={id}
					className="flex items-center gap-2 rounded-md border border-line bg-bg py-1 pr-1 pl-2 text-sm"
				>
					<span className="max-w-40 truncate" title={lora.name}>
						{lora.name}
					</span>
					<input
						type="range"
						min={0}
						max={1.5}
						step={0.05}
						value={weight}
						onChange={(event) =>
							onChange(
								value.map((c) =>
									c.id === id
										? { ...c, weight: Number(event.target.value) }
										: c,
								),
							)
						}
						aria-label={t("loras.weightOf", { name: lora.name })}
						aria-valuetext={t("loras.weightValue", {
							amount: number(weight, { style: "percent" }),
						})}
						className="w-24 accent-accent"
					/>
					<span className="w-10 font-mono text-xs text-dim">
						{number(weight, { style: "percent" })}
					</span>
					<button
						type="button"
						onClick={() => onChange(value.filter((c) => c.id !== id))}
						aria-label={t("loras.removeNamed", { name: lora.name })}
						className="rounded px-1.5 text-dim hover:text-ink"
					>
						×
					</button>
				</div>
			))}
			{left.length > 0 && chosen.length < MAX_LORAS * bases.length && (
				<select
					value=""
					onChange={(event) => {
						const id = event.target.value;
						if (id) onChange([...value, { id, weight: 1 }]);
					}}
					aria-label={t("loras.choose")}
					className={control}
				>
					<option value="">{t("loras.choose")}</option>
					{left.map((lora) => (
						<option key={lora.id} value={lora.id}>
							{lora.name}
						</option>
					))}
				</select>
			)}
		</div>
	);
}
