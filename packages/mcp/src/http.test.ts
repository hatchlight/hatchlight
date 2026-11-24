import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startServer } from "./testing";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An agent on /mcp, as Claude Code connects with --transport http. */
async function agentOn(url: string, token: string) {
	const client = new Client({ name: "test", version: "1" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${token}` } },
		}),
	);
	cleanups.push(() => client.close());
	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;
	const tools = (await client.listTools()).tools.map((t) => t.name);
	return { call, tools };
}

const textOf = (result: CallToolResult) =>
	result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\\n");

/** A raw request to /mcp, as a client that is not MCP's own might send. */
const post = (
	url: string,
	headers: Record<string, string>,
	body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/list",
		params: {},
	}),
) =>
	fetch(`${url}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body,
	});

test("an agent makes pictures over /mcp with a token, within its scopes", async () => {
	const { url, token } = await startServer(cleanups, { mcp: true });
	const { call, tools } = await agentOn(url, token(["read", "generate"]).token);
	// Paid models are off for a token without the paid scope.
	expect(textOf(await call("list_models"))).toContain("Paid models are off");
	const { call: paid } = await agentOn(
		url,
		token(["read", "generate", "paid"]).token,
	);
	expect(textOf(await paid("list_models"))).toContain("fake/alpha");
	const made = await paid("generate", {
		prompt: "a lighthouse",
		models: ["fake/alpha"],
	});
	expect(made.isError).toBeUndefined();
	expect(made.content.some((c) => c.type === "image")).toBe(true);
	// Links lead to the server as people reach it.
	expect(textOf(made)).toContain("https://hatchlight.example/#/s/");

	const { call: looking } = await agentOn(url, token(["read", "paid"]).token);
	const refused = await looking("generate", {
		prompt: "a lighthouse",
		models: ["fake/alpha"],
	});
	expect(refused.isError).toBe(true);
	expect(textOf(refused)).toContain("generate");
	// No file on the server is the agent's to name: not to read, nor to write.
	const read = await paid("generate", {
		prompt: "x",
		models: ["fake/alpha"],
		reference_images: ["/etc/hostname"],
	});
	expect(read.isError).toBe(true);
	expect(textOf(read)).toContain("not /etc/hostname");
	expect(tools).not.toContain("save_image");
});

test("only a valid token opens /mcp: never a cookie, nor another website", async () => {
	const { url, token, runtime, ownerId, cookie } = await startServer(cleanups, {
		mcp: true,
	});
	const { token: valid, view } = token(["read"]);
	expect((await post(url, { authorization: `Bearer ${valid}` })).status).toBe(
		200,
	);
	// A signed-in browser's cookie is nobody here, even from the app's page.
	const withCookie = await post(url, { cookie, origin: url });
	expect(withCookie.status).toBe(401);
	expect(withCookie.headers.get("www-authenticate")).toContain("Bearer");
	// Another website cannot drive it, token or not.
	expect(
		(
			await post(url, {
				authorization: `Bearer ${valid}`,
				origin: "https://evil.example",
			})
		).status,
	).toBe(403);
	// Without sessions, only POST.
	expect(
		(
			await fetch(`${url}/mcp`, {
				headers: { authorization: `Bearer ${valid}` },
			})
		).status,
	).toBe(405);
	// Small JSON only.
	expect(
		(
			await post(
				url,
				{ authorization: `Bearer ${valid}` },
				JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
			)
		).status,
	).toBe(413);
	// Revoked, it opens nothing.
	runtime.accounts.revokeApiToken(ownerId, view.id);
	expect((await post(url, { authorization: `Bearer ${valid}` })).status).toBe(
		401,
	);
	// Guessing slows down.
	let status = 0;
	for (let i = 0; i < 12; i++) {
		status = (await post(url, { authorization: "Bearer hl_guess" })).status;
	}
	expect(status).toBe(429);
});

test("a token has a few calls under way at once, no more", async () => {
	const { url, token, fake } = await startServer(cleanups, { mcp: true });
	const { token: value } = token(["read", "generate", "paid"]);
	let open: () => void = () => {};
	fake.gate = new Promise((resolve) => {
		open = resolve;
	});
	const generate = (id: number) =>
		post(
			url,
			{ authorization: `Bearer ${value}` },
			JSON.stringify({
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: {
					name: "generate",
					arguments: { prompt: "x", models: ["fake/alpha"] },
				},
			}),
		);
	const held = [1, 2, 3, 4].map(generate);
	// Until the four are under way.
	for (let i = 0; i < 200 && fake.submitted.length < 4; i++) {
		await Bun.sleep(5);
	}
	expect((await generate(5)).status).toBe(429);
	open();
	for (const response of await Promise.all(held)) {
		expect(response.status).toBe(200);
	}
});
