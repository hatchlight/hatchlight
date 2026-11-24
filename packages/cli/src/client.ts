import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { defaultDataDir } from "@hatchlight/core";
import {
	type Connection,
	connect,
	running,
	ServerError,
} from "@hatchlight/mcp";
import { Api } from "./api";
import {
	COMMANDS,
	type Command,
	EXIT,
	type Io,
	parse,
	UsageError,
} from "./commands";
import { launcher, openInBrowser, serverArgs } from "./launcher";

/** A line typed at the terminal, shown as typed or not at all. */
function ask(prompt: string, shown: boolean): Promise<string | null> {
	return new Promise((done) => {
		if (!shown) process.stderr.write(prompt);
		const lines = createInterface({
			input: process.stdin,
			// What is typed goes nowhere when it must not be seen.
			output: shown
				? process.stderr
				: new Writable({ write: (_chunk, _encoding, next) => next() }),
			terminal: true,
		});
		let answer: string | null = null;
		lines.on("SIGINT", () => lines.close());
		lines.on("close", () => {
			if (!shown) process.stderr.write("\n");
			done(answer);
		});
		lines.question(shown ? prompt : "", (line) => {
			answer = line;
			lines.close();
		});
	});
}

/** Waits for Ctrl+C as the command asks to take it. */
class Interrupts {
	/** The first Ctrl+C, for "once". */
	readonly first = new AbortController();
	/** What waits on the next one, for "repeat". */
	private waiting: AbortController | null = null;
	/** How the running command takes Ctrl+C; unset until it runs. */
	mode: Command["interruptible"] | null = null;

	next(): AbortSignal {
		this.waiting = new AbortController();
		return this.waiting.signal;
	}

	/** One Ctrl+C: stops what is waited on, or the program. */
	take(): void {
		if (this.mode === "once" && !this.first.signal.aborted) {
			this.first.abort();
			return;
		}
		if (
			this.mode === "repeat" &&
			this.waiting &&
			!this.waiting.signal.aborted
		) {
			this.waiting.abort();
			return;
		}
		process.exit(EXIT.interrupted);
	}
}

/** Standard input, output and error, as a person or a script uses them. */
function terminal(interrupts: Interrupts): Io {
	const tty = process.stderr.isTTY === true;
	let shown = false;
	const clear = () => {
		if (shown) process.stderr.write("\r\x1b[2K");
		shown = false;
	};
	return {
		out: (line) => {
			clear();
			process.stdout.write(`${line}\n`);
		},
		err: (line) => {
			clear();
			process.stderr.write(`${line}\n`);
		},
		status: (line) => {
			if (!tty) return;
			if (line == null) return clear();
			const width = process.stderr.columns || 80;
			const fitted =
				line.length < width ? line : `${line.slice(0, width - 2)}…`;
			process.stderr.write(`\r\x1b[2K${fitted}`);
			shown = true;
		},
		cwd: process.cwd(),
		signal: interrupts.first.signal,
		nextInterrupt: () => interrupts.next(),
		open: openInBrowser,
		interactive: process.stdin.isTTY === true,
		readLine: (prompt) => {
			clear();
			return ask(prompt, true);
		},
		readSecret: (prompt) => {
			clear();
			return ask(prompt, false);
		},
		readAll: () => Bun.stdin.text(),
	};
}

/** Runs a command such as `hatchlight generate`; returns the exit code. */
export async function runCommand(
	name: string,
	args: string[],
): Promise<number> {
	const command = COMMANDS[name];
	if (!command) throw new Error(`No command ${name}`);
	const interrupts = new Interrupts();
	// Connecting, and commands that do not wait, end at once.
	process.on("SIGINT", () => interrupts.take());
	const io = terminal(interrupts);
	try {
		const { values, positionals } = parse(command, args);
		if (values.help) {
			io.out(command.usage);
			return EXIT.ok;
		}
		const dataDir =
			(values["data-dir"] as string | undefined) ?? defaultDataDir();
		let connection: Connection;
		if (command.offline) {
			connection = { url: "", started: false };
		} else if (command.local) {
			const url = await running(dataDir);
			if (!url) {
				io.err("Hatchlight is not running. Start it with `hatchlight`.");
				return EXIT.failed;
			}
			connection = { url, started: false };
		} else {
			io.status("Connecting to Hatchlight…");
			connection = await connect(
				dataDir,
				launcher(),
				serverArgs(values as { "data-dir"?: string; resources?: string }),
			);
			io.status(null);
		}
		interrupts.mode = command.interruptible;
		return await command.run(values, positionals, {
			api: new Api(connection.url),
			io,
			url: connection.url,
			dataDir,
			startedServer: connection.started,
		});
	} catch (error) {
		io.status(null);
		if (error instanceof UsageError) {
			io.err(error.message);
			io.err(`See: hatchlight ${name} --help`);
			return EXIT.usage;
		}
		if (error instanceof ServerError) {
			io.err(error.message);
			return EXIT.failed;
		}
		io.err(`${(error as Error).message ?? error}`);
		return EXIT.failed;
	}
}
