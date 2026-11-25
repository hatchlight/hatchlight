import {
	type ChatMessage,
	type ChatModel,
	type ChatPart,
	CodedError,
	type Eyes,
	NotFoundError,
	newId,
	type ToolCall,
	type ToolSpec,
	ValidationError,
} from "@hatchlight/core";
import type {
	AssistantEntry,
	AssistantEntryBody,
	AssistantView,
	ModelSpec,
	UserContext,
} from "@hatchlight/core/types";
import { z } from "zod";
import type { Reel } from "./reel";
import { estimate, isLocal, SpendGuard } from "./spend";
import {
	createTools,
	shrinkPicture,
	TOOLS_INSTRUCTIONS,
	type Tool,
	type ToolImage,
	type ToolResult,
} from "./tools";

/**
 * The assistant inside the app: a language model that makes and changes
 * pictures for a person by talking with them, through the same tools an
 * agent outside uses. Each session holds one conversation, kept with it.
 * Models on this computer are used freely; a paid one waits for the
 * person's yes, within a limit per conversation.
 */

export interface AssistantStore {
	add(ctx: UserContext, entry: AssistantEntry): Promise<void>;
	update(ctx: UserContext, id: string, body: AssistantEntryBody): Promise<void>;
	list(ctx: UserContext, sessionId: string): Promise<AssistantEntry[]>;
}

export interface AssistantOptions {
	store: AssistantStore;
	/** Hatchlight as a person sees it. */
	reel(ctx: UserContext): Reel;
	/** What the person's assistant thinks with, or null when nothing can. */
	brain(ctx: UserContext): Promise<ChatModel | null>;
	/**
	 * Looks at what was made for a brain that cannot see, when a model that
	 * sees is installed.
	 */
	eyes?(ctx: UserContext): Promise<Eyes | null>;
	/** An empty session, for a conversation that starts with words. */
	startSession(ctx: UserContext, title: string): Promise<{ id: string }>;
	/** What paid models may cost in one conversation. */
	limitUsd?: number;
	/** Model turns for one message of the person, so a loop cannot run on. */
	maxSteps?: number;
	waitMs?: number;
	pollMs?: number;
}

export interface AssistantEvent {
	type: "assistant.changed";
	sessionId: string;
}

/** The person's message, or their answer to a paid generation. */
export interface SendInput {
	/** Without one, a new session is started. */
	sessionId?: string;
	text: string;
	/** The language the person reads, such as "pt-BR". */
	language?: string;
}

export const DEFAULT_LIMIT_USD = 2;
const DEFAULT_MAX_STEPS = 12;
/** Tools that work in a session: always the conversation's. */
const IN_SESSION = new Set(["generate", "upscale", "job_status"]);

interface Work {
	controller: AbortController;
	turnId: string | null;
}

/** What the language model is told before the conversation. */
export function assistantInstructions(language?: string): string {
	let reader = "the language the person writes in";
	if (language) {
		try {
			reader =
				new Intl.DisplayNames(["en"], { type: "language" }).of(language) ??
				language;
		} catch {
			reader = language;
		}
	}
	return [
		"You are the assistant inside Hatchlight, an app that makes pictures and videos. The person talks with you to make pictures and change them; you do it with the tools.",
		`- Always write to the person in ${reader}. Keep it short: a sentence or two. Do not describe a picture you have not seen.`,
		"- Write each prompt for generate in English, as a full description of the picture: subject, setting, light, style. To change a picture, describe the whole new picture, not only the change.",
		"- To change a picture made before, give its id (ast_…) in reference_images when the model can redraw pictures; otherwise make it again with a new prompt.",
		"- Leave models out unless the person names one: the best free model on this computer is used. Use paid models only when the person asks; they are asked to approve the cost.",
		"- Call list_models when the person asks what can be used, or names a model you do not know.",
		"- The pictures you make appear to the person on their own: do not repeat their ids or links.",
		"- When you can see the results, look before you answer: say in one sentence whether they match what was asked, and if something is clearly off (cut off, wrong count, misspelled text, wrong colors) offer one concrete fix as a question. Do not make it again unasked.",
		"- To change a picture you made, start from it: give its id in reference_images, with a model that edits or redraws pictures, rather than making a new one from words.",
		'- To keep the same person or character in a new picture ("the same girl, now sitting"), give a picture of them in reference_images to a model that follows given pictures, and name them in the prompt as "the person in picture 1", then describe the whole new scene.',
		'- To follow the pose, outlines or depth of a picture ("in this pose", "keep this layout"), give it as guide_image with guide_kind, to a model that follows a guide picture. When the picture already is a skeleton, edge drawing or depth map, set guide_is_map.',
		"- When several models made the same prompt, say which result fits the request best and why, in a sentence.",
		TOOLS_INSTRUCTIONS,
	].join("\n");
}

