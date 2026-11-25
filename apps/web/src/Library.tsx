import {
	type Asset,
	type LibraryEntry,
	type LibraryKind,
	LORA_BASES,
	MAX_LIBRARY_PICTURES,
	MAX_LORAS,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	PencilIcon,
	PlusIcon,
	Trash2Icon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, assetUrl, useLibrary } from "./api";
import {
	draftOf,
	type LibraryDraft,
	libraryFacts,
	takeLibraryDraft,
} from "./drafts";
import { useI18n } from "./i18n";
import { LoraPicker, useLoras } from "./Loras";
import { PageHeader } from "./Models";
import { GalleryChooser, LABEL, SECTION } from "./Training";

/** "None", as a value a select can hold. */
const NONE = "none";

function Editor({ draft, onDone }: { draft: LibraryDraft; onDone(): void }) {
	const { t, explain } = useI18n();
	const id = useId();
	const client = useQueryClient();
	const [value, setValue] = useState<LibraryDraft>(draft);
	const [choosing, setChoosing] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const loras = useLoras();
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const pictureModels = (models.data ?? []).filter(
		(m) => m.media === "image" && m.capabilities.upscale == null,
	);
	const ratios = [
		...new Set(pictureModels.flatMap((m) => m.capabilities.aspectRatios)),
	];
	const character = value.kind === "character";
	const pictures = value.pictureIds ?? [];
	const set = (change: Partial<LibraryDraft>) =>
		setValue((current) => ({ ...current, ...change }));
	const togglePicture = (asset: Pick<Asset, "id">) =>
		set({
			pictureIds: pictures.includes(asset.id)
				? pictures.filter((p) => p !== asset.id)
				: [...pictures, asset.id].slice(0, MAX_LIBRARY_PICTURES),
		});
	const upload = useMutation({
		mutationFn: api.upload,
		onSuccess: (asset) => {
			void client.invalidateQueries({ queryKey: ["gallery"] });
			togglePicture(asset);
		},
	});
	const save = useMutation({
		mutationFn: () => {
			const { id: entryId, ...input } = value;
			return api.saveLibraryEntry(
				{ ...input, name: input.name.trim() },
				entryId,
			);
		},
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: ["library"] });
			onDone();
		},
	});
	const chosenLoras = (value.loras ?? []).map(({ id: loraId, weight }) => ({
		id: loraId,
		weight: weight ?? 1,
	}));
	const seedText = value.seed == null ? "" : String(value.seed);

	return (
		<Card className={SECTION}>
			<CardContent>
				<form
					className="flex flex-col gap-5"
					aria-labelledby={`${id}-title`}
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<h2 id={`${id}-title`} className="font-display text-xl font-bold">
						{value.id
							? t("library.editing", { name: draft.name })
							: character
								? t("library.newCharacter")
								: t("library.newStyle")}
					</h2>
					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-name`} className="text-dim">
							{t("library.name")}
						</Label>
						<Input
							id={`${id}-name`}
							value={value.name}
							onChange={(event) => set({ name: event.target.value })}
							placeholder={
								character
									? t("library.namePlaceholderCharacter")
									: t("library.namePlaceholderStyle")
							}
							maxLength={60}
							required
						/>
					</div>

					<div className="flex flex-col gap-2.5">
						<span id={`${id}-pictures`} className={LABEL}>
							{character
								? t("library.picturesOfCharacter")
								: t("library.picturesOfStyle")}
						</span>
						<p className="text-xs leading-relaxed text-dim">
							{character
								? t("library.picturesHintCharacter", {
										count: MAX_LIBRARY_PICTURES,
									})
								: t("library.picturesHintStyle")}
						</p>
						{pictures.length > 0 && (
							<ul
								aria-labelledby={`${id}-pictures`}
								className="flex flex-wrap gap-2"
							>
								{pictures.map((picture, index) => (
									<li key={picture} className="relative">
										<img
											src={assetUrl(picture)}
											alt={t("library.pictureN", { n: index + 1 })}
											className="h-20 w-20 rounded-lg object-cover"
										/>
										<Button
											type="button"
											variant="secondary"
											size="icon"
											className="absolute -top-2 -right-2 size-7 rounded-full"
											onClick={() => togglePicture({ id: picture })}
											aria-label={t("library.removePicture", { n: index + 1 })}
										>
											<XIcon aria-hidden="true" />
										</Button>
									</li>
								))}
							</ul>
						)}
						{pictures.length < MAX_LIBRARY_PICTURES && (
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setChoosing((open) => !open)}
									aria-expanded={choosing}
								>
									{t("library.fromGallery")}
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={upload.isPending}
									onClick={() => fileInput.current?.click()}
								>
									<UploadIcon aria-hidden="true" />
									{t("library.upload")}
								</Button>
								<input
									ref={fileInput}
									type="file"
									accept="image/png,image/jpeg,image/webp"
									hidden
									onChange={(event) => {
										const file = event.target.files?.[0];
										if (file) upload.mutate(file);
										event.target.value = "";
									}}
								/>
							</div>
						)}
						{upload.error && (
							<p className="text-sm text-danger">{explain(upload.error)}</p>
						)}
						{choosing && (
							<GalleryChooser
								chosen={new Set(pictures)}
								toggle={togglePicture}
								close={() => setChoosing(false)}
							/>
						)}
					</div>

					{(loras.data?.length ?? 0) > 0 && (
						<div className="flex flex-col gap-2.5">
							<span className={LABEL}>{t("library.lorasLabel")}</span>
							<LoraPicker
								bases={[...LORA_BASES]}
								value={chosenLoras}
								onChange={(next) =>
									set({
										loras: next.slice(0, MAX_LORAS).map((chosen) => ({
											...chosen,
											// Its trigger word, as it was kept or as the LoRA has it.
											trigger:
												value.loras?.find((l) => l.id === chosen.id)?.trigger ??
												loras.data?.find((l) => l.id === chosen.id)?.trigger ??
												null,
										})),
									})
								}
							/>
							{(value.loras ?? []).some((l) => l.trigger) && (
								<p className="text-xs text-dim">
									{t("library.triggers", {
										words: (value.loras ?? [])
											.flatMap((l) => (l.trigger ? [l.trigger] : []))
											.join(", "),
									})}
								</p>
							)}
						</div>
					)}

					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-prompt`} className="text-dim">
							{character
								? t("library.promptCharacter")
								: t("library.promptStyle")}
						</Label>
						<Textarea
							id={`${id}-prompt`}
							value={value.prompt ?? ""}
							onChange={(event) => set({ prompt: event.target.value || null })}
							placeholder={
								character
									? t("library.promptPlaceholderCharacter")
									: t("library.promptPlaceholderStyle")
							}
							maxLength={1000}
							rows={2}
						/>
					</div>

					<div className="grid gap-4 sm:grid-cols-2">
						{character ? (
							<div className="flex flex-col gap-2">
								<Label htmlFor={`${id}-seed`} className="text-dim">
									{t("library.seed")}
								</Label>
								<Input
									id={`${id}-seed`}
									inputMode="numeric"
									value={seedText}
									onChange={(event) => {
										const text = event.target.value.trim();
										const seed = Number(text);
										if (text === "") set({ seed: null });
										else if (Number.isInteger(seed) && seed >= 0) set({ seed });
									}}
									placeholder={t("library.seedPlaceholder")}
								/>
							</div>
						) : (
							<div className="flex flex-col gap-2">
								<span id={`${id}-ratio`} className="text-sm text-dim">
									{t("library.ratio")}
								</span>
								<Select
									value={value.aspectRatio ?? NONE}
									onValueChange={(next) =>
										set({ aspectRatio: next && next !== NONE ? next : null })
									}
									items={[
										{ value: NONE, label: t("library.ratioAny") },
										...ratios.map((r) => ({ value: r, label: r })),
									]}
								>
									<SelectTrigger
										aria-labelledby={`${id}-ratio`}
										className="h-10 w-full rounded-xl data-[size=default]:h-10"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={NONE}>
											{t("library.ratioAny")}
										</SelectItem>
										{ratios.map((r) => (
											<SelectItem key={r} value={r}>
												{r}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}
						<div className="flex flex-col gap-2">
							<span id={`${id}-model`} className="text-sm text-dim">
								{t("library.model")}
							</span>
							<Select
								value={value.modelId ?? NONE}
								onValueChange={(next) =>
									set({ modelId: next && next !== NONE ? next : null })
								}
								items={[
									{ value: NONE, label: t("library.modelAny") },
									...pictureModels.map((m) => ({ value: m.id, label: m.name })),
								]}
							>
								<SelectTrigger
									aria-labelledby={`${id}-model`}
									className="h-10 w-full rounded-xl data-[size=default]:h-10"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NONE}>{t("library.modelAny")}</SelectItem>
									{pictureModels.map((m) => (
										<SelectItem key={m.id} value={m.id}>
											{m.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-notes`} className="text-dim">
							{t("library.notes")}
						</Label>
						<Textarea
							id={`${id}-notes`}
							value={value.notes ?? ""}
							onChange={(event) => set({ notes: event.target.value || null })}
							placeholder={t("library.notesPlaceholder")}
							maxLength={1000}
							rows={2}
						/>
					</div>

					{save.error && (
						<p className="text-sm text-danger" role="alert">
							{explain(save.error)}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Button
							type="submit"
							variant="aurora"
							disabled={save.isPending || value.name.trim() === ""}
						>
							{t("library.save")}
						</Button>
						<Button type="button" variant="ghost" onClick={onDone}>
							{t("nav.cancel")}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

function Entry({ entry, onEdit }: { entry: LibraryEntry; onEdit(): void }) {
	const { t, explain } = useI18n();
	const client = useQueryClient();
	const [asking, setAsking] = useState(false);
	const remove = useMutation({
		mutationFn: () => api.deleteLibraryEntry(entry.id),
		onSuccess: () => client.invalidateQueries({ queryKey: ["library"] }),
	});
	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-bg/60 px-4 py-3">
			<div className="flex shrink-0 -space-x-3">
				{entry.pictureIds.slice(0, 3).map((picture) => (
					<img
						key={picture}
						src={assetUrl(picture)}
						alt=""
						className="h-12 w-12 rounded-lg border-2 border-panel object-cover"
					/>
				))}
			</div>
			<div className="min-w-0 flex-1 basis-48">
				<p className="truncate font-medium">{entry.name}</p>
				<p className="mt-0.5 truncate text-sm text-dim">
					{libraryFacts(t, entry) || t("library.nothingYet")}
				</p>
			</div>
			<div className="flex gap-1">
				<Button
					variant="ghost"
					size="icon"
					onClick={onEdit}
					aria-label={t("library.editNamed", { name: entry.name })}
				>
					<PencilIcon aria-hidden="true" />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					disabled={remove.isPending}
					onClick={() => setAsking(true)}
					aria-label={t("library.deleteNamed", { name: entry.name })}
					className="text-dim hover:text-danger"
				>
					<Trash2Icon aria-hidden="true" />
				</Button>
			</div>
			{remove.error && (
				<p className="w-full text-sm text-danger">{explain(remove.error)}</p>
			)}
			<AlertDialog open={asking} onOpenChange={setAsking}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("library.deleteTitle", { name: entry.name })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("library.deleteBody")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("nav.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								setAsking(false);
								remove.mutate();
							}}
						>
							{t("library.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</li>
	);
}

function Section({
	kind,
	entries,
	onEdit,
	onNew,
}: {
	kind: LibraryKind;
	entries: LibraryEntry[];
	onEdit(entry: LibraryEntry): void;
	onNew(): void;
}) {
	const { t } = useI18n();
	const id = useId();
	const mine = entries.filter((e) => e.kind === kind);
	return (
		<Card className={SECTION}>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 id={id} className="font-display text-xl font-bold">
						{kind === "character"
							? t("library.characters")
							: t("library.styles")}
					</h2>
					<Button variant="outline" onClick={onNew}>
						<PlusIcon aria-hidden="true" />
						{kind === "character"
							? t("library.newCharacter")
							: t("library.newStyle")}
					</Button>
				</div>
				{mine.length === 0 ? (
					<p className="text-sm text-dim">
						{kind === "character"
							? t("library.noCharacters")
							: t("library.noStyles")}
					</p>
				) : (
					<ul aria-labelledby={id} className="flex flex-col gap-2">
						{mine.map((entry) => (
							<Entry
								key={entry.id}
								entry={entry}
								onEdit={() => onEdit(entry)}
							/>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

/** Characters and styles to use again by name, and where they are written. */
export function Library() {
	const { t, explain } = useI18n();
	const library = useLibrary();
	// A draft from elsewhere (a picture, a LoRA just trained) opens at once.
	const [draft, setDraft] = useState<LibraryDraft | null>(takeLibraryDraft);
	// Each draft its own editor, so a new one starts from what it brings.
	const [version, setVersion] = useState(0);
	const edit = (next: LibraryDraft) => {
		setDraft(next);
		setVersion((v) => v + 1);
		window.scrollTo?.({ top: 0 });
	};
	const entries = library.data ?? [];
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-[1060px] flex-col gap-6 px-4 py-8 sm:px-8 sm:py-12">
				<PageHeader
					eyebrow={t("library.eyebrow")}
					title={t("library.title")}
					intro={t("library.intro")}
				/>
				{draft && (
					<Editor key={version} draft={draft} onDone={() => setDraft(null)} />
				)}
				{library.error && (
					<p className="text-sm text-danger">{explain(library.error)}</p>
				)}
				{(["character", "style"] as const).map((kind) => (
					<Section
						key={kind}
						kind={kind}
						entries={entries}
						onEdit={(entry) => edit(draftOf(entry))}
						onNew={() => edit({ kind, name: "" })}
					/>
				))}
			</div>
		</div>
	);
}
