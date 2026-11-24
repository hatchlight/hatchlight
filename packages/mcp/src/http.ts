import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HatchlightClient } from "./client";
import { createMcpServer } from "./tools";

/** Who an MCP request over HTTP comes from, once the server checked it. */
export interface McpCaller {
	/** The API token it signed with, used again for each call it makes. */
	token: string;
	/** The server's origin as people reach it, for links in answers. */
	origin: string;
	/** The token and its person may use paid models. */
	allowPaid: boolean;
}

export interface McpHttpOptions {
	/**
	 * Calls the server's own API, as `fetch` would: each tool call goes
	 * through it, signed with the caller's token, so the token's scopes and
	 * limits apply exactly as they do to any program.
	 */
	fetch: (request: Request) => Promise<Response>;
	/** The largest request body read, in bytes. */
	maxBodyBytes: number;
	version?: string;
}

/**
 * Answers MCP's Streamable HTTP transport, without sessions: each request
 * gets its own server, which ends with it. Nothing an agent does outlives
 * the request but what it made on the server.
 */
export function mcpOverHttp(
	options: McpHttpOptions,
): (
	request: Request,
	caller: McpCaller,
	message: unknown,
) => Promise<Response> {
	return async (request, caller, message) => {
		const client = new HatchlightClient(caller.origin, (url, init) => {
			const headers = new Headers(init?.headers);
			headers.set("authorization", `Bearer ${caller.token}`);
			return options.fetch(new Request(url, { ...init, headers }));
		});
		const server = createMcpServer(client, {
			allowPaid: caller.allowPaid,
			// The token's own limit holds on the server.
			spendLimitUsd: null,
			// The agent is elsewhere: no file on this machine is its to name.
			files: false,
			version: options.version,
		});
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			// One answer per request: nothing streams past it.
			enableJsonResponse: true,
			maxRequestBodySize: options.maxBodyBytes,
		});
		await server.connect(transport);
		try {
			// The body was read already, to refuse batches.
			return await transport.handleRequest(request, { parsedBody: message });
		} finally {
			await server.close();
		}
	};
}
