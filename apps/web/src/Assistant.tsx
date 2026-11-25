import type {
	AssistantEntry,
	ModelSpec,
	TurnView,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Square } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
	ChatContainerContent,
	ChatContainerRoot,
} from "@/components/chat/chat-container";
import { Message, MessageContent } from "@/components/chat/message";
import {
	PromptInput,
	PromptInputActions,
	PromptInputTextarea,
} from "@/components/chat/prompt-input";
import { ScrollButton } from "@/components/chat/scroll-button";
import { Mark } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type AssistantBrain, api, type SessionDetail } from "./api";
import { JobCard, useComparison } from "./Chat";
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

/**
 * A line from the assistant's side of the conversation. Replies carry the
 * mark beside them; what follows a reply lines up with its text.
 */
function AssistantRow(props: { mark?: boolean; children: ReactNode }) {
	return (
		<Message className="rise-in gap-3.5">
			<div
				aria-hidden="true"
				className={cn(
					"grid size-8 shrink-0 place-items-center rounded-[10px] max-md:hidden",
					props.mark && "border border-line bg-panel",
				)}
			>
				{props.mark && <Mark crack="var(--panel)" className="h-[18px]" />}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-3.5">
				{props.children}
			</div>
		</Message>
	);
}

/** The pictures a tool call made, as the session has them. */
function TurnResults(props: {
	turn: TurnView;
	models: Map<string, ModelSpec>;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
}) {
	const { turn } = props;
	const i18n = useI18n();
	const comparison = useComparison(turn, props.models);
	return (
		<>
			<div
				className={cn(
					"grid gap-3.5",
					turn.jobs.length > 1 ? "grid-cols-2" : "max-w-xl",
				)}
			>
				{comparison.jobs.map((job, index) => (
					<JobCard
						key={job.id}
						index={index}
						job={job}
						prompt={turn.prompt}
						model={props.models.get(job.modelId)}
						onOpen={props.onOpen}
						onUseAsReference={props.onUseAsReference}
						compare={comparison.of(job, index)}
					/>
				))}
			</div>
			{comparison.error != null && (
				<p className="text-sm text-danger">{i18n.explain(comparison.error)}</p>
			)}
		</>
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
		<div className="flex max-w-xl flex-col gap-3 rounded-[18px] border border-line-strong bg-panel p-4">
			<p className="leading-relaxed">
				{t("assistant.confirm", { models, cost })}
			</p>
			<div className="grid grid-cols-2 gap-2">
				<Button
					variant="aurora"
					disabled={props.busy}
					onClick={() => props.onAnswer(true)}
					className="h-11"
				>
					{t("assistant.pay", { cost })}
				</Button>
				<Button
					variant="outline"
					disabled={props.busy}
					onClick={() => props.onAnswer(false)}
					className="h-11"
				>
					{t("assistant.freeOnly")}
				</Button>
			</div>
		</div>
	);
}

/** A pill with a short answer or idea, sent as the person's message. */
const CHIP =
	"h-auto min-h-10 rounded-full border-line-strong bg-panel px-4 py-2 text-left font-normal whitespace-normal hover:border-gold/60";

