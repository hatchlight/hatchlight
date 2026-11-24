import { describe, expect, spyOn, test } from "bun:test";
import {
	type ChatMessage,
	type ChatModel,
	type ChatReply,
	CodedError,
	type Eyes,
} from "@hatchlight/core";
import { picture } from "@hatchlight/core/testing";
import type {
	AssistantEntry,
	CreateTurnInput,
	ModelSpec,
	TurnView,
} from "@hatchlight/core/types";
import {
	Assistant,
	type AssistantStore,
	conversation,
	fit,
	keptModels,
	namesModel,
	toolSpec,
} from "./assistant";
import type { Reel, SessionDetail } from "./reel";
import { SpendGuard } from "./spend";
import { createTools } from "./tools";

const ctx = { userId: "ana" };

const local = {
	id: "local/z",
	providerId: "local",
	name: "Z",
	media: "image",
	operations: ["generate"],
	capabilities: { aspectRatios: ["1:1", "16:9"], maxReferenceImages: 1 },
} as unknown as ModelSpec;
const paid = {
	...local,
	id: "fal/x",
	providerId: "fal",
	name: "X",
	pricing: { usdPerOutput: 0.04 },
} as unknown as ModelSpec;

/** Hatchlight with sessions in memory; every turn is done at once. */
function fakeReel(pictures = false) {
	const sessions = new Map<string, SessionDetail>();
	const inputs: CreateTurnInput[] = [];
	let next = 0;
	const reel: Reel = {
		models: async () => [local, paid],
		providers: async () =>
			[
				{ id: "local", hasKey: false, requiresKey: false },
				{ id: "fal", hasKey: true, requiresKey: true },
			] as never,
		async session(id) {
			const found = sessions.get(id);
			if (!found) throw new Error("Session not found");
			return found;
		},
		async createTurn(input) {
			inputs.push(input);
			const session = sessions.get(input.sessionId ?? "") as SessionDetail;
			const id = `trn_${++next}`;
			const turn = {
				id,
				sessionId: session.id,
				prompt: input.prompt,
				referenceAssetIds: [],
				createdAt: 0,
				jobs: input.modelIds.map((modelId, i) => ({
					id: `job_${next}${i}`,
					turnId: id,
					modelId,
					providerId: modelId.split("/")[0],
					status: "succeeded",
					costUsd: null,
					assets: pictures
						? [{ id: `ast_${next}${i}`, mime: "image/png" }]
						: [],
				})),
			} as unknown as TurnView;
			session.turns.push(turn);
			return { session, turn };
		},
		upload: async () => {
			throw new Error("no uploads");
		},
		gallery: async () => [],
		asset: async () => {
			if (!pictures) throw new Error("no assets");
			return { data: picture(64, 48), mime: "image/png" };
		},
		sessionUrl: (id) => `#/s/${id}`,
	};
	const start = (id: string) =>
		sessions.set(id, {
			id,
			userId: ctx.userId,
			title: "",
			createdAt: 0,
			updatedAt: 0,
			turns: [],
		});
	return { reel, inputs, start };
}

function memoryStore(): AssistantStore & { entries: AssistantEntry[] } {
	const entries: AssistantEntry[] = [];
	return {
		entries,
		add: async (_ctx, entry) => {
			entries.push(structuredClone(entry));
		},
		update: async (_ctx, id, body) => {
			const i = entries.findIndex((e) => e.id === id);
			const old = entries[i] as AssistantEntry;
			entries[i] = structuredClone({
				...body,
				id,
				sessionId: old.sessionId,
				createdAt: old.createdAt,
			});
		},
		list: async (_ctx, sessionId) =>
			structuredClone(entries.filter((e) => e.sessionId === sessionId)),
	};
}

