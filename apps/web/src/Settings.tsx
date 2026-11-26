import {
	type ApiTokenView,
	type Settings as Choices,
	chooseLocalModel,
	type ImproveWith,
	type LocalModelsView,
	type LocalModelTask,
	type ProviderStatus,
	TOKEN_EXPIRY_DAYS,
	type TokenExpiryDays,
	type TokenScope,
	type TranslateWith,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { AccountSettings, UsersSettings, useAccount, useCan } from "./Accounts";
import { type AgentPolicy, api, useServerMode } from "./api";
import { useTour } from "./GuidedTour";
import { type I18n, useI18n } from "./i18n";
import { ModelCard, PageHeader } from "./Models";
import { ConfirmButton, LABEL, SECTION } from "./Training";
import { scopeText, TokenFacts } from "./tokens";

/** A panel inside a section: one provider, one model, one agent. */
const PANEL = "rounded-xl border border-line bg-bg/60 p-4";

/** The top of a section: its label and what it is for. */
function SectionHeader({ title, intro }: { title: string; intro?: string }) {
	return (
		<CardHeader className="flex flex-col gap-2">
			<h2 className={LABEL}>{title}</h2>
			{intro && (
				<p className="max-w-2xl text-sm leading-relaxed text-dim">{intro}</p>
			)}
		</CardHeader>
	);
}

/**
 * Whose keys a row shows and sets: a personal install's, a person's own
 * on a server, or the server's.
 */
type KeyScope = "install" | "personal" | "server";

function ProviderRow({
	provider,
	editable,
	scope = "install",
}: {
	provider: ProviderStatus;
	/** Only a server's owners set its keys. */
	editable: boolean;
	scope?: KeyScope;
}) {
	const can = useCan();
	const { t, explain } = useI18n();
	const client = useQueryClient();
	const [key, setKey] = useState("");
	const done = () => {
		setKey("");
		void client.invalidateQueries({ queryKey: ["assistant-brain"] });
		return client.invalidateQueries({ queryKey: ["providers"] });
	};
	const save = useMutation({
		mutationFn: () =>
			scope === "personal"
				? api.setOwnKey(provider.id, key)
				: api.setKey(provider.id, key),
		onSuccess: done,
	});
	const remove = useMutation({
		mutationFn: () =>
			scope === "personal"
				? api.deleteOwnKey(provider.id)
				: api.deleteKey(provider.id),
		onSuccess: done,
	});
	const hasKey =
		scope === "personal"
			? (provider.keys?.personal ?? false)
			: scope === "server"
				? (provider.keys?.server ?? false)
				: provider.hasKey;
	const error = save.error ?? remove.error;

	return (
		<li className={PANEL}>
			<div className="flex items-baseline justify-between gap-4">
				<h3 className="font-medium">{provider.name}</h3>
				{/* The server's keys are no use to someone who may not spend. */}
				{scope === "server" && !can.paid ? (
					<span className="font-mono text-xs text-dim">
						{t("settings.notForYou")}
					</span>
				) : (
					<span
						className={`font-mono text-xs ${hasKey ? "text-good" : "text-dim"}`}
					>
						{hasKey
							? t("settings.keyConfigured")
							: provider.requiresKey
								? t("settings.noKey")
								: t("settings.noKeyNeeded")}
					</span>
				)}
			</div>
			{provider.requiresKey && editable && (
				<form
					className="mt-3 flex flex-wrap gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<Input
						type="password"
						value={key}
						onChange={(event) => setKey(event.target.value)}
						placeholder={
							hasKey ? t("settings.replaceKey") : t("settings.pasteKey")
						}
						aria-label={t("settings.keyLabel", { provider: provider.name })}
						autoComplete="off"
						className="h-10 min-w-40 flex-1 font-mono"
					/>
					<Button type="submit" disabled={!key.trim() || save.isPending}>
						{t("settings.save")}
					</Button>
					{hasKey && (
						<Button
							variant="outline"
							onClick={() => remove.mutate()}
							disabled={remove.isPending}
							className="text-dim hover:text-danger"
						>
							{t("settings.remove")}
						</Button>
					)}
				</form>
			)}
			{error && <p className="mt-2 text-sm text-danger">{explain(error)}</p>}
		</li>
	);
}

/** One choice among a few, some of which may need something first. */
function Choice<T extends string>({
	label,
	value,
	options,
	disabled,
	onChoose,
}: {
	label: string;
	value: T;
	options: { value: T; label: string; usable: boolean }[];
	disabled: boolean;
	onChoose(value: T): void;
}) {
	const { t } = useI18n();
	const id = useId();
	const can = useCan();
	return (
		<div className="flex flex-col gap-2">
			<p id={id} className="text-sm font-medium">
				{label}
			</p>
			<RadioGroup
				aria-labelledby={id}
				value={value}
				onValueChange={(next) => {
					const option = options.find((o) => o.value === next);
					if (option) onChoose(option.value);
				}}
				disabled={disabled}
				className="gap-0.5"
			>
				{options.map((option) => (
					<Label
						key={option.value}
						className={cn(
							"-mx-2 min-h-10 items-start gap-3 rounded-lg px-2 py-2.5 leading-snug font-normal hover:bg-panel-2/60",
							!option.usable && "text-dim",
						)}
					>
						<RadioGroupItem
							value={option.value}
							disabled={!option.usable}
							className="mt-px"
						/>
						<span>
							{option.label}
							{!option.usable && (
								<span className="text-xs">
									{" "}
									{option.value !== "local"
										? t("settings.translateNoKey")
										: can.admin
											? t("settings.translateLocalMissing")
											: t("settings.translateLocalAskAdmin")}
								</span>
							)}
						</span>
					</Label>
				))}
			</RadioGroup>
		</div>
	);
}

/**
 * The small language model that puts prompts into English for the models
 * that read only English: installed here, like any local model.
 */
function Translation() {
	const { t, explain } = useI18n();
	const view = useQuery({
		queryKey: ["local-models"],
		queryFn: api.localModels,
	});
	const writers =
		view.data?.models.filter((m) => m.tasks.includes("prompt-translation")) ??
		[];
	const client = useQueryClient();
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const providers = useQuery({
		queryKey: ["providers"],
		queryFn: api.providers,
	});
	const choose = useMutation({
		mutationFn: (change: Partial<Choices>) => api.saveSettings(change),
		onSuccess: (saved) => {
			client.setQueryData(["settings"], saved);
			void client.invalidateQueries({ queryKey: ["assistant-brain"] });
		},
	});
	if (writers.length === 0) return null;
	const chosen = settings.data?.translateWith ?? "local";
	const hasKey = (provider: string) =>
		providers.data?.some((p) => p.id === provider && p.hasKey) ?? false;
	const local = {
		value: "local",
		label: t("settings.translateLocal"),
		usable: writers.some((m) => m.ready),
	} as const;
	const clouds = (["openai", "google", "openrouter"] as const).map((value) => ({
		value,
		label: t("settings.translateCloud", {
			provider: providers.data?.find((p) => p.id === value)?.name ?? value,
		}),
		usable: hasKey(value),
	}));
	const options: { value: TranslateWith; label: string; usable: boolean }[] = [
		local,
		...clouds,
		{ value: "off", label: t("settings.translateOff"), usable: true },
	];
	const improveChosen = settings.data?.improveWith ?? "auto";
	const improveOptions: {
		value: ImproveWith;
		label: string;
		usable: boolean;
	}[] = [
		{ value: "auto", label: t("settings.improveAuto"), usable: true },
		local,
		...clouds,
	];
	const assistantChosen = settings.data?.assistantWith ?? "auto";
	const assistantOptions: typeof improveOptions = [
		{ value: "auto", label: t("settings.assistantAuto"), usable: true },
		...clouds,
		{ ...local, label: t("settings.assistantLocal", { name: local.label }) },
	];
	return (
		<>
			<Card data-tour="settings-helpers" className={SECTION}>
				<SectionHeader
					title={t("settings.translation")}
					intro={t("settings.translationIntro")}
				/>
				<CardContent className="flex flex-col gap-6">
					<div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
						<Choice
							label={t("settings.translateWith")}
							value={chosen}
							options={options}
							disabled={choose.isPending}
							onChoose={(value) => choose.mutate({ translateWith: value })}
						/>
						<Choice
							label={t("settings.improveWith")}
							value={improveChosen}
							options={improveOptions}
							disabled={choose.isPending}
							onChoose={(value) => choose.mutate({ improveWith: value })}
						/>
						<Choice
							label={t("settings.assistantWith")}
							value={assistantChosen}
							options={assistantOptions}
							disabled={choose.isPending}
							onChoose={(value) => choose.mutate({ assistantWith: value })}
						/>
					</div>
					{choose.error && (
						<p className="text-sm text-danger">{explain(choose.error)}</p>
					)}
				</CardContent>
			</Card>
			{view.data && (
				<LanguageModels
					view={view.data}
					choices={settings.data}
					disabled={choose.isPending}
					onChoose={(change) => choose.mutate(change)}
				/>
			)}
		</>
	);
}

/** A job a language model on this computer does, and who can do it. */
interface Job {
	field: "writerModel" | "eyesModel";
	task: LocalModelTask;
	title: string;
	intro: string;
	use: string;
}

/**
 * The language models this computer can run, as cards like the Models
 * screen's: installed here, and chosen for the job each does.
 */
function LanguageModels({
	view,
	choices,
	disabled,
	onChoose,
}: {
	view: LocalModelsView;
	choices: Choices | undefined;
	disabled: boolean;
	onChoose(change: Partial<Choices>): void;
}) {
	const { t } = useI18n();
	const can = useCan();
	const jobs: Job[] = [
		{
			field: "writerModel",
			task: "prompt-translation",
			title: t("settings.languageWriter"),
			intro: t("settings.languageWriterIntro"),
			use: t("settings.useForWriting"),
		},
		{
			field: "eyesModel",
			task: "picture-description",
			title: t("settings.languageEyes"),
			intro: t("settings.eyesIntro"),
			use: t("settings.useForSeeing"),
		},
	];
	return (
		<Card className={SECTION}>
			<SectionHeader
				title={t("settings.languageModels")}
				intro={t("settings.languageModelsIntro")}
			/>
			<CardContent className="flex flex-col gap-10">
				{jobs.map((job) => {
					const candidates = view.models.filter((m) =>
						m.tasks.includes(job.task),
					);
					if (candidates.length === 0) return null;
					const chosen = choices?.[job.field] ?? null;
					const inUse = chooseLocalModel(
						candidates.map((m) => m.id),
						chosen,
						(id) => candidates.some((m) => m.id === id && m.ready),
					);
					return (
						<section
							key={job.field}
							aria-label={job.title}
							className="flex flex-col gap-5"
						>
							<div className="flex flex-col gap-1">
								<h3 className="font-display text-xl font-bold tracking-tight">
									{job.title}
								</h3>
								<p className="max-w-2xl text-sm leading-relaxed text-dim">
									{job.intro}
								</p>
								<div className="flex min-h-10 flex-wrap items-center gap-3 text-sm">
									{chosen == null ? (
										<span className="text-dim">
											{t("settings.languageAutomatic")}
										</span>
									) : (
										<Button
											variant="outline"
											disabled={disabled}
											onClick={() => onChoose({ [job.field]: null })}
										>
											{t("settings.languageBackToAutomatic")}
										</Button>
									)}
								</div>
							</div>
							<ul className="grid gap-5 md:grid-cols-2">
								{candidates.map((model) => (
									<ModelCard
										key={model.id}
										model={model}
										engine={view.engines.find((engine) =>
											model.variants.some(
												(v) =>
													v.id === model.variant && v.engine === engine.engine,
											),
										)}
										freeBytes={view.disk.freeBytes}
										recommended={false}
										focused={false}
										badges={
											model.id === inUse ? (
												<Badge className="h-6 bg-gold/15 px-2.5 text-gold">
													<CheckIcon aria-hidden="true" />
													{t("settings.inUse")}
												</Badge>
											) : model.id === chosen ? (
												<Badge variant="outline" className="h-6 px-2.5">
													{can.admin
														? t("settings.chosenNotReady")
														: t("settings.chosenAskAdmin")}
												</Badge>
											) : null
										}
										actions={
											model.ready &&
											model.id !== inUse && (
												<Button
													variant="outline"
													disabled={disabled}
													onClick={() => onChoose({ [job.field]: model.id })}
												>
													{job.use}
												</Button>
											)
										}
									/>
								))}
							</ul>
						</section>
					);
				})}
			</CardContent>
		</Card>
	);
}

/** A command to copy, with its button. */
function CopyLine({ text }: { text: string }) {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);
	return (
		<div className="mt-3 flex items-start gap-2">
			<code className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
				{text}
			</code>
			<Button
				variant="outline"
				disabled={!text}
				onClick={() =>
					void navigator.clipboard?.writeText(text).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					})
				}
			>
				{copied ? t("settings.agentsCopied") : t("settings.agentsCopy")}
			</Button>
		</div>
	);
}