/** What the assistant asked before making a picture, with answers to pick. */
function Question(props: {
	entry: AssistantEntry;
	busy: boolean;
	onPick(answer: string): void;
}) {
	const { t } = useI18n();
	const question = props.entry.question;
	if (!question) return null;
	const open = question.state === "asked";
	return (
		<div className="flex max-w-xl flex-col gap-3">
			<MessageContent className="pt-1 text-[#e4e4e7]">
				{question.text}
			</MessageContent>
			{open && question.options.length > 0 && (
				<ul
					aria-label={t("assistant.answers")}
					className="flex flex-wrap gap-2"
				>
					{question.options.map((option) => (
						<li key={option}>
							<Button
								variant="outline"
								disabled={props.busy}
								onClick={() => props.onPick(option)}
								className={CHIP}
							>
								{option}
							</Button>
						</li>
					))}
				</ul>
			)}
			{open && <p className="text-xs text-dim">{t("assistant.orWrite")}</p>}
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
	onPick(answer: string): void;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
}) {
	const i18n = useI18n();
	const { t } = i18n;
	const { entry } = props;
	const { message } = entry;
	if (entry.error) {
		return (
			<AssistantRow>
				<p className="text-sm leading-relaxed text-danger">
					{i18n.explain(entry.error)}
				</p>
			</AssistantRow>
		);
	}
	if (entry.note) {
		return (
			<AssistantRow>
				<p className="font-mono text-xs text-dim">
					{entry.note === "stopped"
						? t("assistant.stopped")
						: t("assistant.tooManySteps")}
				</p>
			</AssistantRow>
		);
	}
	if (message.role === "user") {
		const text = message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n");
		return (
			<Message className="rise-in justify-end">
				<p className="max-w-[82%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-md border border-line bg-panel-2 px-4 py-2.5 leading-relaxed md:max-w-[70%] md:rounded-[20px] md:rounded-br-md md:px-[18px] md:py-3">
					{text}
				</p>
			</Message>
		);
	}
	if (message.role === "assistant") {
		if (!message.text) return null;
		return (
			<AssistantRow mark>
				<MessageContent className="pt-1 text-[#e4e4e7]">
					{message.text}
				</MessageContent>
			</AssistantRow>
		);
	}
	const turn = entry.turnId ? props.turns.get(entry.turnId) : undefined;
	if (entry.question) {
		return (
			<AssistantRow mark>
				<Question entry={entry} busy={props.answering} onPick={props.onPick} />
			</AssistantRow>
		);
	}
	if (entry.confirm) {
		return (
			<AssistantRow>
				<Confirm
					entry={entry}
					busy={props.answering}
					onAnswer={(approve) => props.onAnswer(entry, approve)}
				/>
				{turn && (
					<TurnResults
						turn={turn}
						models={props.models}
						onOpen={props.onOpen}
						onUseAsReference={props.onUseAsReference}
					/>
				)}
			</AssistantRow>
		);
	}
	if (!turn) return null;
	return (
		<AssistantRow>
			<TurnResults
				turn={turn}
				models={props.models}
				onOpen={props.onOpen}
				onUseAsReference={props.onUseAsReference}
			/>
		</AssistantRow>
	);
}