/** A language model that answers from a script, and keeps what it was sent. */
function scripted(
	...replies: (ChatReply | ((signal: AbortSignal) => Promise<ChatReply>))[]
) {
	const seen: ChatMessage[][] = [];
	const model: ChatModel & { seen: ChatMessage[][] } = {
		vision: false,
		seen,
		async chat(_instructions, messages, _tools, signal) {
			seen.push(structuredClone(messages));
			const next = replies.shift();
			if (!next) return { text: "Done.", toolCalls: [] };
			return typeof next === "function" ? next(signal) : next;
		},
	};
	return model;
}

const call = (name: string, args: Record<string, unknown>, id = "c1") => ({
	text: "",
	toolCalls: [{ id, name, arguments: args }],
});

function setup(
	brain: ChatModel | null,
	options: {
		maxSteps?: number;
		limitUsd?: number;
		pictures?: boolean;
		eyes?: Eyes;
	} = {},
) {
	const { pictures, eyes, ...rest } = options;
	const { reel, inputs, start } = fakeReel(pictures);
	const store = memoryStore();
	let sessions = 0;
	const assistant = new Assistant({
		store,
		reel: () => reel,
		brain: async () => brain,
		startSession: async () => {
			const id = `ses_${++sessions}`;
			start(id);
			return { id };
		},
		pollMs: 1,
		eyes: async () => eyes ?? null,
		...rest,
	});
	const idle = async (sessionId: string) => {
		for (let i = 0; i < 500; i++) {
			if (!(await assistant.view(ctx, sessionId)).busy) return;
			await Bun.sleep(2);
		}
		throw new Error("still busy");
	};
	return { assistant, store, inputs, idle, start };
}

const roles = (entries: AssistantEntry[]) =>
	entries.map((e) => e.note ?? e.error?.code ?? e.message.role);

