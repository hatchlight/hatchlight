import { resolve } from "node:path";
import type { AssistantEntry } from "@hatchlight/core/types";
import { done, ID, money } from "@hatchlight/tools";
import {
	COMMON_HELP,
	type Command,
	type Context,
	EXIT,
	type Io,
	id,
	jsonLine,
	pause,
	UsageError,
	type Values,
} from "./command";
import { namesFile, save } from "./media";

/**
 * Talking with Hatchlight's assistant from a terminal: it makes pictures
 * for what is asked, looks at them, and asks before spending money.
 */

/** A tool's arguments, short enough for one line. */
function shortArgs(args: Record<string, unknown>): string {
	const text = JSON.stringify(args);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Follows the assistant until it has answered, showing what it does. */
async function follow(
	sessionId: string,
	shown: Set<string>,
	values: Values,
	context: Context,
): Promise<number> {
	const { api, io, pollMs = 500 } = context;
	const output =
		typeof values.output === "string" ? resolve(io.cwd, values.output) : null;
	// Answered here: the server may still say "asked" for a moment.
	const answered = new Set<string>();
	// Turns made before are not reported again.
	const reported = new Set(
		(await api.conversation(sessionId)).entries.flatMap((e) =>
			shown.has(e.id) && e.turnId ? [e.turnId] : [],
		),
	);
	let interrupt = io.nextInterrupt();
	let stopped = false;
	let failed = false;
	for (;;) {
		const view = await api.conversation(sessionId);
		for (const entry of view.entries) {
			if (!shown.has(entry.id)) {
				shown.add(entry.id);
				failed = show(entry, values, io) || failed;
			}
			// A turn can come to an entry after it was shown, once paid for.
			if (
				entry.turnId &&
				!reported.has(entry.turnId) &&
				(await report(entry.turnId, sessionId, output, values, context))
			) {
				reported.add(entry.turnId);
			}
			if (entry.confirm?.state === "asked" && !answered.has(entry.id)) {
				answered.add(entry.id);
				const approve = await decide(entry, values, io);
				await api.answerAssistant(sessionId, entry.id, approve);
			}
		}
		// Until the server has taken every answer, and what follows from it.
		const asking = view.entries.some((e) => e.confirm?.state === "asked");
		const making = view.entries.some(
			(e) => e.turnId && !reported.has(e.turnId),
		);
		if (!view.busy && !asking && !making) {
			io.status(null);
			return failed ? EXIT.failed : stopped ? EXIT.interrupted : EXIT.ok;
		}
		io.status(view.turnId ? "Making pictures…" : "Thinking…");
		await pause(pollMs, interrupt);
		if (interrupt.aborted) {
			io.status(null);
			// A second Ctrl+C does not wait for the stop to take.
			if (stopped) return EXIT.interrupted;
			stopped = true;
			io.err("Stopping the assistant… (Ctrl+C again to leave now)");
			await api.stopAssistant(sessionId).catch(() => {});
			interrupt = io.nextInterrupt();
		}
	}
}

/** Whether to spend money on a paid generation the assistant asks for. */
async function decide(
	entry: AssistantEntry,
	values: Values,
	io: Context["io"],
): Promise<boolean> {
	const confirm = entry.confirm;
	if (!confirm) return false;
	const question = `Spend about ${money(confirm.usd)} on ${confirm.modelNames.join(", ")}?`;
	if (values.yes) {
		io.err(`${question} Yes (--yes).`);
		return true;
	}
	if (!io.interactive) {
		io.err(`${question} No: answer at a terminal, or pass --yes.`);
		return false;
	}
	const answer = await io.readLine(`${question} [y/N] `);
	return /^y(es)?$/i.test(answer?.trim() ?? "");
}

/**
 * Says what a turn the assistant made, and saves it, once it is done; false
 * while it is still being made.
 */
async function report(
	turnId: string,
	sessionId: string,
	output: string | null,
	values: Values,
	{ api, io }: Context,
): Promise<boolean> {
	const turn = (await api.session(sessionId)).turns.find(
		(t) => t.id === turnId,
	);
	// A turn that is gone has nothing left to show.
	if (!turn) return true;
	if (!done(turn.jobs)) return false;
	const made = turn.jobs.flatMap((job) => job.assets.map((a) => a.id));
	if (made.length === 0) return true;
	if (values.json) jsonLine(io, { turnId, made });
	else io.out(`  made ${made.join(" ")}`);
	if (output) {
		// A picture that cannot be saved does not end the conversation.
		try {
			for (const path of await save(api, made, output, false)) {
				io.err(`  saved ${path}`);
			}
		} catch (error) {
			io.err(`! Not saved: ${(error as Error).message}`);
		}
	}
	return true;
}

/** Shows an entry; true when it says something went wrong. */
function show(entry: AssistantEntry, values: Values, io: Io): boolean {
	const message = entry.message;
	if (values.json) {
		jsonLine(io, entry);
	} else if (message.role === "assistant") {
		io.status(null);
		if (message.text.trim()) io.out(message.text.trim());
		for (const call of message.toolCalls) {
			io.err(`→ ${call.name} ${shortArgs(call.arguments)}`);
		}
	} else if (message.role === "tool" && !entry.turnId) {
		const first = message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join(" ")
			.split("\n")[0];
		if (first) io.err(`  ${first}`);
	}
	if (entry.error) {
		io.err(`! ${entry.error.message}`);
		return true;
	}
	if (entry.note === "tooManySteps") {
		io.err("! The assistant took too many steps and stopped.");
	}
	return false;
}

export const CHAT_COMMANDS: Record<string, Command> = {
	chat: {
		summary: "Talk with the assistant, which makes pictures for you",
		usage: `Usage: hatchlight chat [message] [options]

Asks the assistant for something, such as "a poster of a lighthouse, then
make it warmer". It chooses models, makes pictures, looks at them and tries
again. With a message it answers once; without one, it is a conversation,
until Ctrl+D. Ctrl+C stops what the assistant is doing.

Paid models cost money only after you say yes to each.

  --session <id>    Go on with a conversation
  -o, --output <p>  Save the pictures it makes to a folder
  --yes             Say yes to paid generations without asking
${COMMON_HELP}`,
		options: {
			session: { type: "string" },
			output: { type: "string", short: "o" },
			yes: { type: "boolean", default: false },
		},
		interruptible: "repeat",
		async run(values, positionals, context) {
			const { api, io } = context;
			// A conversation makes many pictures: they go in a folder.
			if (
				typeof values.output === "string" &&
				(await namesFile(resolve(io.cwd, values.output)))
			) {
				throw new UsageError(
					"--output is a folder for chat: it makes many pictures.",
				);
			}
			if (!(await api.assistantBrain())) {
				throw new UsageError(
					"The assistant has nothing to think with. Install the local text model (`hatchlight catalog`), or set a key for OpenAI, Google or OpenRouter with `hatchlight keys set`.",
				);
			}
			let sessionId =
				values.session == null
					? undefined
					: id(values.session as string, ID, "a session id");
			const shown = new Set<string>();
			if (sessionId) {
				// What was said before is not said again.
				for (const entry of (await api.conversation(sessionId)).entries) {
					shown.add(entry.id);
				}
			}
			const ask = async (text: string) => {
				({ sessionId } = await api.tellAssistant(text, sessionId));
				return follow(sessionId, shown, values, context);
			};

			const given = positionals.join(" ").trim();
			if (given || !io.interactive) {
				const text = given || (await io.readAll()).trim();
				if (!text) throw new UsageError("Say what you would like.");
				const code = await ask(text);
				if (sessionId && !values.json) {
					io.err(`Go on with: hatchlight chat --session ${sessionId}`);
				}
				return code;
			}

			io.err("Ask for pictures; Ctrl+C stops the assistant, Ctrl+D leaves.");
			for (;;) {
				const text = await io.readLine("> ");
				if (text == null) break;
				if (!text.trim()) continue;
				await ask(text.trim());
			}
			if (sessionId)
				io.err(`Go on later with: hatchlight chat --session ${sessionId}`);
			return EXIT.ok;
		},
	},
};
