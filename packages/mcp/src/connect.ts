import { readServerInfo } from "@hatchlight/core";

/** How long a server started for this process may take to come up. */
const START_TIMEOUT_MS = 60_000;
/** How long an app that is starting may take to say where it listens. */
const STARTING_APP_MS = 20_000;

/** The server at `url`, if it answers soon and like Hatchlight. */
async function answers(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/api/models`, {
			signal: AbortSignal.timeout(3000),
		});
		return response.ok && Array.isArray(await response.json());
	} catch {
		return false;
	}
}

/** The address of the server running on a data directory, if it answers. */
export async function running(dataDir: string): Promise<string | null> {
	const info = await readServerInfo(dataDir);
	return info && (await answers(info.url)) ? info.url : null;
}

/** Starts a server that lives as long as this process; "in use" if one runs. */
async function start(
	launcher: string[],
	serverArgs: string[],
): Promise<string | "in use"> {
	const child = Bun.spawn(
		[
			...launcher,
			...serverArgs,
			"--port",
			"0",
			"--no-open",
			"--parent-pid",
			String(process.pid),
		],
		{
			// Its input stays open: closing it is how it is told to stop. Its
			// output must not reach ours, which may carry a protocol or results.
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// Its own process group: Ctrl+C in the terminal reaches this
			// process, which decides what to stop, and not the server under it.
			detached: true,
		},
	);
	// Read from the start, so the server never blocks on a full pipe.
	const errors = new Response(child.stderr).text();
	const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
	let seen = "";
	const timeout = setTimeout(() => child.kill(), START_TIMEOUT_MS);
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += value;
			// A whole line: the address may come in pieces.
			const found = seen.match(/Hatchlight is running at (http:\/\/\S+)\r?\n/);
			if (found?.[1]) {
				void (async () => {
					while (!(await reader.read()).done) {}
				})();
				return found[1].replace("localhost", "127.0.0.1");
			}
		}
	} finally {
		clearTimeout(timeout);
	}
	const reason = (await errors).trim();
	if (/already running/.test(reason)) return "in use";
	throw new Error(`Hatchlight did not start: ${reason || seen.trim()}`);
}

export interface Connection {
	url: string;
	/** Started for this process, and stops when it ends. */
	started: boolean;
}

/**
 * The Hatchlight server for a data directory: the one already running, or
 * one started for this process, which stops when it does.
 */
export async function connect(
	dataDir: string,
	launcher: string[],
	serverArgs: string[],
): Promise<Connection> {
	const found = await running(dataDir);
	if (found) return { url: found, started: false };
	const url = await start(launcher, serverArgs);
	if (url !== "in use") return { url, started: true };
	// The app holds the directory but is still starting: it will say where
	// it listens in a moment.
	const until = Date.now() + STARTING_APP_MS;
	while (Date.now() < until) {
		await Bun.sleep(250);
		const later = await running(dataDir);
		if (later) return { url: later, started: false };
	}
	throw new Error(
		"Hatchlight is running on this data directory but does not answer",
	);
}
