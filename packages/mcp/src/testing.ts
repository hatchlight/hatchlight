import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, type TokenScope } from "@hatchlight/core";
import { FAST_HASHER } from "@hatchlight/core/testing";
import { createApp, createRuntime, serverConfig } from "@hatchlight/server";
import { mcpOverHttp } from "./http";

/** A Hatchlight server for several people, over real HTTP, with an owner. */
export async function startServer(
	cleanups: (() => Promise<void>)[],
	options: { mcp?: boolean } = {},
) {
	const dataDir = await mkdtemp(join(tmpdir(), "hatchlight-remote-"));
	const fake = new FakeProvider();
	const paid = new FakeProvider("paid");
	paid.requiresKey = true;
	const runtime = await createRuntime({
		dataDir,
		providers: [fake, paid],
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
	const app = createApp({
		...runtime,
		server: transport ?? undefined,
		// As the command line wires it.
		mcp: options.mcp
			? mcpOverHttp({
					fetch: (request) =>
						Promise.resolve(app.fetch(request, { peer: "127.0.0.1" })),
					maxBodyBytes: 64 * 1024,
				})
			: undefined,
	});
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
	const cookie = (setup.headers.get("set-cookie") ?? "").split(
		";",
	)[0] as string;
	const ownerId = runtime.accounts.findUser("owner")?.id as string;
	const token = (scopes: TokenScope[], spendLimitUsd: number | null = null) =>
		runtime.accounts.createApiToken(ownerId, {
			name: "agent",
			scopes,
			spendLimitUsd,
		});
	return { url, app, runtime, token, paid, fake, ownerId, cookie };
}
