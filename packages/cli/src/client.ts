import { defaultDataDir } from "@hatchlight/core";
import {
	type Connection,
	connect,
	HatchlightClient,
	running,
	ServerError,
} from "@hatchlight/mcp";
import { COMMANDS, EXIT, type Io, parse, UsageError } from "./commands";
import { launcher, openInBrowser, serverArgs } from "./launcher";

/** Standard output and error, with a status line where a person watches. */
function terminal(signal: AbortSignal): Io {
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
		signal,
		open: openInBrowser,
	};
}

/** Runs a command such as `hatchlight generate`; returns the exit code. */
export async function runCommand(
	name: string,
	args: string[],
): Promise<number> {
	const command = COMMANDS[name];
	if (!command) throw new Error(`No command ${name}`);
	const stop = new AbortController();
	// Only once the command runs: connecting is ended at once.
	let interruptible = false;
	process.on("SIGINT", () => {
		// While a generation is waited on, once asks to stop waiting and twice
		// means now. Anything else ends at once.
		if (!interruptible || stop.signal.aborted) {
			process.exit(EXIT.interrupted);
		}
		stop.abort();
	});
	const io = terminal(stop.signal);
	try {
		const { values, positionals } = parse(command, args);
		if (values.help) {
			io.out(command.usage);
			return EXIT.ok;
		}
		const dataDir =
			(values["data-dir"] as string | undefined) ?? defaultDataDir();
		let connection: Connection;
		if (command.local) {
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
		interruptible = command.interruptible === true;
		return await command.run(values, positionals, {
			api: new HatchlightClient(connection.url),
			io,
			url: connection.url,
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
