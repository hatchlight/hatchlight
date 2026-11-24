import type {
	Settings as Choices,
	ImproveWith,
	LocalModelStatus,
	ProviderStatus,
	TranslateWith,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type AgentPolicy, api, useServerMode } from "./api";
import { useI18n } from "./i18n";
import { useModelProgress } from "./live";

function ProviderRow({ provider }: { provider: ProviderStatus }) {
	const { t, explain } = useI18n();
	const client = useQueryClient();
	const [key, setKey] = useState("");
	const done = () => {
		setKey("");
		void client.invalidateQueries({ queryKey: ["assistant-brain"] });
		return client.invalidateQueries({ queryKey: ["providers"] });
	};
	const save = useMutation({
		mutationFn: () => api.setKey(provider.id, key),
		onSuccess: done,
	});
	const remove = useMutation({
		mutationFn: () => api.deleteKey(provider.id),
		onSuccess: done,
	});
	const error = save.error ?? remove.error;

	return (
		<li className="rounded-lg border border-line bg-panel p-4">
			<div className="flex items-baseline justify-between gap-4">
				<h3 className="font-medium">{provider.name}</h3>
				<span
					className={`font-mono text-xs ${provider.hasKey ? "text-accent" : "text-dim"}`}
				>
					{provider.hasKey
						? t("settings.keyConfigured")
						: provider.requiresKey
							? t("settings.noKey")
							: t("settings.noKeyNeeded")}
				</span>
			</div>
			{provider.requiresKey && (
				<form
					className="mt-3 flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<input
						type="password"
						value={key}
						onChange={(event) => setKey(event.target.value)}
						placeholder={
							provider.hasKey
								? t("settings.replaceKey")
								: t("settings.pasteKey")
						}
						aria-label={t("settings.keyLabel", { provider: provider.name })}
						autoComplete="off"
						className="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-sm"
					/>
					<button
						type="submit"
						disabled={!key.trim() || save.isPending}
						className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40"
					>
						{t("settings.save")}
					</button>
					{provider.hasKey && (
						<button
							type="button"
							onClick={() => remove.mutate()}
							disabled={remove.isPending}
							className="rounded-md border border-line px-3 py-2 text-sm text-dim hover:text-danger"
						>
							{t("settings.remove")}
						</button>
					)}
				</form>
			)}
			{error && <p className="mt-2 text-sm text-danger">{explain(error)}</p>}
		</li>
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
		<section className="mt-10">
			<h2 className="font-medium">{t("settings.translation")}</h2>
			<p className="mt-2 text-sm leading-relaxed text-dim">
				{t("settings.translationIntro")}
			</p>
			<fieldset className="mt-4">
				<legend className="text-sm font-medium">
					{t("settings.translateWith")}
				</legend>
				<div className="mt-2 flex flex-col gap-1.5">
					{options.map((option) => (
						<label
							key={option.value}
							className={`flex items-center gap-2 text-sm ${option.usable ? "" : "text-dim"}`}
						>
							<input
								type="radio"
								name="translate-with"
								value={option.value}
								checked={chosen === option.value}
								disabled={!option.usable || choose.isPending}
								onChange={() => choose.mutate({ translateWith: option.value })}
							/>
							{option.label}
							{!option.usable && (
								<span className="text-xs">
									{option.value === "local"
										? t("settings.translateLocalMissing")
										: t("settings.translateNoKey")}
								</span>
							)}
						</label>
					))}
				</div>
			</fieldset>
			<fieldset className="mt-4">
				<legend className="text-sm font-medium">
					{t("settings.improveWith")}
				</legend>
				<div className="mt-2 flex flex-col gap-1.5">
					{improveOptions.map((option) => (
						<label
							key={option.value}
							className={`flex items-center gap-2 text-sm ${option.usable ? "" : "text-dim"}`}
						>
							<input
								type="radio"
								name="improve-with"
								value={option.value}
								checked={improveChosen === option.value}
								disabled={!option.usable || choose.isPending}
								onChange={() => choose.mutate({ improveWith: option.value })}
							/>
							{option.label}
							{!option.usable && (
								<span className="text-xs">
									{option.value === "local"
										? t("settings.translateLocalMissing")
										: t("settings.translateNoKey")}
								</span>
							)}
						</label>
					))}
				</div>
			</fieldset>
			<fieldset className="mt-4">
				<legend className="text-sm font-medium">
					{t("settings.assistantWith")}
				</legend>
				<div className="mt-2 flex flex-col gap-1.5">
					{assistantOptions.map((option) => (
						<label
							key={option.value}
							className={`flex items-center gap-2 text-sm ${option.usable ? "" : "text-dim"}`}
						>
							<input
								type="radio"
								name="assistant-with"
								value={option.value}
								checked={assistantChosen === option.value}
								disabled={!option.usable || choose.isPending}
								onChange={() => choose.mutate({ assistantWith: option.value })}
							/>
							{option.label}
							{!option.usable && (
								<span className="text-xs">
									{option.value === "local"
										? t("settings.translateLocalMissing")
										: t("settings.translateNoKey")}
								</span>
							)}
						</label>
					))}
				</div>
			</fieldset>
			{choose.error && (
				<p className="mt-2 text-sm text-danger">{explain(choose.error)}</p>
			)}
			<HelperModel
				model={model}
				label={t("settings.translation")}
				on={t("settings.translationOn")}
				off={t("settings.translationOff")}
				install={(size) => t("settings.translationInstall", { size })}
			/>
			{eyes && (
				<>
					<h3 className="mt-8 text-sm font-medium">{t("settings.eyes")}</h3>
					<p className="mt-2 text-sm leading-relaxed text-dim">
						{t("settings.eyesIntro")}
					</p>
					<HelperModel
						model={eyes}
						label={t("settings.eyes")}
						on={t("settings.eyesOn")}
						off={t("settings.eyesOff")}
						install={(size) => t("settings.eyesInstall", { size })}
					/>
				</>
			)}
		</section>
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
		<div className="mt-4 rounded-lg border border-line bg-panel p-4">
			<div className="flex items-baseline justify-between gap-4">
				<h3 className="font-medium">{model.name}</h3>
				<span
					className={`font-mono text-xs ${model.ready ? "text-accent" : "text-dim"}`}
				>
					{model.ready ? on : off}
				</span>
			</div>
			{busy ? (
				<div className="mt-3 flex items-center gap-3">
					<div
						role="progressbar"
						aria-label={label}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent}
						className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"
					>
						<div
							className="h-full rounded-full bg-accent transition-[width] duration-300"
							style={{ width: `${percent}%` }}
						/>
					</div>
					<span className="font-mono text-xs text-dim">
						{bytes(received)} / {bytes(size)}
					</span>
					<button
						type="button"
						onClick={() => cancel.mutate()}
						className="rounded-md border border-line px-3 py-1.5 text-sm text-dim hover:text-ink"
					>
						{t("common.cancel")}
					</button>
				</div>
			) : model.ready ? (
				<button
					type="button"
					onClick={() => remove.mutate()}
					disabled={remove.isPending}
					className="mt-3 rounded-md border border-line px-3 py-2 text-sm text-dim hover:text-danger"
				>
					{t("settings.remove")}
				</button>
			) : (
				<button
					type="button"
					onClick={() => install.mutate()}
					disabled={install.isPending}
					className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40"
				>
					{installText(bytes(size))}
				</button>
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
			<code className="min-w-0 flex-1 break-all rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs leading-relaxed">
				{text}
			</code>
			<button
				type="button"
				disabled={!text}
				onClick={() =>
					void navigator.clipboard?.writeText(text).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					})
				}
				className="rounded-md border border-line px-3 py-2 text-sm text-dim hover:text-ink"
			>
				{copied ? t("settings.agentsCopied") : t("settings.agentsCopy")}
			</button>
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
	const card = "rounded-lg border border-line bg-panel p-4";

	return (
		<section className="mt-10">
			<h2 className="font-medium">{t("settings.agents")}</h2>
			<p className="mt-2 text-sm leading-relaxed text-dim">
				{t("settings.agentsIntro")}
			</p>
			<div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={paid}
						onChange={(event) => setAllowPaid(event.target.checked)}
						className="accent-accent"
					/>
					{t("settings.agentsPaid")}
				</label>
				{paid && (
					<>
						<label className="flex items-center gap-2 text-dim">
							{t("settings.agentsLimit")}
							<input
								type="number"
								min={0}
								step={1}
								value={limitText}
								disabled={noLimit}
								onChange={(event) => setLimit(event.target.value)}
								aria-invalid={!validLimit}
								className="w-24 rounded-md border border-line bg-bg px-2 py-1 font-mono disabled:opacity-40"
							/>
							{!noLimit && validLimit && (
								<span className="text-xs">
									{number(limitUsd, { style: "currency", currency: "USD" })}
								</span>
							)}
						</label>
						<label className="flex items-center gap-2 text-dim">
							<input
								type="checkbox"
								checked={noLimit}
								onChange={(event) => setUnlimited(event.target.checked)}
								className="accent-accent"
							/>
							{t("settings.agentsNoLimit")}
						</label>
					</>
				)}
			</div>

			<div className={`${card} mt-4`}>
				<div className="flex items-baseline justify-between gap-4">
					<h3 className="font-medium">Claude Desktop</h3>
					<span
						className={`font-mono text-xs ${desktop?.connected ? "text-accent" : "text-dim"}`}
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
							<button
								type="button"
								onClick={() => connect.mutate()}
								disabled={connect.isPending || !validLimit}
								className="cta rounded-lg px-4 py-2 text-sm font-medium"
							>
								{desktop.connected
									? t("settings.agentsUpdate")
									: t("settings.agentsConnect")}
							</button>
						)}
						{desktop.connected && (
							<button
								type="button"
								onClick={() => disconnect.mutate()}
								disabled={disconnect.isPending}
								className="rounded-md border border-line px-3 py-2 text-sm text-dim hover:text-danger"
							>
								{t("settings.agentsDisconnect")}
							</button>
						)}
					</div>
				)}
				{restart && (
					<p className="mt-2 text-sm text-dim" role="status">
						{t("settings.agentsRestart")}
					</p>
				)}
			</div>

			<div className={`${card} mt-3`}>
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
			{error && <p className="mt-2 text-sm text-danger">{explain(error)}</p>}
		</section>
	);
}