/** A tool as the language model is told about it, without the session. */
export function toolSpec(tool: Tool): ToolSpec {
	const schema = z.toJSONSchema(z.object(tool.input)) as {
		properties?: Record<string, unknown>;
		required?: string[];
	} & Record<string, unknown>;
	if (schema.properties) delete schema.properties.session_id;
	if (schema.required) {
		schema.required = schema.required.filter((key) => key !== "session_id");
	}
	delete schema.$schema;
	return {
		name: tool.name,
		description: tool.description,
		parameters: schema,
	};
}

/**
 * What the language model sees of the kept entries. Notes and errors are for
 * the person; a call that never got its result (stopped, or answered no)
 * gets one, as every service requires.
 */
export function conversation(entries: AssistantEntry[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	let open: ToolCall[] = [];
	const close = () => {
		for (const call of open) {
			out.push({
				role: "tool",
				callId: call.id,
				name: call.name,
				content: [
					{ type: "text", text: "Stopped by the person before it ran." },
				],
			});
		}
		open = [];
	};
	for (const entry of entries) {
		if (entry.error || entry.note) continue;
		const { message } = entry;
		if (message.role === "tool") {
			open = open.filter((call) => call.id !== message.callId);
			out.push(message);
			continue;
		}
		close();
		if (message.role === "assistant") {
			if (!message.text && message.toolCalls.length === 0) continue;
			open = [...message.toolCalls];
		}
		out.push(message);
	}
	close();
	return out;
}

/**
 * The latest part of a conversation that fits a model's context, starting
 * at something the person said, so no result is left without its call.
 */
export function fit(
	messages: ChatMessage[],
	chars: number | undefined,
): ChatMessage[] {
	if (chars == null) return messages;
	const size = (m: ChatMessage) => JSON.stringify(m).length;
	let total = messages.reduce((sum, m) => sum + size(m), 0);
	let start = 0;
	while (total > chars && start < messages.length - 1) {
		total -= size(messages[start] as ChatMessage);
		start++;
		while (start < messages.length - 1 && messages[start]?.role !== "user") {
			total -= size(messages[start] as ChatMessage);
			start++;
		}
	}
	return messages.slice(start);
}

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** What a tool's result says to the language model. */
function resultMessage(
	call: { id: string; name: string },
	result: ToolResult,
	vision: boolean,
): Extract<ChatMessage, { role: "tool" }> {
	const content: ChatPart[] = [
		{
			type: "text",
			text: result.isError ? `Error: ${result.text}` : result.text,
		},
	];
	if (vision) content.push(...pictureParts(result.images));
	return { role: "tool", callId: call.id, name: call.name, content };
}

/** Pictures for the model, each said what it is first. */
function pictureParts(images: ToolImage[]): ChatPart[] {
	return images.flatMap(({ label, data, mimeType }) => [
		...(label ? [{ type: "text" as const, text: label }] : []),
		{ type: "image" as const, data, mimeType },
	]);
}

/** Recent results shown again, so a model that sees can talk about them. */
const SEEN_TURNS = 2;
const SEEN_PICTURES = 8;

/** Kept without pictures: they are large, and the turn holds them. */
const withoutPictures = (message: ChatMessage): ChatMessage =>
	message.role === "assistant"
		? message
		: {
				...message,
				content: message.content.filter((part) => part.type === "text"),
			};

/** Words too common in model names to say which model a person meant. */
const COMMON_WORDS = new Set([
	"base",
	"image",
	"lightning",
	"local",
	"model",
	"turbo",
	"video",
]);

/** Whether a person's words name a model: by its id, its name or a word of it. */
export function namesModel(words: string, model: ModelSpec): boolean {
	const said = words.toLowerCase();
	const name = model.name.toLowerCase();
	const tail = model.id.slice(model.id.indexOf("/") + 1).toLowerCase();
	const long = (word: string) => word.length >= 3;
	if (
		(long(name) && said.includes(name)) ||
		(long(tail) && said.includes(tail))
	)
		return true;
	const own = `${name} ${tail} ${model.providerId}`
		.split(/[^\p{L}\p{N}]+/u)
		.filter(
			(word) =>
				(long(word) || word === name || word === tail) &&
				!COMMON_WORDS.has(word),
		);
	const spoken = new Set(said.split(/[^\p{L}\p{N}]+/u));
	return own.some((word) => spoken.has(word));
}

/**
 * The models a generate call keeps: the ones the person named, or all of
 * them when the person asked to compare. Small language models tend to
 * pick several models nobody asked for, and each one makes the person
 * wait; without a named one, the tool picks the best free model.
 */
export function keptModels(
	call: ToolCall,
	words: string,
	models: ModelSpec[],
): ToolCall {
	const asked = call.arguments.models;
	if (call.name !== "generate" || !Array.isArray(asked)) return call;
	if (/compar/i.test(words)) return call;
	const named = asked.filter((id) => {
		const model = models.find((m) => m.id === id);
		// An id the person typed, even an unknown one, is theirs to keep.
		return model ? namesModel(words, model) : words.includes(String(id));
	});
	const { models: _, ...rest } = call.arguments;
	return {
		...call,
		arguments: named.length > 0 ? { ...rest, models: named } : rest,
	};
}

/** An entry without what identifies it, to write it back changed. */
function bodyOf(entry: AssistantEntry): AssistantEntryBody {
	const { id, sessionId, createdAt, ...body } = entry;
	return body;
}

export class Assistant {
	private working = new Map<string, Work>();
	private guards = new Map<string, SpendGuard>();
	private listeners = new Set<
		(userId: string, event: AssistantEvent) => void
	>();
	private limitUsd: number;
	private maxSteps: number;
	private closed = false;

	constructor(private options: AssistantOptions) {
		this.limitUsd = options.limitUsd ?? DEFAULT_LIMIT_USD;
		this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
	}

	subscribe(
		listener: (userId: string, event: AssistantEvent) => void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async view(ctx: UserContext, sessionId: string): Promise<AssistantView> {
		const entries = await this.store.list(ctx, sessionId);
		const guard = await this.guard(ctx, sessionId, entries);
		// Turns no tool waited for to the end (stopped, or still running then)
		// are counted once they end.
		const held = guard.heldKeys();
		if (held.length > 0) {
			const detail = await this.options.reel(ctx).session(sessionId);
			for (const turn of detail.turns) {
				if (held.includes(turn.id)) guard.settle(turn);
			}
		}
		const work = this.working.get(this.key(ctx, sessionId));
		return {
			entries,
			busy: work != null,
			turnId: work?.turnId ?? null,
			spentUsd: guard.committed(),
			limitUsd: this.limitUsd,
		};
	}

	/** Takes the person's message and starts answering it. */
	async send(
		ctx: UserContext,
		input: SendInput,
	): Promise<{ sessionId: string }> {
		const text = input.text.trim();
		if (!text) throw new ValidationError("Write something first");
		const brain = await this.needBrain(ctx);
		const sessionId =
			input.sessionId ?? (await this.options.startSession(ctx, text)).id;
		if (input.sessionId) await this.options.reel(ctx).session(sessionId);
		const work = this.claim(ctx, sessionId);
		try {
			const entries = await this.store.list(ctx, sessionId);
			// Paid generations still waiting: the person moved on.
			for (const entry of entries) {
				if (entry.confirm?.state === "asked") {
					await this.decide(
						ctx,
						entry,
						"The person wrote again instead of approving; nothing was made.",
					);
				}
			}
			await this.add(ctx, sessionId, {
				message: { role: "user", content: [{ type: "text", text }] },
			});
		} catch (error) {
			this.release(ctx, sessionId);
			throw error;
		}
		this.run(ctx, sessionId, work, brain, input.language);
		return { sessionId };
	}

	/** The person's yes or no to a paid generation the assistant asked for. */
	async answer(
		ctx: UserContext,
		sessionId: string,
		entryId: string,
		approve: boolean,
		language?: string,
	): Promise<void> {
		const work = this.claim(ctx, sessionId);
		let entry: AssistantEntry;
		let brain: ChatModel | null;
		let othersWaiting: boolean;
		try {
			const entries = await this.store.list(ctx, sessionId);
			const found = entries.find((e) => e.id === entryId);
			if (found?.confirm?.state !== "asked") {
				throw new NotFoundError(
					"Nothing is waiting for an answer there",
					"confirmNotWaiting",
				);
			}
			entry = found;
			othersWaiting = entries.some(
				(e) => e.id !== entryId && e.confirm?.state === "asked",
			);
			// Needed only when the model is asked to go on.
			brain = othersWaiting
				? null
				: approve
					? await this.needBrain(ctx)
					: await this.options.brain(ctx);
			if (!approve) {
				await this.decide(
					ctx,
					entry,
					"The person said no to the cost; nothing was made. Do not use paid models again unless they ask.",
				);
			}
		} catch (error) {
			this.release(ctx, sessionId);
			throw error;
		}
		// The model goes on once nothing waits for the person any more.
		const next = othersWaiting ? null : brain;
		if (!approve && !next) {
			this.release(ctx, sessionId);
			return;
		}
		this.run(
			ctx,
			sessionId,
			work,
			next,
			language,
			approve
				? (tools, guard) => this.approved(ctx, work, tools, guard, entry)
				: undefined,
		);
	}

	/** Runs a paid generation the person said yes to. */
	private async approved(
		ctx: UserContext,
		work: Work,
		tools: Tool[],
		guard: SpendGuard,
		entry: AssistantEntry,
	) {
		const { confirm, message } = entry;
		if (!confirm || message.role !== "tool") return;
		const call = {
			id: message.callId,
			name: message.name,
			arguments: confirm.arguments,
		};
		if (work.controller.signal.aborted) {
			await this.decide(ctx, entry, "Stopped before it ran; nothing was made.");
			return;
		}
		// What runs must be what the person said yes to.
		const now = await this.paidCost(this.options.reel(ctx), call, guard);
		if (
			now &&
			(now.names.join("\n") !== confirm.modelNames.join("\n") ||
				now.usd > confirm.usd + 1e-9)
		) {
			await this.decide(
				ctx,
				entry,
				"The models or the price changed after the person said yes; nothing was made. Ask again.",
			);
			return;
		}
		const body = bodyOf(entry);
		const yes = { ...confirm, state: "approved" as const };
		await this.store.update(ctx, entry.id, { ...body, confirm: yes });
		this.changed(ctx, entry.sessionId);
		const result = await this.call(
			ctx,
			entry.sessionId,
			work,
			tools,
			call,
			(turnId) =>
				this.store.update(ctx, entry.id, {
					...body,
					confirm: yes,
					turnId,
				}),
		);
		await this.store.update(ctx, entry.id, {
			...body,
			confirm: yes,
			message: withoutPictures(resultMessage(call, result, false)),
			...(result.turnId && { turnId: result.turnId }),
		});
		this.changed(ctx, entry.sessionId);
	}

	/** A session is gone: its work stops and its spending is forgotten. */
	forget(ctx: UserContext, sessionId: string): void {
		this.stop(ctx, sessionId);
		this.guards.delete(this.key(ctx, sessionId));
	}

	/**
	 * Stops all work, for good: the process is closing. What is under way
	 * ends without touching the store, which may be closed next.
	 */
	close(): void {
		this.closed = true;
		for (const work of this.working.values()) work.controller.abort();
	}

	/** Where conversations are kept, until the assistant is closed. */
	private get store(): AssistantStore {
		if (this.closed) throw new Error("The assistant is closed");
		return this.options.store;
	}

	/** Stops the assistant's work on a conversation; what it made stays. */
	stop(ctx: UserContext, sessionId: string): void {
		this.working.get(this.key(ctx, sessionId))?.controller.abort();
	}

	private key(ctx: UserContext, sessionId: string) {
		return `${ctx.userId}\n${sessionId}`;
	}

	private claim(ctx: UserContext, sessionId: string): Work {
		const key = this.key(ctx, sessionId);
		if (this.working.has(key)) {
			throw new ValidationError(
				"The assistant is still working on this conversation",
				"assistantBusy",
			);
		}
		const work: Work = { controller: new AbortController(), turnId: null };
		this.working.set(key, work);
		this.changed(ctx, sessionId);
		return work;
	}

	private release(ctx: UserContext, sessionId: string) {
		this.working.delete(this.key(ctx, sessionId));
		this.changed(ctx, sessionId);
	}

	private changed(ctx: UserContext, sessionId: string) {
		for (const listener of this.listeners) {
			listener(ctx.userId, { type: "assistant.changed", sessionId });
		}
	}

	private async needBrain(ctx: UserContext): Promise<ChatModel> {
		const brain = await this.options.brain(ctx);
		if (!brain) {
			throw new ValidationError(
				"No language model to think with: install the one for this computer or add a key",
				"noLanguageModel",
			);
		}
		return brain;
	}

	/** The conversation's spending, with what its earlier turns cost. */
	private async guard(
		ctx: UserContext,
		sessionId: string,
		entries: AssistantEntry[],
	): Promise<SpendGuard> {
		const key = this.key(ctx, sessionId);
		const known = this.guards.get(key);
		if (known) return known;
		const turns = new Set(entries.flatMap((e) => (e.turnId ? [e.turnId] : [])));
		let spent = 0;
		if (turns.size > 0) {
			const detail = await this.options.reel(ctx).session(sessionId);
			for (const turn of detail.turns) {
				if (!turns.has(turn.id)) continue;
				for (const job of turn.jobs) {
					if (job.providerId !== "local") spent += job.costUsd ?? 0;
				}
			}
		}
		const guard = this.guards.get(key) ?? new SpendGuard(this.limitUsd, spent);
		this.guards.set(key, guard);
		return guard;
	}

	private async add(
		ctx: UserContext,
		sessionId: string,
		body: AssistantEntryBody,
	): Promise<AssistantEntry> {
		const entry: AssistantEntry = {
			...body,
			message: withoutPictures(body.message),
			id: newId("msg"),
			sessionId,
			createdAt: Date.now(),
		};
		await this.store.add(ctx, entry);
		this.changed(ctx, sessionId);
		return entry;
	}

	/** Says no to a paid generation that was waiting, telling the model why. */
	private async decide(ctx: UserContext, entry: AssistantEntry, text: string) {
		if (!entry.confirm || entry.message.role !== "tool") return;
		await this.store.update(ctx, entry.id, {
			...bodyOf(entry),
			confirm: { ...entry.confirm, state: "declined" },
			message: { ...entry.message, content: [{ type: "text", text }] },
		});
		this.changed(ctx, entry.sessionId);
	}

	/** Runs the work in the background; the conversation is busy meanwhile. */
	private run(
		ctx: UserContext,
		sessionId: string,
		work: Work,
		brain: ChatModel | null,
		language: string | undefined,
		/** Runs first, before the model is asked. */
		before?: (tools: Tool[], guard: SpendGuard) => Promise<void>,
	) {
		void this.loop(ctx, sessionId, work, brain, language, before)
			// Once closed, what fails is the closing itself.
			.catch((error) => {
				if (!this.closed) console.error(error);
			})
			.finally(() => this.release(ctx, sessionId));
	}

	private async loop(
		ctx: UserContext,
		sessionId: string,
		work: Work,
		brain: ChatModel | null,
		language: string | undefined,
		before?: (tools: Tool[], guard: SpendGuard) => Promise<void>,
	) {
		const { signal } = work.controller;
		const reel = this.options.reel(ctx);
		const say = async (body: Omit<AssistantEntryBody, "message">) => {
			await this.add(ctx, sessionId, {
				message: { role: "assistant", text: "", toolCalls: [] },
				...body,
			});
		};
		try {
			const entries = await this.store.list(ctx, sessionId);
			const guard = await this.guard(ctx, sessionId, entries);
			const tools = createTools(reel, {
				allowPaid: true,
				spend: guard,
				files: false,
				waitMs: this.options.waitMs,
				pollMs: this.options.pollMs,
			});
			if (before) await before(tools, guard);
			if (!brain || signal.aborted) {
				if (signal.aborted) await say({ note: "stopped" });
				return;
			}
			const specs = tools.map(toolSpec);
			const kept = await this.store.list(ctx, sessionId);
			const messages = conversation(kept);
			if (brain.vision) await this.showAgain(ctx, sessionId, kept, messages);
			const instructions = assistantInstructions(language);
			const words = kept
				.flatMap((entry) =>
					entry.message.role === "user" ? entry.message.content : [],
				)
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("\n");
			for (let step = 0; step < this.maxSteps; step++) {
				const reply = await brain.chat(
					instructions,
					fit(messages, brain.contextChars),
					specs,
					signal,
				);
				const models = reply.toolCalls.some((c) => c.name === "generate")
					? await reel.models()
					: [];
				const said: ChatMessage = {
					role: "assistant",
					text: reply.text,
					toolCalls: reply.toolCalls.map((call) =>
						keptModels(call, words, models),
					),
				};
				messages.push(said);
				await this.add(ctx, sessionId, { message: said });
				if (said.toolCalls.length === 0) return;

				let asked = false;
				for (const call of said.toolCalls) {
					if (signal.aborted) break;
					const cost = await this.paidCost(reel, call, guard);
					if (signal.aborted) break;
					if (cost) {
						asked = true;
						await this.add(ctx, sessionId, {
							message: {
								role: "tool",
								callId: call.id,
								name: call.name,
								content: [
									{
										type: "text",
										text: "Waiting for the person to approve the cost.",
									},
								],
							},
							confirm: {
								arguments: call.arguments,
								modelNames: cost.names,
								usd: cost.usd,
								state: "asked",
							},
						});
						continue;
					}
					// Written first, so a turn it makes is linked even if the
					// server stops before the call ends.
					const entry = await this.add(ctx, sessionId, {
						message: resultMessage(
							call,
							{
								text: "Started, but no result came back.",
								images: [],
								isError: true,
							},
							false,
						),
					});
					const made = await this.call(
						ctx,
						sessionId,
						work,
						tools,
						call,
						(turnId) =>
							this.store.update(ctx, entry.id, {
								...bodyOf(entry),
								turnId,
							}),
					);
					const result = brain.vision
						? made
						: await this.described(ctx, made, messages, signal);
					const message = resultMessage(call, result, brain.vision);
					messages.push(message);
					await this.store.update(ctx, entry.id, {
						...bodyOf(entry),
						// Kept as words only: the pictures come back from the turn.
						message: resultMessage(call, result, false),
						...(result.turnId && { turnId: result.turnId }),
					});
					this.changed(ctx, sessionId);
				}
				if (signal.aborted) {
					await say({ note: "stopped" });
					return;
				}
				if (asked) return;
			}
			await say({ note: "tooManySteps" });
		} catch (error) {
			if (signal.aborted) {
				await say({ note: "stopped" });
				return;
			}
			await say({
				error: {
					message: errorText(error),
					code: error instanceof CodedError ? (error.code ?? null) : null,
				},
			});
		}
	}

	/**
	 * A result with words about its pictures, for a brain that cannot see:
	 * what a model that sees says they show, against what was asked. Left
	 * as it is when no such model is installed or it fails.
	 */
	private async described(
		ctx: UserContext,
		result: ToolResult,
		messages: ChatMessage[],
		signal: AbortSignal,
	): Promise<ToolResult> {
		if (result.images.length === 0 || signal.aborted) return result;
		const eyes = await this.options.eyes?.(ctx);
		if (!eyes) return result;
		const asked = messages
			.findLast((m) => m.role === "user")
			?.content.flatMap((p) => (p.type === "text" ? [p.text] : []))
			.join(" ");
		try {
			const seen = await eyes.look(result.images, asked ?? "", signal);
			if (!seen) return result;
			return {
				...result,
				text: `${result.text}\nWhat the pictures show, as a model that sees describes them:\n${seen}`,
			};
		} catch (error) {
			if (signal.aborted) throw error;
			console.error(error);
			return result;
		}
	}

	/**
	 * Puts the pictures of the latest results back into the conversation:
	 * they are not kept with it, and the person often talks about them.
	 */
	private async showAgain(
		ctx: UserContext,
		sessionId: string,
		entries: AssistantEntry[],
		messages: ChatMessage[],
	) {
		const recent = entries
			.filter((e) => e.turnId && e.message.role === "tool")
			.slice(-SEEN_TURNS);
		if (recent.length === 0) return;
		const reel = this.options.reel(ctx);
		const [detail, models] = await Promise.all([
			reel.session(sessionId),
			reel.models(),
		]);
		let shown = 0;
		for (const entry of recent) {
			const turn = detail.turns.find((t) => t.id === entry.turnId);
			const { message } = entry;
			if (!turn || message.role !== "tool") continue;
			const images: ToolImage[] = [];
			for (const job of turn.jobs) {
				const name =
					models.find((m) => m.id === job.modelId)?.name ?? job.modelId;
				for (const asset of job.assets) {
					if (!asset.mime.startsWith("image/") || shown >= SEEN_PICTURES) {
						continue;
					}
					const small = await shrinkPicture(
						(await reel.asset(asset.id)).data,
					).catch(() => null);
					if (!small) continue;
					shown++;
					images.push({ ...small.image, label: `${asset.id} by ${name}` });
				}
			}
			// The same object conversation() kept: ids can repeat across turns.
			const at = messages.indexOf(message);
			const found = messages[at];
			if (at < 0 || found?.role !== "tool" || images.length === 0) continue;
			messages[at] = {
				...found,
				content: [...found.content, ...pictureParts(images)],
			};
		}
	}

	/** Runs one tool call, in the conversation's session. */
	private async call(
		ctx: UserContext,
		sessionId: string,
		work: Work,
		tools: Tool[],
		call: ToolCall,
		/** Keeps the turn the call made, as soon as it is made. */
		onTurn?: (turnId: string) => Promise<void>,
	): Promise<ToolResult> {
		const tool = tools.find((t) => t.name === call.name);
		let linked: Promise<void> | undefined;
		if (!tool) {
			return {
				text: `There is no tool named ${call.name}.`,
				images: [],
				isError: true,
			};
		}
		const args: Record<string, unknown> = { ...call.arguments };
		if (IN_SESSION.has(tool.name)) args.session_id = sessionId;
		try {
			return await tool.run(args as never, {
				signal: work.controller.signal,
				progress: async () => {},
				started: (turnId) => {
					work.turnId = turnId;
					linked = onTurn?.(turnId).catch((error) => console.error(error));
					this.changed(ctx, sessionId);
				},
			});
		} catch (error) {
			return { text: errorText(error), images: [], isError: true };
		} finally {
			await linked;
			if (work.turnId) {
				work.turnId = null;
				this.changed(ctx, sessionId);
			}
		}
	}

	/**
	 * What a call would cost on paid models, when the person must approve it
	 * first. A call that cannot run on them (unknown price, over the limit)
	 * is not asked about: the tool says why.
	 */
	private async paidCost(
		reel: Reel,
		call: ToolCall,
		guard: SpendGuard,
	): Promise<{ names: string[]; usd: number } | null> {
		if (call.name !== "generate" && call.name !== "upscale") return null;
		const [models, providers] = await Promise.all([
			reel.models(),
			reel.providers(),
		]);
		const ready = new Set(
			providers.filter((p) => p.hasKey || !p.requiresKey).map((p) => p.id),
		);
		const usable = models.filter((m) => ready.has(m.providerId));
		const args = call.arguments;
		let paid: ModelSpec[];
		let count = 1;
		let seconds: number | undefined;
		if (call.name === "generate") {
			const ids = Array.isArray(args.models) ? args.models : [];
			paid = usable.filter((m) => ids.includes(m.id) && !isLocal(m));
			if (typeof args.count === "number") count = args.count;
			if (typeof args.duration_seconds === "number") {
				seconds = args.duration_seconds;
			}
		} else {
			const upscalers = usable.filter((m) => m.capabilities.upscale != null);
			paid = upscalers.some(isLocal) ? [] : upscalers.slice(0, 1);
		}
		if (paid.length === 0) return null;
		let usd = 0;
		for (const model of paid) {
			const one = estimate(model, count, seconds);
			if (one == null) return null;
			usd += one;
		}
		const left = guard.left();
		if (left != null && usd > left) return null;
		return { names: paid.map((m) => m.name), usd };
	}
}
