import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HatchlightClient, ServerError } from "./client";
import { connect } from "./connect";
import { createMcpServer, type McpOptions } from "./tools";

export {
	type Fetch,
	HatchlightClient,
	ServerError,
	type ServerEvent,
} from "./client";
export { type Connection, connect, running } from "./connect";
export { createMcpServer, type McpOptions } from "./tools";

export interface RunOptions extends McpOptions {
	dataDir: string;
	/** The program, and its script if any, that starts a Hatchlight server. */
	launcher: string[];
	/** Options the server is started with, such as its data directory. */
	serverArgs: string[];
}

/**
 * Serves the tools on standard input and output, for an agent to use, until
 * the agent closes them.
 */
export async function runMcp(options: RunOptions): Promise<void> {
	const { url } = await connect(
		options.dataDir,
		options.launcher,
		options.serverArgs,
	);
	await serve(new HatchlightClient(url), options);
}

export interface RemoteOptions extends McpOptions {
	/** The server's address, as people reach it. */
	url: string;
	/** An API token of the person the agent acts for. */
	token: string;
	/** Allows plain http to a server that is not on this computer. */
	insecure?: boolean;
}

/** Hosts on this computer, which plain http does not expose. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * The server's origin, if it may be used: https, or plain http only to
 * this computer, or when `insecure` says so, since the token would cross
 * the network readable.
 */
export function remoteOrigin(url: string, insecure = false): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Not a URL: ${url}`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`Not an http or https URL: ${url}`);
	}
	if (
		parsed.protocol === "http:" &&
		!LOOPBACK.test(parsed.hostname) &&
		!insecure
	) {
		throw new Error(
			`${parsed.origin} is plain http, so the token would cross the network readable. Use https, or pass --insecure if you accept that.`,
		);
	}
	return parsed.origin;
}

/** A client that signs every request with the token. */
export function remoteClient(origin: string, token: string): HatchlightClient {
	return new HatchlightClient(origin, (url, init) => {
		const headers = new Headers(init?.headers);
		headers.set("authorization", `Bearer ${token}`);
		return globalThis.fetch(url, { ...init, headers });
	});
}

/**
 * Serves the tools on standard input and output for a Hatchlight server
 * elsewhere, as the person whose token it is.
 */
export async function runRemoteMcp(options: RemoteOptions): Promise<void> {
	const origin = remoteOrigin(options.url, options.insecure);
	const client = remoteClient(origin, options.token);
	await checkRemote(client);
	await serve(client, options);
}

/**
 * Whether the server answers and takes the token: said at once, in words a
 * person acts on, rather than at the agent's first call.
 */
export async function checkRemote(client: HatchlightClient): Promise<void> {
	try {
		await client.models();
	} catch (error) {
		if (error instanceof ServerError && error.status === 401) {
			throw new Error(
				`${client.baseUrl} refused the token: it may be mistyped, revoked or expired. Make a new one in Settings > Use with AI agents.`,
			);
		}
		if (error instanceof ServerError && error.code === "tokenScope") {
			throw new Error(
				`The token cannot list models: give it the read permission. (${error.message})`,
			);
		}
		throw error;
	}
}

async function serve(client: HatchlightClient, options: McpOptions) {
	const server = createMcpServer(client, options);
	// The agent leaves by closing our input, which the transport does not
	// report: either way, this process ends, and a server it started with it.
	const closed = new Promise<void>((done) => {
		server.server.onclose = done;
		process.stdin.once("end", done);
		process.stdin.once("close", done);
	});
	await server.connect(new StdioServerTransport());
	await closed;
}
