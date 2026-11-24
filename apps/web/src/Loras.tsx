import {
	type LoraBase,
	type LoraInfo,
	MAX_LORAS,
	type ModelSpec,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useCan } from "./Accounts";
import { api } from "./api";
import { type I18n, useI18n } from "./i18n";
import { ConfirmButton, LABEL, SECTION, TrainPanel } from "./Training";

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
	const client = useQueryClient();
	const remove = useMutation({
		mutationFn: () => api.deleteLora(lora.id),
		onSuccess: () => client.invalidateQueries({ queryKey: ["loras"] }),
	});
	const takers = models.filter((m) => m.capabilities.loraBase === lora.base);
	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-bg/60 px-4 py-3">
			<div className="min-w-0 flex-1 basis-60">
				<p className="truncate font-medium" title={lora.name}>
					{lora.name}
				</p>
				<p className="mt-0.5 text-sm text-dim">
					{takers.length > 0
						? t("loras.worksWith", {
								base: baseText(t, lora.base),
								models: takers.map((m) => m.name).join(", "),
							})
						: t("loras.noModel", { base: baseText(t, lora.base) })}
				</p>
				{lora.trigger && (
					<p className="mt-1.5 text-xs text-dim">
						{t("loras.trigger")}{" "}
						<code className="rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-ink">
							{lora.trigger}
						</code>
					</p>
				)}
				{remove.error && (
					<p className="mt-1 text-sm text-danger">{explain(remove.error)}</p>
				)}
			</div>
			<span className="font-mono text-xs text-dim">{bytes(lora.size)}</span>
			{can.admin && (
				<ConfirmButton
					label={t("loras.delete")}
					ariaLabel={t("loras.deleteNamed", { name: lora.name })}
					question={t("loras.deleteAsk", {
						name: lora.name,
						size: bytes(lora.size),
					})}
					confirm={t("loras.deleteConfirm")}
					disabled={remove.isPending}
					onConfirm={() => remove.mutate()}
				/>
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
	const can = useCan();
	return (
		<Card className={SECTION}>
			<Collapsible className="flex flex-col gap-5">
				<CardHeader className="flex flex-wrap items-start justify-between gap-4">
					<div className="flex max-w-2xl flex-col gap-2">
						<h2 className={LABEL}>{t("loras.title")}</h2>
						<p className="text-sm leading-relaxed text-dim">
							{t("loras.intro")}
						</p>
					</div>
					<div className={cn("flex flex-wrap gap-2", !can.train && "hidden")}>
						<CollapsibleTrigger
							render={<Button variant="outline" className="group" />}
						>
							{t("training.open")}
							<ChevronDownIcon
								aria-hidden="true"
								className="transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none"
							/>
						</CollapsibleTrigger>
						<Button
							variant="secondary"
							onClick={() => input.current?.click()}
							disabled={adding != null}
						>
							{t("loras.add")}
						</Button>
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
				</CardHeader>
				<CardContent className="flex flex-col gap-3 empty:hidden">
					{can.train && (
						<CollapsibleContent>
							<TrainPanel />
						</CollapsibleContent>
					)}
					{adding && (
						<p className="text-sm text-dim" role="status">
							{t("loras.adding", {
								name: adding.name,
								size: bytes(adding.size),
							})}
						</p>
					)}
					{add.error && (
						<p className="text-sm text-danger">{explain(add.error)}</p>
					)}
					{loras.error && (
						<p className="text-sm text-danger">{explain(loras.error)}</p>
					)}
					{loras.data && loras.data.length === 0 && !adding && (
						<p className="text-sm text-dim">{t("loras.empty")}</p>
					)}
					{loras.data && loras.data.length > 0 && (
						<ul className="flex flex-col gap-2">
							{loras.data.map((lora) => (
								<LoraRow key={lora.id} lora={lora} models={models.data ?? []} />
							))}
						</ul>
					)}
				</CardContent>
			</Collapsible>
		</Card>
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
	const { t, number, language } = useI18n();
	const id = useId();
	const loras = useLoras();
	const usable = (loras.data ?? []).filter((l) => bases.includes(l.base));
	if (usable.length === 0) return null;
	const chosen = value.flatMap((c) => {
		const lora = usable.find((l) => l.id === c.id);
		return lora ? [{ ...c, lora }] : [];
	});
	const left = usable.filter((l) => !value.some((c) => c.id === l.id));
	return (
		<div className="flex flex-wrap items-center gap-2">
			{chosen.map(({ id: loraId, weight, lora }) => (
				<div
					key={loraId}
					className="flex items-center gap-3 rounded-xl border border-line bg-panel py-1 pr-1 pl-3 text-sm"
				>
					<span className="max-w-40 truncate" title={lora.name}>
						{lora.name}
					</span>
					<span id={`${id}-${loraId}`} className="sr-only">
						{t("loras.weightOf", { name: lora.name })}
					</span>
					<Slider
						min={0}
						max={1.5}
						step={0.05}
						value={weight}
						onValueChange={(next) =>
							onChange(
								value.map((c) =>
									c.id === loraId
										? {
												...c,
												weight: Array.isArray(next) ? (next[0] ?? 0) : next,
											}
										: c,
								),
							)
						}
						aria-labelledby={`${id}-${loraId}`}
						format={{ style: "percent" }}
						locale={language}
						className="w-24"
					/>
					<span className="w-10 font-mono text-xs text-dim">
						{number(weight, { style: "percent" })}
					</span>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => onChange(value.filter((c) => c.id !== loraId))}
						aria-label={t("loras.removeNamed", { name: lora.name })}
					>
						<XIcon aria-hidden="true" />
					</Button>
				</div>
			))}
			{left.length > 0 && chosen.length < MAX_LORAS * bases.length && (
				<Select
					value={null}
					onValueChange={(next: string | null) => {
						if (next) onChange([...value, { id: next, weight: 1 }]);
					}}
				>
					<SelectTrigger
						aria-label={t("loras.choose")}
						className="data-[size=default]:h-10 rounded-xl"
					>
						<SelectValue placeholder={t("loras.choose")} />
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false}>
						{left.map((lora) => (
							<SelectItem key={lora.id} value={lora.id}>
								{lora.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
		</div>
	);
}
