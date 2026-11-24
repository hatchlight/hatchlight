import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HatchlightClient } from "./client";
import { connect } from "./connect";
import { createMcpServer, type McpOptions } from "./tools";

export { HatchlightClient, ServerError } from "./client";
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
	const server = createMcpServer(new HatchlightClient(url), options);
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
