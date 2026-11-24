import {
	createTools,
	type Reel,
	SpendGuard,
	TOOLS_INSTRUCTIONS,
	type ToolResult,
} from "@hatchlight/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export { bestLocalModel } from "@hatchlight/tools";

export interface McpOptions {
	/**
	 * Whether models that cost money (cloud models, on the person's own
	 * keys) may be used. Off, only models on this computer are.
	 */
	allowPaid: boolean;
	/** The most this process may spend on paid models, in US dollars. */
	spendLimitUsd: number | null;
	/**
	 * Whether the agent may name files on this computer to read and write
	 * pictures: yes for an agent the person runs themselves (the default),
	 * never for one reaching a server over the network.
	 */
	files?: boolean;
	/** How long a generation is waited for before it is left running. */
	waitMs?: number;
	pollMs?: number;
	version?: string;
}

/** A tool's answer as MCP carries it. */
function asMcp(result: ToolResult): CallToolResult {
	return {
		content: [
			{ type: "text", text: result.text },
			...result.images.map((image) => ({ type: "image" as const, ...image })),
		],
		...(result.isError && { isError: true }),
	};
}

/**
 * Serves Hatchlight's tools over MCP, to agents the person runs themselves:
 * they may also name files on this computer.
 */
export function createMcpServer(reel: Reel, options: McpOptions): McpServer {
	const server = new McpServer(
		{ name: "hatchlight", version: options.version ?? "0.0.0" },
		{ instructions: TOOLS_INSTRUCTIONS },
	);
	const tools = createTools(reel, {
		allowPaid: options.allowPaid,
		spend: new SpendGuard(options.spendLimitUsd),
		files: options.files ?? true,
		waitMs: options.waitMs,
		pollMs: options.pollMs,
	});
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.input,
				...(tool.readOnly && { annotations: { readOnlyHint: true } }),
			},
			async (args: Record<string, unknown>, extra) => {
				let ticks = 0;
				const token = extra._meta?.progressToken;
				const result = await tool.run(args as never, {
					signal: extra.signal,
					// Every look, not only when a job ends: clients give up on a
					// call that is silent for long, and a video takes minutes.
					async progress(message) {
						if (token == null) return;
						ticks++;
						await extra.sendNotification({
							method: "notifications/progress",
							params: { progressToken: token, progress: ticks, message },
						});
					},
				});
				return asMcp(result);
			},
		);
	}
	return server;
}
