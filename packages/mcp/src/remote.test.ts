import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, type TokenScope } from "@hatchlight/core";
import { FAST_HASHER } from "@hatchlight/core/testing";
import { createApp, createRuntime, serverConfig } from "@hatchlight/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerError } from "./client";
import { checkRemote, remoteClient, remoteOrigin } from "./index";
import { createMcpServer } from "./tools";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A Hatchlight server for several people, over real HTTP, with an owner. */
export async function realServer() {
	const dataDir = await mkdtemp(join(tmpdir(), "hatchlight-remote-"));
	const paid = new FakeProvider("paid");
	paid.requiresKey = true;
	const runtime = await createRuntime({
		dataDir,
		providers: [new FakeProvider(), paid],
		localModels: [],
		engines: [],
		server: true,
		passwordHasher: FAST_HASHER,
	});
	await runtime.start();
	const { transport } = serverConfig(
		{ mode: "server" },
		{ HATCHLIGHT_PUBLIC_URL: "https://hatchlight.example" },
	);
	const app = createApp({ ...runtime, server: transport ?? undefined });
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request, bun) =>
			app.fetch(request, { peer: bun.requestIP(request)?.address }),
	});
	const url = `http://127.0.0.1:${listener.port}`;
	cleanups.push(async () => {
		await listener.stop(true);
		await runtime.engine.idle();
		runtime.close();
		await rm(dataDir, { recursive: true });
	});
	const setup = await fetch(`${url}/api/setup`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: url },
		body: JSON.stringify({
			code: runtime.accounts.setupCode(),
			username: "owner",
			password: "correct horse battery",
		}),
	});
	expect(setup.status).toBe(201);
	const ownerId = runtime.accounts.findUser("owner")?.id as string;
	const token = (scopes: TokenScope[], spendLimitUsd: number | null = null) =>
		runtime.accounts.createApiToken(ownerId, {
			name: "agent",
			scopes,
			spendLimitUsd,
		});
	return { url, app, runtime, token, paid, ownerId };
}

/** An agent connected through a client of `url` signed with `token`. */
async function agentOf(url: string, token: string) {
	// The fake models count as paid ones to the tools.
	const server = createMcpServer(remoteClient(url, token), {
		allowPaid: true,
		spendLimitUsd: null,
		pollMs: 5,
		files: false,
	});
	const [ours, theirs] = InMemoryTransport.createLinkedPair();
	await server.connect(ours);
	const client = new Client({ name: "test", version: "1" });
	await client.connect(theirs);
	cleanups.push(() => client.close());
	return async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (result: CallToolResult) =>
	result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");

test("a server elsewhere is reached over https, or plain http only on this computer", () => {
	expect(remoteOrigin("https://nas.example/some/path")).toBe(
		"https://nas.example",
	);
	expect(remoteOrigin("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096");
	expect(remoteOrigin("http://localhost:4096")).toBe("http://localhost:4096");
	expect(remoteOrigin("http://[::1]:4096")).toBe("http://[::1]:4096");
	expect(() => remoteOrigin("http://nas.local:4096")).toThrow("--insecure");
	expect(() => remoteOrigin("http://127.0.0.1.nip.io")).toThrow("--insecure");
	expect(remoteOrigin("http://nas.local:4096", true)).toBe(
		"http://nas.local:4096",
	);
	expect(() => remoteOrigin("ftp://nas.example")).toThrow();
	expect(() => remoteOrigin("nas.example")).toThrow();
});

test("an agent uses a server elsewhere with a token, within its scopes", async () => {
	const { url, token } = await realServer();
	const call = await agentOf(url, token(["read", "generate"]).token);
	const models = await call("list_models");
	expect(textOf(models)).toContain("fake/alpha");
	const made = await call("generate", {
		prompt: "a lighthouse",
		models: ["fake/alpha"],
	});
	expect(made.isError).toBeUndefined();
	expect(made.content.some((c) => c.type === "image")).toBe(true);
	// Links lead to the server it uses.
	expect(textOf(made)).toContain(url);

	// A token that may only look cannot make anything.
	const looking = await agentOf(url, token(["read"]).token);
	expect(textOf(await looking("list_models"))).toContain("fake/alpha");
	const refused = await looking("generate", {
		prompt: "a lighthouse",
		models: ["fake/alpha"],
	});
	expect(refused.isError).toBe(true);
	expect(textOf(refused)).toContain("generate");
});

test("a wrong, revoked or expired token is refused at once", async () => {
	const { url, token, runtime, ownerId } = await realServer();
	const refused = (value: string) =>
		remoteClient(url, value)
			.models()
			.then(
				() => null,
				(error: ServerError) => error.status,
			);
	expect(await refused("hl_made-up")).toBe(401);
	const { token: revoked, view } = token(["read"]);
	expect(await refused(revoked)).toBeNull();
	runtime.accounts.revokeApiToken(ownerId, view.id);
	expect(await refused(revoked)).toBe(401);
	// Said in words a person acts on.
	await expect(checkRemote(remoteClient(url, revoked))).rejects.toThrow(
		"revoked or expired",
	);
	await expect(
		checkRemote(remoteClient(url, token(["generate"]).token)),
	).rejects.toThrow("read permission");
});
