import type {
	AssistantEntry,
	ModelSpec,
	TurnView,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type AssistantBrain, api, type SessionDetail } from "./api";
import { JobCard } from "./Chat";
import { usd } from "./format";
import { type I18n, useI18n } from "./i18n";
import { Lightbox, type LightboxItem } from "./Lightbox";
import { href, navigate } from "./route";

interface Props {
	sessionId?: string;
	addReference(assetId: string): void;
}

/** What the assistant thinks with, in a few words. */
function brainName(i18n: I18n, brain: AssistantBrain): string {
	if (brain === "local") return i18n.t("assistant.brainLocal");
	const names = {
		openai: "OpenAI",
		google: "Google Gemini",
		openrouter: "OpenRouter",
	};
	return brain ? i18n.t("assistant.brainCloud", { service: names[brain] }) : "";
}

/** The pictures a tool call made, as the session has them. */
function TurnResults(props: {
	turn: TurnView;
	models: Map<string, ModelSpec>;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
}) {
	const { turn } = props;
	return (
		<div
			className={`grid gap-3 ${turn.jobs.length > 1 ? "sm:grid-cols-2" : "max-w-md"}`}
		>
			{turn.jobs.map((job, index) => (
				<JobCard
					key={job.id}
					index={index}
					job={job}
					prompt={turn.prompt}
					model={props.models.get(job.modelId)}
					onOpen={props.onOpen}
					onUseAsReference={props.onUseAsReference}
				/>
			))}
		</div>
	);
}

/** A paid generation the assistant wants to make: the person decides. */
function Confirm(props: {
	entry: AssistantEntry;
	busy: boolean;
	onAnswer(approve: boolean): void;
}) {
	const i18n = useI18n();
	const { t } = i18n;
	const confirm = props.entry.confirm;
	if (!confirm) return null;
	const cost = usd(i18n, confirm.usd);
	const models = confirm.modelNames.join(", ");
	if (confirm.state === "declined") {
		return (
			<p className="text-sm text-dim">{t("assistant.declined", { models })}</p>
		);
	}
	if (confirm.state === "approved") {
		return (
			<p className="text-sm text-dim">
				{t("assistant.approved", { models, cost })}
			</p>
		);
	}
	return (
		<div className="rise-in max-w-xl rounded-lg border border-accent/50 bg-panel p-4">
			<p className="text-sm leading-relaxed">
				{t("assistant.confirm", { models, cost })}
			</p>
			<div className="mt-3 flex flex-wrap gap-2">
				<button
					type="button"
					disabled={props.busy}
					onClick={() => props.onAnswer(true)}
					className="aurora rounded-full px-4 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
				>
					{t("assistant.pay", { cost })}
				</button>
				<button
					type="button"
					disabled={props.busy}
					onClick={() => props.onAnswer(false)}
					className="rounded-full border border-line-strong px-4 py-1.5 text-sm text-dim hover:text-ink disabled:opacity-50"
				>
					{t("assistant.freeOnly")}
				</button>
			</div>
		</div>
	);
}

/** One entry of the conversation, as the person sees it. */
function Entry(props: {
	entry: AssistantEntry;
	turns: Map<string, TurnView>;
	models: Map<string, ModelSpec>;
	answering: boolean;
	onAnswer(entry: AssistantEntry, approve: boolean): void;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
}) {
	const i18n = useI18n();
	const { t } = i18n;
	const { entry } = props;
	const { message } = entry;
	if (entry.error) {
		return (
			<p className="rise-in text-sm leading-relaxed text-danger">
				{i18n.explain(entry.error)}
			</p>
		);
	}
	if (entry.note) {
		return (
			<p className="rise-in font-mono text-xs text-dim">
				{entry.note === "stopped"
					? t("assistant.stopped")
					: t("assistant.tooManySteps")}
			</p>
		);
	}
	if (message.role === "user") {
		const text = message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n");
		return (
			<p className="rise-in ml-auto max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-line px-4 py-2.5 leading-relaxed">
				{text}
			</p>
		);
	}
	if (message.role === "assistant") {
		if (!message.text) return null;
		return (
			<p className="rise-in max-w-2xl whitespace-pre-wrap leading-relaxed">
				{message.text}
			</p>
		);
	}
	if (entry.confirm) {
		return (
			<div className="flex flex-col gap-3">
				<Confirm
					entry={entry}
					busy={props.answering}
					onAnswer={(approve) => props.onAnswer(entry, approve)}
				/>
				{entry.turnId && props.turns.get(entry.turnId) && (
					<TurnResults
						turn={props.turns.get(entry.turnId) as TurnView}
						models={props.models}
						onOpen={props.onOpen}
						onUseAsReference={props.onUseAsReference}
					/>
				)}
			</div>
		);
	}
	const turn = entry.turnId ? props.turns.get(entry.turnId) : undefined;
	if (!turn) return null;
	return (
		<TurnResults
			turn={turn}
			models={props.models}
			onOpen={props.onOpen}
			onUseAsReference={props.onUseAsReference}
		/>
	);
}