describe("the assistant", () => {
	test("makes a picture for free in the conversation's session", async () => {
		const brain = scripted(
			call("generate", { prompt: "a red fox", session_id: "ses_other" }),
			{ text: "Here is your fox.", toolCalls: [] },
		);
		const { assistant, inputs, idle } = setup(brain);
		const { sessionId } = await assistant.send(ctx, {
			text: "uma raposa",
			language: "pt-BR",
		});
		await idle(sessionId);
		const view = await assistant.view(ctx, sessionId);
		expect(roles(view.entries)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		// The session the model named is not used: the conversation's is.
		expect(inputs[0]).toMatchObject({
			sessionId,
			prompt: "a red fox",
			modelIds: ["local/z"],
		});
		expect(view.entries[2]?.turnId).toBe("trn_1");
		expect(view.spentUsd).toBe(0);
		// The model saw the result before answering.
		const last = brain.seen.at(-1) ?? [];
		expect(last.at(-1)).toMatchObject({ role: "tool", name: "generate" });
	});

	test("asks before paying, and goes on once the person says yes", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["fal/x"], count: 2 }),
			{ text: "Made with X.", toolCalls: [] },
		);
		const { assistant, inputs, idle } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "use X" });
		await idle(sessionId);
		let view = await assistant.view(ctx, sessionId);
		const asked = view.entries.at(-1) as AssistantEntry;
		expect(asked.confirm).toMatchObject({
			modelNames: ["X"],
			usd: 0.08,
			state: "asked",
		});
		expect(inputs).toHaveLength(0);
		expect(brain.seen).toHaveLength(1);

		await assistant.answer(ctx, sessionId, asked.id, true);
		await idle(sessionId);
		view = await assistant.view(ctx, sessionId);
		expect(inputs[0]?.modelIds).toEqual(["fal/x"]);
		expect(view.entries.find((e) => e.id === asked.id)).toMatchObject({
			confirm: { state: "approved" },
			turnId: "trn_1",
		});
		expect(view.spentUsd).toBeCloseTo(0.08);
		expect(view.entries.at(-1)?.message).toMatchObject({
			text: "Made with X.",
		});
	});

	test("a no is told to the model, and nothing is made", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["fal/x"] }),
			{
				text: "Alright.",
				toolCalls: [],
			},
		);
		const { assistant, inputs, idle } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "use X" });
		await idle(sessionId);
		const asked = (await assistant.view(ctx, sessionId)).entries.at(-1);
		await assistant.answer(ctx, sessionId, asked?.id as string, false);
		await idle(sessionId);
		expect(inputs).toHaveLength(0);
		const result = brain.seen.at(-1)?.at(-1);
		expect(JSON.stringify(result)).toContain("said no to the cost");
		await expect(
			assistant.answer(ctx, sessionId, asked?.id as string, true),
		).rejects.toMatchObject({ code: "confirmNotWaiting" });
	});

	test("writing again says no to what was waiting", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["fal/x"] }),
		);
		const { assistant, idle } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "use X" });
		await idle(sessionId);
		await assistant.send(ctx, { sessionId, text: "never mind, a cat" });
		await idle(sessionId);
		const view = await assistant.view(ctx, sessionId);
		expect(view.entries.find((e) => e.confirm)?.confirm?.state).toBe(
			"declined",
		);
	});

	test("a paid call over the limit is not asked about: the tool refuses", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["fal/x"], count: 8 }),
		);
		const { assistant, inputs, idle } = setup(brain, { limitUsd: 0.1 });
		const { sessionId } = await assistant.send(ctx, { text: "eight with X" });
		await idle(sessionId);
		const view = await assistant.view(ctx, sessionId);
		expect(view.entries.some((e) => e.confirm)).toBe(false);
		expect(inputs).toHaveLength(0);
		expect(JSON.stringify(view.entries[2]?.message)).toContain(
			"over what is left",
		);
	});

	test("stops when asked, and the model later hears the call never ran", async () => {
		let release: () => void = () => {};
		const brain = scripted(
			(signal) =>
				new Promise((resolve, reject) => {
					release = () =>
						resolve(call("generate", { prompt: "a fox" }) as ChatReply);
					signal.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const { assistant, idle } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "a fox" });
		expect((await assistant.view(ctx, sessionId)).busy).toBe(true);
		assistant.stop(ctx, sessionId);
		await idle(sessionId);
		release();
		const view = await assistant.view(ctx, sessionId);
		expect(roles(view.entries)).toEqual(["user", "stopped"]);
	});

	test("calls left without a result get one, so services accept the history", () => {
		const entry = (message: ChatMessage, extra = {}) =>
			({
				id: "m",
				sessionId: "s",
				createdAt: 0,
				message,
				...extra,
			}) as AssistantEntry;
		const messages = conversation([
			entry({ role: "user", content: [{ type: "text", text: "two foxes" }] }),
			entry({
				role: "assistant",
				text: "",
				toolCalls: [
					{ id: "a", name: "generate", arguments: {} },
					{ id: "b", name: "generate", arguments: {} },
				],
			}),
			entry({ role: "tool", callId: "a", name: "generate", content: [] }),
			entry(
				{ role: "assistant", text: "", toolCalls: [] },
				{ note: "stopped" },
			),
			entry({ role: "user", content: [{ type: "text", text: "again" }] }),
		]);
		expect(
			messages.map((m) => (m.role === "tool" ? m.callId : m.role)),
		).toEqual(["user", "assistant", "a", "b", "user"]);
	});

	test("says what went wrong, with its code", async () => {
		const brain = scripted(async () => {
			throw new CodedError("The service refused", "providerBusy");
		});
		const { assistant, idle } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "a fox" });
		await idle(sessionId);
		const last = (await assistant.view(ctx, sessionId)).entries.at(-1);
		expect(last?.error).toEqual({
			message: "The service refused",
			code: "providerBusy",
		});
		// Errors are for the person, not the model.
		expect(conversation([last as AssistantEntry])).toEqual([]);
	});

	test("one message at a time per conversation", async () => {
		const brain = scripted(() => new Promise(() => {}));
		const { assistant } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "a fox" });
		await expect(
			assistant.send(ctx, { sessionId, text: "and a cat" }),
		).rejects.toMatchObject({ code: "assistantBusy" });
		assistant.stop(ctx, sessionId);
	});

	test("needs something to think with", async () => {
		const { assistant } = setup(null);
		await expect(assistant.send(ctx, { text: "a fox" })).rejects.toMatchObject({
			code: "noLanguageModel",
		});
	});

	test("a model that keeps calling tools is stopped", async () => {
		const brain = scripted(
			...Array.from({ length: 5 }, () => call("list_models", {})),
		);
		const { assistant, idle } = setup(brain, { maxSteps: 3 });
		const { sessionId } = await assistant.send(ctx, { text: "a fox" });
		await idle(sessionId);
		const view = await assistant.view(ctx, sessionId);
		expect(view.entries.at(-1)?.note).toBe("tooManySteps");
		expect(brain.seen).toHaveLength(3);
	});
});