/** An argument as a shell reads it: quoted when it has to be. */
const shellWord = (word: string, shell: "posix" | "powershell") =>
	/^[\w@%+=:,./-]+$/.test(word)
		? word
		: shell === "powershell"
			? `'${word.replaceAll("'", "''")}'`
			: `'${word.replaceAll("'", "'\\''")}'`;

/** The options `hatchlight mcp` takes for a policy. */
const policyArgs = (policy: AgentPolicy) =>
	policy.allowPaid
		? [
				"--allow-paid",
				...(policy.spendLimitUsd != null
					? ["--spend-limit", String(policy.spendLimitUsd)]
					: []),
			]
		: [];

/**
 * Lets AI agents, Claude first, make pictures and videos here with the
 * person's models: on this computer's alone unless they allow paid ones.
 */
function Agents() {
	const { t, explain, number } = useI18n();
	const id = useId();
	const client = useQueryClient();
	const status = useQuery({ queryKey: ["agents"], queryFn: api.agents });
	const [allowPaid, setAllowPaid] = useState<boolean | null>(null);
	const [limit, setLimit] = useState<string | null>(null);
	const [unlimited, setUnlimited] = useState<boolean | null>(null);
	const [restart, setRestart] = useState(false);
	const desktop = status.data?.claudeDesktop;
	// Until changed here, what Claude Desktop was set up with.
	const paid = allowPaid ?? desktop?.policy?.allowPaid ?? false;
	// No limit only when chosen as such, never from an empty field.
	const saved = desktop?.policy;
	const noLimit =
		unlimited ?? (saved?.allowPaid === true && saved.spendLimitUsd == null);
	const limitText = limit ?? String(saved?.spendLimitUsd ?? 5);
	const limitUsd = Number(limitText);
	const validLimit =
		!paid ||
		noLimit ||
		(limitText.trim() !== "" && Number.isFinite(limitUsd) && limitUsd >= 0);
	const policy: AgentPolicy = {
		allowPaid: paid,
		spendLimitUsd: paid && !noLimit ? limitUsd : null,
	};
	const refresh = () => client.invalidateQueries({ queryKey: ["agents"] });
	const connect = useMutation({
		mutationFn: () => api.connectClaudeDesktop(policy),
		onSuccess: () => {
			setRestart(true);
			return refresh();
		},
	});
	const disconnect = useMutation({
		mutationFn: api.disconnectClaudeDesktop,
		onSuccess: () => {
			setRestart(true);
			return refresh();
		},
	});
	const shell = status.data?.shell ?? "posix";
	const command =
		status.data && validLimit
			? [...status.data.claudeCode, ...policyArgs(policy)]
					.map((word) => shellWord(word, shell))
					.join(" ")
			: "";
	// Linux in WSL reads POSIX shell words, whatever the app runs on.
	const commandWsl =
		status.data?.claudeCodeWsl && validLimit
			? [...status.data.claudeCodeWsl, ...policyArgs(policy)]
					.map((word) => shellWord(word, "posix"))
					.join(" ")
			: "";
	// Up to date: the same limits, and this installation as it is now.
	const same =
		desktop?.current === true &&
		desktop.policy?.allowPaid === policy.allowPaid &&
		(desktop.policy?.spendLimitUsd ?? null) === policy.spendLimitUsd;
	const error = connect.error ?? disconnect.error ?? status.error;

	return (
		<Card data-tour="settings-agents" className={SECTION}>
			<SectionHeader
				title={t("settings.agents")}
				intro={t("settings.agentsIntro")}
			/>
			<CardContent className="flex flex-col gap-5">
				<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
					<Label className="min-h-10 gap-3 font-normal">
						<Switch
							checked={paid}
							onCheckedChange={(checked) => setAllowPaid(checked)}
						/>
						{t("settings.agentsPaid")}
					</Label>
					{paid && (
						<>
							<div className="flex items-center gap-3">
								<Label htmlFor={`${id}-limit`} className="font-normal text-dim">
									{t("settings.agentsLimit")}
								</Label>
								<Input
									id={`${id}-limit`}
									type="number"
									min={0}
									step={1}
									value={limitText}
									disabled={noLimit}
									onChange={(event) => setLimit(event.target.value)}
									aria-invalid={!validLimit}
									className="h-10 w-24 font-mono"
								/>
								{!noLimit && validLimit && (
									<span className="font-mono text-xs text-dim">
										{number(limitUsd, { style: "currency", currency: "USD" })}
									</span>
								)}
							</div>
							<Label className="min-h-10 gap-3 font-normal text-dim">
								<Checkbox
									checked={noLimit}
									onCheckedChange={(checked) => setUnlimited(checked)}
								/>
								{t("settings.agentsNoLimit")}
							</Label>
						</>
					)}
				</div>

				<div className="grid gap-3 md:grid-cols-2">
					<div className={PANEL}>
						<div className="flex items-baseline justify-between gap-4">
							<h3 className="font-medium">Claude Desktop</h3>
							<span
								className={`font-mono text-xs ${desktop?.connected ? "text-good" : "text-dim"}`}
							>
								{!desktop?.available
									? t("settings.agentsNotInstalled")
									: desktop.connected
										? t("settings.agentsConnected")
										: t("settings.agentsNotConnected")}
							</span>
						</div>
						{desktop?.problem && (
							<p className="mt-2 text-sm text-danger">
								{t("settings.agentsUnreadable")}
							</p>
						)}
						{desktop?.available && !desktop.problem && (
							<div className="mt-3 flex flex-wrap gap-2">
								{(!desktop.connected || !same) && (
									<Button
										variant="aurora"
										onClick={() => connect.mutate()}
										disabled={connect.isPending || !validLimit}
									>
										{desktop.connected
											? t("settings.agentsUpdate")
											: t("settings.agentsConnect")}
									</Button>
								)}
								{desktop.connected && (
									<Button
										variant="outline"
										onClick={() => disconnect.mutate()}
										disabled={disconnect.isPending}
										className="text-dim hover:text-danger"
									>
										{t("settings.agentsDisconnect")}
									</Button>
								)}
							</div>
						)}
						{restart && (
							<p className="mt-2 text-sm text-dim" role="status">
								{t("settings.agentsRestart")}
							</p>
						)}
					</div>

					<div className={PANEL}>
						<h3 className="font-medium">Claude Code</h3>
						<p className="mt-1 text-sm text-dim">{t("settings.agentsCode")}</p>
						<CopyLine text={command} />
						{commandWsl && (
							<>
								<p className="mt-3 text-sm text-dim">
									{t("settings.agentsCodeWsl")}
								</p>
								<CopyLine text={commandWsl} />
							</>
						)}
					</div>
				</div>
				{error && <p className="text-sm text-danger">{explain(error)}</p>}
			</CardContent>
		</Card>
	);
}