/** The session as a conversation: the person asks, the assistant makes. */
export function Assistant({ sessionId, addReference }: Props) {
	const i18n = useI18n();
	const { t } = i18n;
	const client = useQueryClient();
	const [text, setText] = useState("");
	const [open, setOpen] = useState<LightboxItem | null>(null);
	const end = useRef<HTMLDivElement>(null);
	const brain = useQuery({
		queryKey: ["assistant-brain"],
		queryFn: api.assistant,
	});
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const view = useQuery({
		queryKey: ["assistant", sessionId],
		queryFn: () => api.assistantView(sessionId as string),
		enabled: sessionId != null,
	});
	const session = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => api.session(sessionId as string),
		enabled: sessionId != null,
	});

	const sendMessage = useMutation({
		mutationFn: (words: string) =>
			api.sendToAssistant({ sessionId, text: words, language: i18n.language }),
		onSuccess: ({ sessionId: id }) => {
			setText("");
			void client.invalidateQueries({ queryKey: ["assistant", id] });
			void client.invalidateQueries({ queryKey: ["sessions"] });
			if (!sessionId) navigate(href.talk(id));
		},
	});
	const stop = useMutation({
		mutationFn: () => api.stopAssistant(sessionId as string),
	});
	const answer = useMutation({
		mutationFn: (input: { entryId: string; approve: boolean }) =>
			api.answerAssistant(sessionId as string, {
				...input,
				language: i18n.language,
			}),
		onSettled: () =>
			client.invalidateQueries({ queryKey: ["assistant", sessionId] }),
	});

	const entries = view.data?.entries ?? [];
	const busy = view.data?.busy ?? false;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll as the conversation grows
	useEffect(() => {
		end.current?.scrollIntoView({ block: "end" });
	}, [entries.length, busy]);

	const byModel = new Map(models.data?.map((m) => [m.id, m]));
	const turns = new Map(
		(session.data as SessionDetail | undefined)?.turns.map((turn) => [
			turn.id,
			turn,
		]),
	);
	// A turn already shown with the call that made it is not shown twice.
	const working =
		view.data?.turnId &&
		!entries.some((entry) => entry.turnId === view.data?.turnId)
			? turns.get(view.data.turnId)
			: undefined;
	const thinking = busy && !working;
	const nothing = brain.data && brain.data.brain == null;
	const submit = () => {
		const words = text.trim();
		if (!words || busy || sendMessage.isPending) return;
		sendMessage.mutate(words);
	};
	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};
	const loadError = view.error ?? session.error;

	return (
		<>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
					{!sessionId && (
						<div className="rise-in py-12">
							<p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
								{t("assistant.eyebrow")}
							</p>
							<h1 className="mt-3 font-display text-5xl leading-[0.95] font-extrabold tracking-tight">
								{t("assistant.heading")}
							</h1>
							<p className="mt-4 max-w-xl leading-relaxed text-dim">
								{t("assistant.intro")}
							</p>
						</div>
					)}
					{loadError && (
						<p className="text-sm text-danger">{i18n.explain(loadError)}</p>
					)}
					{entries.map((entry) => (
						<Entry
							key={entry.id}
							entry={entry}
							turns={turns}
							models={byModel}
							// Until the view shows the answer, a second click would find nothing.
							answering={answer.isPending || busy || view.isFetching}
							onAnswer={(e, approve) =>
								answer.mutate({ entryId: e.id, approve })
							}
							onOpen={setOpen}
							onUseAsReference={addReference}
						/>
					))}
					{working && (
						<TurnResults
							turn={working}
							models={byModel}
							onOpen={setOpen}
							onUseAsReference={addReference}
						/>
					)}
					{thinking && (
						<p
							className="flex items-center gap-2 text-sm text-dim"
							aria-live="polite"
						>
							<i
								aria-hidden="true"
								className="breathe size-2 rounded-full bg-accent shadow-[0_0_10px_var(--accent)]"
							/>
							{t("assistant.thinking")}
						</p>
					)}
					{answer.error && (
						<p className="text-sm text-danger">{i18n.explain(answer.error)}</p>
					)}
					<div ref={end} />
				</div>
			</div>
			<div className="border-t border-line bg-panel p-4">
				<div className="mx-auto max-w-3xl">
					{nothing ? (
						<p className="text-sm leading-relaxed text-dim">
							{t("assistant.noBrain")}{" "}
							<a href={href.settings} className="text-ink underline">
								{t("nav.settings")}
							</a>
						</p>
					) : (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								submit();
							}}
							className="flex items-end gap-2"
						>
							<label className="min-w-0 flex-1">
								<span className="sr-only">{t("assistant.message")}</span>
								<textarea
									value={text}
									onChange={(event) => setText(event.target.value)}
									onKeyDown={onKey}
									rows={2}
									maxLength={4000}
									placeholder={t("assistant.placeholder")}
									className="w-full resize-none rounded-lg border border-line-strong bg-bg px-3 py-2 leading-relaxed outline-none focus:border-accent"
								/>
							</label>
							{busy ? (
								<button
									type="button"
									onClick={() => stop.mutate()}
									disabled={stop.isPending}
									className="rounded-full border border-line-strong px-4 py-2 text-sm text-ink hover:border-ink"
								>
									{t("assistant.stop")}
								</button>
							) : (
								<button
									type="submit"
									disabled={!text.trim() || sendMessage.isPending}
									className="aurora rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40"
								>
									{t("assistant.send")}
								</button>
							)}
						</form>
					)}
					{sendMessage.error && (
						<p className="mt-2 text-sm text-danger">
							{i18n.explain(sendMessage.error)}
						</p>
					)}
					<div className="mt-2 flex flex-wrap justify-between gap-2 font-mono text-[11px] text-dim">
						<span>{brainName(i18n, brain.data?.brain ?? null)}</span>
						{view.data && (
							<span>
								{t("assistant.spent", {
									spent: usd(i18n, view.data.spentUsd),
									limit: usd(i18n, view.data.limitUsd),
								})}
							</span>
						)}
					</div>
				</div>
			</div>
			{open && (
				<Lightbox
					item={open}
					onClose={() => setOpen(null)}
					onUseAsReference={(id) => {
						addReference(id);
						setOpen(null);
					}}
				/>
			)}
		</>
	);
}