describe("models nobody asked for", () => {
	const schnell = {
		...local,
		id: "local/flux-schnell",
		name: "FLUX.1 schnell",
	} as ModelSpec;
	const klein = {
		...local,
		id: "local/flux-2-klein-4b",
		name: "FLUX.2 klein 4B",
	} as ModelSpec;
	const turbo = {
		...local,
		id: "local/sdxl-turbo",
		name: "SDXL Turbo",
	} as ModelSpec;
	const zTurbo = {
		...local,
		id: "local/z-image-turbo",
		name: "Z-Image Turbo",
	} as ModelSpec;
	const all = [schnell, klein, turbo, zTurbo];
	const generate = (models: string[]) => ({
		id: "c1",
		name: "generate",
		arguments: { prompt: "a dog", models },
	});

	test("a model is named by its id, its name or a word of its own", () => {
		expect(namesModel("faz com o flux-schnell", schnell)).toBe(true);
		expect(namesModel("use o Z-Image Turbo", zTurbo)).toBe(true);
		expect(namesModel("quero no klein", klein)).toBe(true);
		expect(namesModel("um cachorro turbo", turbo)).toBe(false);
		expect(namesModel("um cachorro com um cavalo", schnell)).toBe(false);
	});

	test("are left out, so the best free one is used", () => {
		const kept = keptModels(
			generate(all.map((m) => m.id)),
			"me faz uma foto de cachorro com um cavalo",
			all,
		);
		expect(kept.arguments).toEqual({ prompt: "a dog" });
	});

	test("the ones the person named stay", () => {
		const kept = keptModels(
			generate([schnell.id, klein.id, turbo.id]),
			"um cachorro, com o flux",
			all,
		);
		expect(kept.arguments.models).toEqual([schnell.id, klein.id]);
	});

	test("all stay when the person asked to compare", () => {
		const ids = [schnell.id, turbo.id];
		expect(
			keptModels(generate(ids), "compara uns modelos", all).arguments.models,
		).toEqual(ids);
	});

	test("in a conversation, only what was asked is made", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["local/z", "fal/x"] }),
			{ text: "Here.", toolCalls: [] },
		);
		const { assistant, inputs, idle } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "uma raposa" });
		await idle(sessionId);
		// Nothing to pay for was asked, and one free model made it.
		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.modelIds).toEqual(["local/z"]);
		const view = await assistant.view(ctx, sessionId);
		expect(view.entries.some((e) => e.confirm)).toBe(false);
	});
});

describe("the tools as the model is told about them", () => {
	test("leave the session out: the conversation chooses it", () => {
		const { reel } = fakeReel();
		const tools = createTools(reel, {
			allowPaid: true,
			spend: new SpendGuard(null),
			files: false,
		});
		const generate = toolSpec(
			tools.find((t) => t.name === "generate") as never,
		);
		const properties = generate.parameters.properties as Record<
			string,
			unknown
		>;
		expect(properties.prompt).toBeDefined();
		expect(properties.session_id).toBeUndefined();
		expect(generate.parameters.required).toEqual(["prompt"]);
	});
});