/** The session as a conversation: the person asks, the assistant makes. */
export function Assistant({ sessionId, addReference }: Props) {
	const i18n = useI18n();
	const { t } = i18n;
	const client = useQueryClient();
	const inputId = useId();
	const [text, setText] = useState("");
	const [open, setOpen] = useState<LightboxItem | null>(null);
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
	const brainLabel = brainName(i18n, brain.data?.brain ?? null);
	const submit = () => {
		const words = text.trim();
		if (!words || busy || sendMessage.isPending) return;
		sendMessage.mutate(words);
	};
	const loadError = view.error ?? session.error;
	// Open ideas, so the assistant asks what it needs before the picture.
	const starters = [
		t("assistant.starter.poster"),
		t("assistant.starter.pet"),
		t("assistant.starter.room"),
		t("assistant.starter.logo"),
	];

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-[radial-gradient(60%_40%_at_70%_-10%,rgb(255_61_139/0.10),transparent_70%)]">
			<ChatContainerRoot className="relative min-h-0 flex-1 overflow-hidden">
				<ChatContainerContent className="mx-auto max-w-[780px] gap-[18px] px-4 py-5 md:gap-7 md:px-10 md:py-9">
					{!sessionId && (
						<div className="rise-in flex flex-col items-start gap-4 py-10 md:py-16">
							<Mark className="h-12" />
							<p className="font-mono text-[11px] tracking-[0.18em] text-dim uppercase">
								{t("assistant.eyebrow")}
							</p>
							<h1 className="font-display text-[44px] leading-[0.95] font-extrabold tracking-[-0.03em] text-balance md:text-6xl">
								{t("assistant.heading")}
							</h1>
							<p className="max-w-xl text-[17px] leading-relaxed text-soft">
								{t("assistant.intro")}
							</p>
							{brain.data?.brain && (
								<div className="flex flex-col gap-2.5 pt-2">
									<p className="font-mono text-[11px] tracking-[0.18em] text-dim uppercase">
										{t("assistant.starters")}
									</p>
									<ul className="flex flex-wrap gap-2">
										{starters.map((idea) => (
											<li key={idea}>
												<Button
													variant="outline"
													disabled={sendMessage.isPending}
													onClick={() => sendMessage.mutate(idea)}
													className={CHIP}
												>
													{idea}
												</Button>
											</li>
										))}
									</ul>
								</div>
							)}
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
							onPick={(words) => {
								if (!sendMessage.isPending) sendMessage.mutate(words);
							}}
							onOpen={setOpen}
							onUseAsReference={addReference}
						/>
					))}
					{working && (
						<AssistantRow>
							<TurnResults
								turn={working}
								models={byModel}
								onOpen={setOpen}
								onUseAsReference={addReference}
							/>
						</AssistantRow>
					)}
					{thinking && (
						<AssistantRow>
							<p
								className="flex items-center gap-2.5 pt-1.5 text-sm text-dim"
								aria-live="polite"
							>
								<i
									aria-hidden="true"
									className="breathe size-2 rounded-full bg-orange shadow-[0_0_12px_var(--orange)]"
								/>
								{t("assistant.thinking")}
							</p>
						</AssistantRow>
					)}
					{answer.error && (
						<p className="text-sm text-danger">{i18n.explain(answer.error)}</p>
					)}
				</ChatContainerContent>
				<div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
					<ScrollButton
						aria-label={t("assistant.latest")}
						className="pointer-events-auto border-line-strong bg-panel-2 shadow-lg dark:bg-panel-2"
					/>
				</div>
			</ChatContainerRoot>
			<div className="shrink-0 px-3 pt-2 pb-2.5 md:px-10 md:pt-4 md:pb-6">
				<div className="mx-auto flex max-w-[780px] flex-col gap-2.5">
					{nothing ? (
						<p className="rounded-[18px] border border-line bg-panel p-4 text-sm leading-relaxed text-soft">
							{t("assistant.noBrain")}{" "}
							<a
								href={href.settings}
								className="rounded-sm text-gold underline decoration-gold/40 underline-offset-2 outline-none hover:decoration-gold focus-visible:ring-3 focus-visible:ring-ring/50"
							>
								{t("nav.settings")}
							</a>
						</p>
					) : (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								submit();
							}}
						>
							<PromptInput
								value={text}
								onValueChange={setText}
								onSubmit={submit}
								isLoading={busy}
								className="flex flex-col gap-2.5 pl-4 shadow-[0_20px_60px_rgb(0_0_0/0.5)] md:pl-[18px]"
							>
								<label htmlFor={inputId} className="sr-only">
									{t("assistant.message")}
								</label>
								<PromptInputTextarea
									id={inputId}
									maxLength={4000}
									placeholder={t("assistant.placeholder")}
								/>
								<PromptInputActions className="justify-between gap-3">
									{brainLabel ? (
										<span className="inline-flex min-h-[30px] min-w-0 items-center gap-2 rounded-2xl bg-panel-2 px-3 py-1 font-mono text-xs leading-snug text-[#a1a1aa]">
											<i
												aria-hidden="true"
												className="size-1.5 shrink-0 rounded-full bg-good"
											/>
											{/* Wraps rather than cut: longer languages need two lines on phones. */}
											<span>{brainLabel}</span>
										</span>
									) : (
										<span />
									)}
									{busy ? (
										<Button
											type="button"
											variant="outline"
											onClick={(event) => {
												event.stopPropagation();
												stop.mutate();
											}}
											disabled={stop.isPending}
											className="h-10 gap-2"
										>
											<Square className="size-3.5 fill-current" />
											{t("assistant.stop")}
										</Button>
									) : (
										<Button
											type="submit"
											variant="aurora"
											size="icon"
											aria-label={t("assistant.send")}
											disabled={!text.trim() || sendMessage.isPending}
											onClick={(event) => event.stopPropagation()}
										>
											<ArrowUp className="size-[18px]" strokeWidth={2.4} />
										</Button>
									)}
								</PromptInputActions>
							</PromptInput>
						</form>
					)}
					{sendMessage.error && (
						<p className="text-sm text-danger">
							{i18n.explain(sendMessage.error)}
						</p>
					)}
					{view.data && (
						<p className="text-center font-mono text-xs text-dim">
							{t("assistant.spent", {
								spent: usd(i18n, view.data.spentUsd),
								limit: usd(i18n, view.data.limitUsd),
							})}
						</p>
					)}
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
		</div>
	);
}
