import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { Api } from "./api";

/**
 * What every command a person types shares: where it writes, what it is
 * given, and how it says it was given wrong. The commands talk to a
 * Hatchlight server, like the app and agents do.
 */

/** Where a command writes and reads, and what it knows about where it runs. */
export interface Io {
	/** A line of results, on standard output. */
	out(line: string): void;
	/** A line of notes and errors, on standard error. */
	err(line: string): void;
	/** Shows how things stand on a line that is rewritten; null clears it. */
	status(line: string | null): void;
	/** Relative paths are read from here. */
	cwd: string;
	/** The first Ctrl+C, for commands that stop waiting on it. */
	signal: AbortSignal;
	/**
	 * The next Ctrl+C, for commands that wait more than once, such as a
	 * conversation: each wait takes a new one.
	 */
	nextInterrupt(): AbortSignal;
	/** Opens an address in the browser. */
	open(url: string): void;
	/** A person answers at a terminal, rather than a script or a pipe. */
	interactive: boolean;
	/** A line the person types; null when they are done (Ctrl+D, Ctrl+C). */
	readLine(prompt: string): Promise<string | null>;
	/** Like `readLine`, without showing what is typed, for keys. */
	readSecret(prompt: string): Promise<string | null>;
	/** All of standard input, for what is piped in. */
	readAll(): Promise<string>;
}

export interface Context {
	api: Api;
	io: Io;
	/** The server's address. */
	url: string;
	/** The data directory, as given or the app's. */
	dataDir: string;
	/** The server was started for this command, and stops when it ends. */
	startedServer: boolean;
	/** How often something being waited for is looked at. */
	pollMs?: number;
}

/** The command was given wrong; says how. */
export class UsageError extends Error {}

/** Exit codes. */
export const EXIT = { ok: 0, failed: 1, usage: 2, interrupted: 130 } as const;

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Command {
	summary: string;
	usage: string;
	options: ParseArgsOptionsConfig;
	/** Needs a server running already: it does not start one. */
	local?: boolean;
	/** Needs no server at all. */
	offline?: boolean;
	/**
	 * How Ctrl+C is taken. Unset, it ends the command at once. "once": the
	 * first stops waiting on something that goes on without the command, the
	 * second ends it. "repeat": each stops what is being waited on, and one
	 * while nothing is ends the command.
	 */
	interruptible?: "once" | "repeat";
	run(values: Values, positionals: string[], context: Context): Promise<number>;
}

/** Options every command takes. */
export const COMMON: ParseArgsOptionsConfig = {
	json: { type: "boolean", default: false },
	"data-dir": { type: "string" },
	resources: { type: "string" },
	help: { type: "boolean", short: "h", default: false },
};

export const COMMON_HELP = `  --json            Print the result as JSON, for scripts
  --data-dir <p>    The data directory (default: the app's)
  -h, --help        Show this help`;

export const json = (io: Io, value: unknown) =>
	io.out(JSON.stringify(value, null, 2));
/** JSON on one line, for one result among many (JSON Lines). */
export const jsonLine = (io: Io, value: unknown) =>
	io.out(JSON.stringify(value));

/** Columns padded to line up. */
export function table(rows: string[][]): string[] {
	const widths = rows[0]?.map((_, i) =>
		Math.max(...rows.map((row) => row[i]?.length ?? 0)),
	);
	return rows.map((row) =>
		row
			.map((cell, i) =>
				i === row.length - 1 ? cell : cell.padEnd(widths?.[i] ?? 0),
			)
			.join("  ")
			.trimEnd(),
	);
}

/** A size for people, such as "6.9 GB". */
export function bytes(value: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unit = 0;
	while (size >= 1000 && unit < units.length - 1) {
		size /= 1000;
		unit++;
	}
	const digits = unit === 0 || size >= 100 ? 0 : 1;
	return `${size.toFixed(digits)} ${units[unit]}`;
}

/** A duration for people, such as "3m 05s". */
export function duration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

/** Throws when a value given to an option is not a whole number in range. */
export function integer(
	values: Values,
	name: string,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): number | undefined {
	const raw = values[name];
	if (raw == null) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new UsageError(
			`--${name} takes a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : " up"}.`,
		);
	}
	return value;
}

/** The value, checked against what such ids look like. */
export function id(
	value: string | undefined,
	pattern: RegExp,
	what: string,
): string {
	if (!value) throw new UsageError(`Give ${what}.`);
	if (!pattern.test(value)) throw new UsageError(`Not ${what}: ${value}`);
	return value;
}

/** Waits a while, or less if `signal` stops it. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((done) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			done();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

/** A command's arguments, read and checked; a usage error when they are wrong. */
export function parse(
	command: Command,
	args: string[],
): { values: Values; positionals: string[] } {
	try {
		const { values, positionals } = parseArgs({
			args,
			options: { ...COMMON, ...command.options },
			allowPositionals: true,
		});
		const result = values as Values;
		if (result["no-wait"]) result.wait = false;
		return { values: result, positionals };
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
}