describe("the assistant, after its review", () => {
	test("a stop right after a yes makes nothing", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["fal/x"] }),
		);
		const { assistant, inputs, idle } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "use X" });
		await idle(sessionId);
		const asked = (await assistant.view(ctx, sessionId)).entries.at(-1);
		await assistant.answer(ctx, sessionId, asked?.id as string, true);
		assistant.stop(ctx, sessionId);
		await idle(sessionId);
		expect(inputs).toHaveLength(0);
		const view = await assistant.view(ctx, sessionId);
		expect(view.spentUsd).toBe(0);
		expect(view.entries.find((e) => e.id === asked?.id)?.confirm?.state).toBe(
			"declined",
		);
	});

	test("a yes runs only what it was given for", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["fal/x"] }),
		);
		const { assistant, inputs, idle, store } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "use X" });
		await idle(sessionId);
		const asked = store.entries.at(-1) as AssistantEntry;
		// The price quoted was lower than what it costs now.
		if (asked.confirm) asked.confirm.usd = 0.01;
		await assistant.answer(ctx, sessionId, asked.id, true);
		await idle(sessionId);
		expect(inputs).toHaveLength(0);
		expect(
			JSON.stringify(store.entries.find((e) => e.id === asked.id)),
		).toContain("price changed");
	});

	test("a result is kept in its place, with its turn", async () => {
		const brain = scripted(call("generate", { prompt: "a fox" }), {
			text: "Done.",
			toolCalls: [],
		});
		const { assistant, idle } = setup(brain);
		const { sessionId } = await assistant.send(ctx, { text: "a fox" });
		await idle(sessionId);
		const view = await assistant.view(ctx, sessionId);
		expect(view.entries.map((e) => e.message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		expect(view.entries[2]?.turnId).toBe("trn_1");
		expect(JSON.stringify(view.entries[2]?.message)).not.toContain(
			"no result came back",
		);
	});

	test("an old part of a long conversation is left out, from a message of the person's", () => {
		const user = (text: string): ChatMessage => ({
			role: "user",
			content: [{ type: "text", text }],
		});
		const messages: ChatMessage[] = [
			user("x".repeat(500)),
			{
				role: "assistant",
				text: "",
				toolCalls: [{ id: "a", name: "list_models", arguments: {} }],
			},
			{ role: "tool", callId: "a", name: "list_models", content: [] },
			user("the latest"),
		];
		expect(fit(messages, undefined)).toBe(messages);
		expect(fit(messages, 10_000)).toEqual(messages);
		expect(fit(messages, 300)).toEqual([user("the latest")]);
	});
});

describe("an assistant that can see", () => {
	const picturesIn = (messages: ChatMessage[]) =>
		messages.flatMap((m) =>
			m.role === "assistant"
				? []
				: m.content.filter((p) => p.type === "image").map(() => m.role),
		);
	const labelsIn = (messages: ChatMessage[]) =>
		messages.flatMap((m) =>
			m.role === "tool"
				? m.content.flatMap((p) =>
						p.type === "text" && p.text.startsWith("ast_") ? [p.text] : [],
					)
				: [],
		);

	test("looks at what it made, and again when the person talks about it", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["local/z"] }),
			{ text: "A fox, as asked.", toolCalls: [] },
			{ text: "Sure.", toolCalls: [] },
		);
		const seeing = { ...brain, vision: true };
		const { assistant, idle } = setup(seeing, { pictures: true });
		const { sessionId } = await assistant.send(ctx, { text: "a fox" });
		await idle(sessionId);
		// Right after making it, with which picture it is.
		const after = brain.seen[1] ?? [];
		expect(picturesIn(after)).toEqual(["tool"]);
		expect(labelsIn(after)).toEqual(["ast_10 by Z"]);
		// Pictures are not kept, yet the next message sees them again.
		await assistant.send(ctx, { sessionId, text: "make it bigger" });
		await idle(sessionId);
		const next = brain.seen[2] ?? [];
		expect(picturesIn(next)).toEqual(["tool"]);
		expect(labelsIn(next)).toEqual(["ast_10 by Z"]);
	});

	test("a model that cannot see is sent no pictures", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["local/z"] }),
			{ text: "Done.", toolCalls: [] },
			{ text: "Sure.", toolCalls: [] },
		);
		const { assistant, idle } = setup(brain, { pictures: true });
		const { sessionId } = await assistant.send(ctx, { text: "a fox" });
		await idle(sessionId);
		await assistant.send(ctx, { sessionId, text: "bigger" });
		await idle(sessionId);
		for (const sent of brain.seen) expect(picturesIn(sent)).toEqual([]);
	});
});

