import type {
	Settings as Choices,
	ImproveWith,
	LocalModelStatus,
	ProviderStatus,
	TranslateWith,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
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
import { AccountSettings, UsersSettings, useCan } from "./Accounts";
import { type AgentPolicy, api, useServerMode } from "./api";
import { useI18n } from "./i18n";
import { useModelProgress } from "./live";
import { PageHeader } from "./Models";
import { Bar, LABEL, SECTION } from "./Training";

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
				<span
					className={`font-mono text-xs ${hasKey ? "text-good" : "text-dim"}`}
				>
					{hasKey
						? t("settings.keyConfigured")
						: provider.requiresKey
							? t("settings.noKey")
							: t("settings.noKeyNeeded")}
				</span>
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
									{option.value === "local"
										? t("settings.translateLocalMissing")
										: t("settings.translateNoKey")}
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
	const model = view.data?.models.find((m) =>
		m.tasks.includes("prompt-translation"),
	);
	const eyes = view.data?.models.find((m) =>
		m.tasks.includes("picture-description"),
	);
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
	if (!model) return null;
	const chosen = settings.data?.translateWith ?? "local";
	const hasKey = (provider: string) =>
		providers.data?.some((p) => p.id === provider && p.hasKey) ?? false;
	const local = {
		value: "local",
		label: t("settings.translateLocal"),
		usable: model.ready,
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
			<Card className={SECTION}>
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
					<HelperModel
						model={model}
						label={t("settings.translation")}
						on={t("settings.translationOn")}
						off={t("settings.translationOff")}
						install={(size) => t("settings.translationInstall", { size })}
					/>
				</CardContent>
			</Card>
			{eyes && (
				<Card className={SECTION}>
					<SectionHeader
						title={t("settings.eyes")}
						intro={t("settings.eyesIntro")}
					/>
					<CardContent>
						<HelperModel
							model={eyes}
							label={t("settings.eyes")}
							on={t("settings.eyesOn")}
							off={t("settings.eyesOff")}
							install={(size) => t("settings.eyesInstall", { size })}
						/>
					</CardContent>
				</Card>
			)}
		</>
	);
}

/** A model that helps the others, installed and removed here. */
function HelperModel({
	model,
	label,
	on,
	off,
	install: installText,
}: {
	model: LocalModelStatus;
	label: string;
	on: string;
	off: string;
	install(size: string): string;
}) {
	const { t, bytes, explain } = useI18n();
	const live = useModelProgress(model.id);
	const can = useCan();
	const install = useMutation({ mutationFn: () => api.installModel(model.id) });
	const cancel = useMutation({ mutationFn: () => api.cancelModel(model.id) });
	const remove = useMutation({ mutationFn: () => api.deleteModel(model.id) });
	const busy = ["queued", "downloading", "verifying"].includes(
		live?.state ?? model.state,
	);
	const received = live?.receivedBytes ?? model.receivedBytes;
	const size = live?.size ?? model.size;
	const percent = Math.round((received / Math.max(size, 1)) * 100);
	const error = install.error ?? remove.error;
	return (
		<div className={PANEL}>
			<div className="flex items-baseline justify-between gap-4">
				<h3 className="font-medium">{model.name}</h3>
				<span
					className={`font-mono text-xs ${model.ready ? "text-good" : "text-dim"}`}
				>
					{model.ready ? on : off}
				</span>
			</div>
			{busy ? (
				<div className="mt-3 flex flex-wrap items-center gap-3">
					<Bar value={percent} label={label} className="min-w-40 flex-1" />
					<span className="font-mono text-xs text-dim">
						{bytes(received)} / {bytes(size)}
					</span>
					{can.admin && (
						<Button variant="outline" onClick={() => cancel.mutate()}>
							{t("common.cancel")}
						</Button>
					)}
				</div>
			) : !can.admin ? (
				!model.ready && (
					<p className="mt-3 text-sm text-dim">{t("models.askAdmin")}</p>
				)
			) : model.ready ? (
				<Button
					variant="outline"
					onClick={() => remove.mutate()}
					disabled={remove.isPending}
					className="mt-3 text-dim hover:text-danger"
				>
					{t("settings.remove")}
				</Button>
			) : (
				<Button
					onClick={() => install.mutate()}
					disabled={install.isPending}
					className="mt-3"
				>
					{installText(bytes(size))}
				</Button>
			)}
			{model.error && !busy && (
				<p className="mt-2 text-sm text-danger">
					{explain({
						message: model.error,
						code: model.errorCode ?? null,
						params: model.errorParams ?? null,
					})}
				</p>
			)}
			{error && <p className="mt-2 text-sm text-danger">{explain(error)}</p>}
		</div>
	);
}

/** A command to copy, with its button. */
function CopyLine({ text }: { text: string }) {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);
	return (
		<div className="mt-3 flex items-start gap-2">
			<code className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2.5 font-mono text-xs leading-relaxed break-all">
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
		<Card className={SECTION}>
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

export function Settings() {
	const { t, explain, language, setLanguage, languages } = useI18n();
	const id = useId();
	// Agents are set up on the machine that runs Hatchlight.
	const server = useServerMode();
	const can = useCan();
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
				<AccountSettings />
				<Translation />
				{server ? (
					<>
						{can.paid && (
							<Card className={SECTION}>
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
						<Card className={SECTION}>
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
									{providers.data?.map((provider) => (
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
					<Card className={SECTION}>
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
				{!server && <Agents />}
			</div>
		</div>
	);
}