export function Settings() {
	const { t, explain, language, setLanguage, languages } = useI18n();
	// Agents are set up on the machine that runs Hatchlight.
	const server = useServerMode();
	const providers = useQuery({
		queryKey: ["providers"],
		queryFn: api.providers,
	});
	return (
		<div className="mx-auto w-full max-w-2xl overflow-y-auto p-8">
			<h1 className="font-display text-4xl leading-none font-extrabold tracking-tight">
				{t("settings.title")}
			</h1>
			<section className="mt-6">
				<h2 className="font-medium">{t("settings.language")}</h2>
				<select
					value={language}
					onChange={(event) => setLanguage(event.target.value)}
					aria-label={t("settings.language")}
					className="mt-3 rounded-md border border-line bg-panel px-3 py-2 text-sm"
				>
					{languages.map((option) => (
						<option key={option.code} value={option.code} lang={option.code}>
							{option.name}
						</option>
					))}
				</select>
			</section>
			<Translation />
			<h2 className="mt-10 font-medium">{t("settings.providers")}</h2>
			<p className="mt-2 text-sm leading-relaxed text-dim">
				{t("settings.providersIntro")}
			</p>
			{providers.error && (
				<p className="mt-6 text-sm text-danger">{explain(providers.error)}</p>
			)}
			<ul className="mt-6 flex flex-col gap-3">
				{providers.data?.map((provider) => (
					<ProviderRow key={provider.id} provider={provider} />
				))}
			</ul>
			{!server && <Agents />}
		</div>
	);
}