describe("eyes for an assistant that cannot see", () => {
	const eyes = () => {
		const asked: { labels: (string | undefined)[]; asked: string }[] = [];
		const looking: Eyes & { asked: typeof asked } = {
			asked,
			async look(pictures, request) {
				asked.push({ labels: pictures.map((p) => p.label), asked: request });
				return "ast_10 by Z: a fox in snow, with no scarf.";
			},
		};
		return looking;
	};

	test("tell it what the pictures show, against what was asked", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["local/z"] }),
			{ text: "No scarf yet. Add one?", toolCalls: [] },
		);
		const looking = eyes();
		const { assistant, idle, store } = setup(brain, {
			pictures: true,
			eyes: looking,
		});
		const { sessionId } = await assistant.send(ctx, {
			text: "a fox with a red scarf",
		});
		await idle(sessionId);
		expect(looking.asked).toEqual([
			{ labels: ["ast_10 by Z"], asked: "a fox with a red scarf" },
		]);
		const result = JSON.stringify(brain.seen[1]?.at(-1));
		expect(result).toContain("a fox in snow, with no scarf");
		// Kept, so later turns know it too.
		expect(JSON.stringify(store.entries[2]?.message)).toContain("no scarf");
	});

	test("are not used for a brain that sees", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["local/z"] }),
			{ text: "Done.", toolCalls: [] },
		);
		const looking = eyes();
		const { assistant, idle } = setup(
			{ ...brain, vision: true },
			{ pictures: true, eyes: looking },
		);
		const { sessionId } = await assistant.send(ctx, { text: "a fox" });
		await idle(sessionId);
		expect(looking.asked).toEqual([]);
	});

	test("that fail leave the result as it was", async () => {
		const brain = scripted(
			call("generate", { prompt: "a fox", models: ["local/z"] }),
			{ text: "Done.", toolCalls: [] },
		);
		const broken: Eyes = {
			look: async () => {
				throw new Error("no model");
			},
		};
		const { assistant, idle } = setup(brain, { pictures: true, eyes: broken });
		const { sessionId } = await assistant.send(ctx, { text: "a fox" });
		await idle(sessionId);
		const last = (await assistant.view(ctx, sessionId)).entries.at(-1);
		expect(last?.message).toMatchObject({ text: "Done." });
	});

	test("closed, stop at once and leave the store alone", async () => {
		let thinking: () => void = () => {};
		const brain: ChatModel = {
			vision: false,
			// Slow to notice the stop, as a model that ignores it would be.
			chat: () =>
				new Promise((done) => {
					thinking = () => done({ text: "late", toolCalls: [] });
				}),
		};
		const { assistant, store } = setup(brain);
		await assistant.send(ctx, { text: "a fox" });
		await Bun.sleep(5);
		const kept = store.entries.length;
		const errors = spyOn(console, "error");
		try {
			assistant.close();
			thinking();
			await Bun.sleep(20);
			expect(store.entries.length).toBe(kept);
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});
});