/**
 * Settings > Use with other apps: where apps that speak OpenAI's or
 * AUTOMATIC1111's image API find Hatchlight, and whether they may spend.
 */
function OtherApps() {
	const { t, explain } = useI18n();
	const server = useServerMode();
	const client = useQueryClient();
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const choose = useMutation({
		mutationFn: (change: Partial<Choices>) => api.saveSettings(change),
		onSuccess: (saved) => client.setQueryData(["settings"], saved),
	});
	const origin = window.location.origin;
	const error = choose.error ?? settings.error;
	const chosen = settings.data?.otherAppsModel ?? null;
	const chosenName = chosen
		? (models.data?.find((m) => m.id === chosen)?.name ?? chosen)
		: null;
	return (
		<Card className={SECTION}>
			<SectionHeader
				title={t("settings.otherApps")}
				intro={t("settings.otherAppsIntro")}
			/>
			<CardContent className="flex flex-col gap-5">
				<Label className="min-h-10 gap-3 font-normal">
					<Switch
						checked={settings.data?.otherAppsPaid ?? false}
						disabled={!settings.data || choose.isPending}
						onCheckedChange={(checked) =>
							choose.mutate({ otherAppsPaid: checked })
						}
					/>
					{server
						? t("settings.otherAppsPaidServer")
						: t("settings.otherAppsPaid")}
				</Label>
				<Label className="min-h-10 gap-3 font-normal">
					<Switch
						checked={settings.data?.otherAppsSampling ?? false}
						disabled={!settings.data || choose.isPending}
						onCheckedChange={(checked) =>
							choose.mutate({ otherAppsSampling: checked })
						}
					/>
					{t("settings.otherAppsSampling")}
				</Label>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
					<span className="text-dim">
						{chosenName
							? t("settings.otherAppsModel", { name: chosenName })
							: t("settings.otherAppsModelAuto")}
					</span>
					{chosen && (
						<Button
							variant="outline"
							disabled={choose.isPending}
							onClick={() => choose.mutate({ otherAppsModel: null })}
						>
							{t("settings.otherAppsModelReset")}
						</Button>
					)}
				</div>
				<div className="grid gap-3 md:grid-cols-2">
					<div className={PANEL}>
						<h3 className="font-medium">{t("settings.otherAppsOpenAi")}</h3>
						<CopyLine text={`${origin}/v1`} />
						<p className="mt-3 text-sm text-dim">
							{t("settings.otherAppsOpenWebUi")}
						</p>
					</div>
					<div className={PANEL}>
						<h3 className="font-medium">{t("settings.otherAppsA1111")}</h3>
						<CopyLine text={origin} />
						<p className="mt-3 text-sm text-dim">
							{t("settings.otherAppsSillyTavern")}
						</p>
					</div>
				</div>
				<p className="text-sm text-dim">
					{server
						? t("settings.otherAppsKeyServer")
						: t("settings.otherAppsKeyLocal")}
				</p>
				{!server && (
					<p className="text-sm text-dim">{t("settings.otherAppsDocker")}</p>
				)}
				{error && <p className="text-sm text-danger">{explain(error)}</p>}
			</CardContent>
		</Card>
	);
}

/** How comparisons are shown: with the models' names, or blind until a pick. */
function Comparisons() {
	const { t, explain } = useI18n();
	const client = useQueryClient();
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const save = useMutation({
		mutationFn: (blindPicks: boolean) => api.saveSettings({ blindPicks }),
		onSuccess: (saved) => client.setQueryData(["settings"], saved),
	});
	return (
		<Card className={SECTION}>
			<SectionHeader
				title={t("settings.comparisons")}
				intro={t("settings.comparisonsIntro")}
			/>
			<CardContent className="flex flex-col gap-3">
				<Label className="min-h-10 gap-3 font-normal">
					<Switch
						checked={settings.data?.blindPicks ?? false}
						disabled={!settings.data || save.isPending}
						onCheckedChange={(checked) => save.mutate(checked)}
					/>
					{t("settings.blindPicks")}
				</Label>
				{save.error && (
					<p className="text-sm text-danger">{explain(save.error)}</p>
				)}
			</CardContent>
		</Card>
	);
}

export function Settings() {
	const { t, explain, language, setLanguage, languages } = useI18n();
	const id = useId();
	// Agents are set up on the machine that runs Hatchlight.
	const server = useServerMode();
	const can = useCan();
	const tour = useTour();
	const providers = useQuery({
		queryKey: ["providers"],
		queryFn: api.providers,
	});
	const languageItems = languages.map((option) => ({
		value: option.code,
		label: option.name,
	}));
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-[1060px] flex-col gap-6 px-4 py-8 sm:px-8 sm:py-12">
				<PageHeader
					eyebrow={t("settings.eyebrow")}
					title={t("settings.title")}
					intro={t("settings.intro")}
				/>
				<Card className={SECTION}>
					<CardHeader className="flex flex-wrap items-center justify-between gap-4">
						<h2 className={LABEL}>
							<label htmlFor={`${id}-language`}>{t("settings.language")}</label>
						</h2>
						<Select
							items={languageItems}
							value={language}
							onValueChange={(next: string | null) => {
								if (next) setLanguage(next);
							}}
						>
							<SelectTrigger
								id={`${id}-language`}
								className="min-w-56 data-[size=default]:h-10"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{languages.map((option) => (
									<SelectItem
										key={option.code}
										value={option.code}
										lang={option.code}
									>
										{option.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</CardHeader>
				</Card>
				<Card className={SECTION}>
					<CardHeader className="flex flex-wrap items-center justify-between gap-4">
						<div className="flex max-w-2xl flex-col gap-2">
							<h2 className={LABEL}>{t("tour.settingsTitle")}</h2>
							<p className="text-sm leading-relaxed text-dim">
								{t("tour.settingsIntro")}
							</p>
						</div>
						<Button
							variant="outline"
							onClick={() => {
								tour.reset();
								tour.start("basics");
							}}
						>
							{t("tour.restart")}
						</Button>
					</CardHeader>
				</Card>
				<AccountSettings />
				<Translation />
				<Comparisons />
				{server ? (
					<>
						{can.paid && (
							<Card data-tour="settings-keys" className={SECTION}>
								<SectionHeader
									title={t("settings.yourKeys")}
									intro={t("settings.yourKeysIntro")}
								/>
								<CardContent className="flex flex-col gap-3">
									{providers.error && (
										<p className="text-sm text-danger">
											{explain(providers.error)}
										</p>
									)}
									<ul className="grid gap-3 md:grid-cols-2">
										{providers.data
											?.filter((provider) => provider.requiresKey)
											.map((provider) => (
												<ProviderRow
													key={provider.id}
													provider={provider}
													editable
													scope="personal"
												/>
											))}
									</ul>
								</CardContent>
							</Card>
						)}
						<Card data-tour="settings-keys" className={SECTION}>
							<SectionHeader
								title={t("settings.serverKeys")}
								intro={
									can.owner
										? t("settings.serverKeysIntro")
										: t("settings.providersServer")
								}
							/>
							<CardContent className="flex flex-col gap-3">
								{providers.error && (
									<p className="text-sm text-danger">
										{explain(providers.error)}
									</p>
								)}
								<ul className="grid gap-3 md:grid-cols-2">
									{providers.data
										?.filter((provider) => provider.requiresKey)
										.map((provider) => (
											<ProviderRow
												key={provider.id}
												provider={provider}
												editable={can.owner}
												scope="server"
											/>
										))}
								</ul>
							</CardContent>
						</Card>
					</>
				) : (
					<Card data-tour="settings-keys" className={SECTION}>
						<SectionHeader
							title={t("settings.providers")}
							intro={t("settings.providersIntro")}
						/>
						<CardContent className="flex flex-col gap-3">
							{providers.error && (
								<p className="text-sm text-danger">
									{explain(providers.error)}
								</p>
							)}
							<ul className="grid gap-3 md:grid-cols-2">
								{providers.data?.map((provider) => (
									<ProviderRow key={provider.id} provider={provider} editable />
								))}
							</ul>
						</CardContent>
					</Card>
				)}
				<UsersSettings />
				{server ? <AgentTokens /> : <Agents />}
				<OtherApps />
			</div>
		</div>
	);
}

/** What an agent's configuration takes, for this server and a new token. */
function snippets(origin: string, token: string, paid: boolean) {
	// The token goes in the environment, where a process list does not show it.
	const local = ["mcp", ...(paid ? ["--allow-paid"] : []), "--url", origin];
	return {
		// For every project, not only the one it is run in. Started with a
		// space, most shells keep it out of their history.
		claudeCode: ` claude mcp add --transport http --scope user hatchlight ${origin}/mcp --header "Authorization: Bearer ${token}"`,
		// The token read without showing, and kept out of the command.
		claudeCodeHidden: `read -s HATCHLIGHT_TOKEN\nclaude mcp add --transport http --scope user hatchlight ${origin}/mcp --header "Authorization: Bearer $HATCHLIGHT_TOKEN"`,
		// Claude Desktop's file takes commands only: the command line connects.
		claudeDesktop: JSON.stringify(
			{
				mcpServers: {
					hatchlight: {
						command: "hatchlight",
						args: local,
						env: { HATCHLIGHT_TOKEN: token },
					},
				},
			},
			null,
			2,
		),
		stdio: `HATCHLIGHT_TOKEN=${token} hatchlight ${local.join(" ")}`,
	};
}

/** A token just made: shown once, with what agents take. */
function NewToken({
	made,
	onDone,
}: {
	made: ApiTokenView & { token: string };
	onDone(): void;
}) {
	const { t } = useI18n();
	const lines = snippets(
		window.location.origin,
		made.token,
		made.scopes.includes("paid"),
	);
	return (
		<div className={PANEL} role="status">
			<h3 className="font-medium">{t("tokens.made", { name: made.name })}</h3>
			<p className="mt-1 text-sm text-warn">{t("tokens.once")}</p>
			<CopyLine text={made.token} />
			<h4 className="mt-5 text-sm font-medium">Claude Code</h4>
			<p className="mt-1 text-sm text-dim">{t("tokens.claudeCode")}</p>
			<CopyLine text={lines.claudeCode} />
			<p className="mt-2 text-sm text-dim">{t("tokens.claudeCodeHistory")}</p>
			<CopyLine text={lines.claudeCodeHidden} />
			<p className="mt-2 text-sm text-dim">{t("tokens.claudeCodeConfig")}</p>
			<h4 className="mt-5 text-sm font-medium">Claude Desktop</h4>
			<p className="mt-1 text-sm text-dim">{t("tokens.claudeDesktop")}</p>
			<CopyLine text={lines.claudeDesktop} />
			<h4 className="mt-5 text-sm font-medium">{t("tokens.stdioTitle")}</h4>
			<p className="mt-1 text-sm text-dim">{t("tokens.stdio")}</p>
			<CopyLine text={lines.stdio} />
			<Button variant="outline" onClick={onDone} className="mt-5">
				{t("tokens.done")}
			</Button>
		</div>
	);
}

const expiryText = (t: I18n["t"], days: TokenExpiryDays) =>
	days === null ? t("tokens.never") : t("tokens.days", { days });

/**
 * Settings > Use with AI agents, on a server: tokens that let an agent use
 * Hatchlight as this person, within what each token allows.
 */
export function AgentTokens() {
	const { t, explain } = useI18n();
	const can = useCan();
	const id = useId();
	const client = useQueryClient();
	const tokens = useQuery({ queryKey: ["tokens"], queryFn: api.tokens });
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<TokenScope[]>(["read", "generate"]);
	const [limit, setLimit] = useState("");
	const [days, setDays] = useState<TokenExpiryDays>(90);
	// The person shows it is them: a stolen session alone mints nothing.
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const twoStep = useAccount()?.totp === true;
	const [made, setMade] = useState<(ApiTokenView & { token: string }) | null>(
		null,
	);
	const offered: TokenScope[] = [
		"read",
		"generate",
		...(can.paid ? (["paid"] as const) : []),
		...(can.train ? (["train"] as const) : []),
	];
	const limitUsd = limit.trim() === "" ? null : Number(limit);
	const validLimit =
		limitUsd === null || (Number.isFinite(limitUsd) && limitUsd >= 0);
	const refresh = () => client.invalidateQueries({ queryKey: ["tokens"] });
	const create = useMutation({
		mutationFn: () =>
			api.createToken({
				password,
				code: twoStep ? code.trim() : undefined,
				name: name.trim(),
				scopes,
				spendLimitUsd: scopes.includes("paid") ? limitUsd : null,
				expiresInDays: days,
			}),
		onSuccess: (token) => {
			setMade(token);
			setName("");
			setPassword("");
			setCode("");
			return refresh();
		},
	});
	const revoke = useMutation({
		mutationFn: api.revokeToken,
		onSuccess: refresh,
	});
	const error = create.error ?? revoke.error ?? tokens.error;
	const expiryItems = TOKEN_EXPIRY_DAYS.map((value) => ({
		value: String(value),
		label: expiryText(t, value),
	}));

	return (
		<Card data-tour="settings-agents" className={SECTION}>
			<SectionHeader title={t("settings.agents")} intro={t("tokens.intro")} />
			<CardContent className="flex flex-col gap-5">
				{made ? (
					<NewToken made={made} onDone={() => setMade(null)} />
				) : (
					<form
						className={`${PANEL} flex flex-col gap-4`}
						onSubmit={(event) => {
							event.preventDefault();
							create.mutate();
						}}
					>
						<h3 className="font-medium">{t("tokens.new")}</h3>
						<div className="flex flex-col gap-2">
							<Label htmlFor={`${id}-name`} className="font-normal text-dim">
								{t("tokens.name")}
							</Label>
							<Input
								id={`${id}-name`}
								value={name}
								maxLength={64}
								placeholder={t("tokens.namePlaceholder")}
								onChange={(event) => setName(event.target.value)}
								className="h-10 max-w-sm"
							/>
						</div>
						<fieldset className="flex flex-col gap-1">
							<legend className="mb-1 text-sm text-dim">
								{t("tokens.scopes")}
							</legend>
							{offered.map((scope) => (
								<Label key={scope} className="min-h-9 gap-3 font-normal">
									<Checkbox
										checked={scopes.includes(scope)}
										onCheckedChange={(checked) =>
											setScopes((current) =>
												checked
													? [...current, scope]
													: current.filter((s) => s !== scope),
											)
										}
									/>
									{scopeText(t, scope)}
								</Label>
							))}
						</fieldset>
						<div className="flex flex-wrap items-end gap-4">
							{scopes.includes("paid") && (
								<div className="flex flex-col gap-2">
									<Label
										htmlFor={`${id}-limit`}
										className="font-normal text-dim"
									>
										{t("tokens.limit")}
									</Label>
									<Input
										id={`${id}-limit`}
										type="number"
										min={0}
										step="any"
										value={limit}
										placeholder={t("tokens.noLimit")}
										onChange={(event) => setLimit(event.target.value)}
										aria-invalid={!validLimit}
										className="h-10 w-32 font-mono"
									/>
								</div>
							)}
							<div className="flex flex-col gap-2">
								<Label
									htmlFor={`${id}-expiry`}
									className="font-normal text-dim"
								>
									{t("tokens.expiry")}
								</Label>
								<Select
									items={expiryItems}
									value={String(days)}
									onValueChange={(value: string | null) => {
										if (value !== null) {
											setDays(
												value === "null"
													? null
													: (Number(value) as TokenExpiryDays),
											);
										}
									}}
								>
									<SelectTrigger
										id={`${id}-expiry`}
										className="min-w-40 data-[size=default]:h-10"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{expiryItems.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						<div className="flex flex-wrap items-end gap-4">
							<div className="flex flex-col gap-2">
								<Label
									htmlFor={`${id}-password`}
									className="font-normal text-dim"
								>
									{t("tokens.password")}
								</Label>
								<Input
									id={`${id}-password`}
									type="password"
									autoComplete="current-password"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									className="h-10 w-64"
								/>
							</div>
							{twoStep && (
								<div className="flex flex-col gap-2">
									<Label
										htmlFor={`${id}-code`}
										className="font-normal text-dim"
									>
										{t("signin.code")}
									</Label>
									<Input
										id={`${id}-code`}
										inputMode="numeric"
										autoComplete="one-time-code"
										placeholder="123456"
										value={code}
										onChange={(event) => setCode(event.target.value)}
										className="h-10 w-36 font-mono tracking-widest"
									/>
								</div>
							)}
						</div>
						<Button
							type="submit"
							variant="aurora"
							disabled={
								!name.trim() ||
								!password ||
								(twoStep && !code.trim()) ||
								scopes.length === 0 ||
								!validLimit ||
								create.isPending
							}
							className="self-start"
						>
							{t("tokens.create")}
						</Button>
					</form>
				)}
				{(tokens.data?.length ?? 0) > 0 && (
					<div className={PANEL}>
						<h3 className="font-medium">{t("tokens.yours")}</h3>
						<ul className="mt-2 flex flex-col divide-y divide-line">
							{tokens.data?.map((token) => (
								<li
									key={token.id}
									className="flex flex-wrap items-center justify-between gap-3 py-3"
								>
									<span className="flex min-w-0 flex-col gap-1">
										<span className="font-medium break-all">{token.name}</span>
										<TokenFacts token={token} />
									</span>
									<ConfirmButton
										label={t("tokens.revoke")}
										question={t("tokens.revokeQuestion", { name: token.name })}
										confirm={t("tokens.revoke")}
										disabled={revoke.isPending}
										onConfirm={() => revoke.mutate(token.id)}
									/>
								</li>
							))}
						</ul>
					</div>
				)}
				{error && <p className="text-sm text-danger">{explain(error)}</p>}
			</CardContent>
		</Card>
	);
}
