import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_VERSION, blindOrder, FakeProvider } from "@hatchlight/core";
import { picture } from "@hatchlight/core/testing";
import type { ModelSpec } from "@hatchlight/core/types";
import { createApp, createRuntime } from "@hatchlight/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import desktop from "../../../apps/desktop/package.json" with { type: "json" };
import { HatchlightClient } from "./client";
import { bestLocalModel, createMcpServer, type McpOptions } from "./tools";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An agent connected to a real Hatchlight, whose only models are fakes. */
async function agent(options: Partial<McpOptions> = {}) {
	const dataDir = await mkdtemp(join(tmpdir(), "hatchlight-mcp-"));
	const runtime = await createRuntime({
		dataDir,
		providers: [new FakeProvider()],
		localModels: [],
		engines: [],
	});
	await runtime.start();
	const app = createApp(runtime);
	const hatchlight = new HatchlightClient(
		"http://127.0.0.1:4096",
		(url, init) => Promise.resolve(app.fetch(new Request(url, init))),
	);
	const server = createMcpServer(hatchlight, {
		allowPaid: false,
		spendLimitUsd: null,
		pollMs: 5,
		...options,
	});
	const [ours, theirs] = InMemoryTransport.createLinkedPair();
	await server.connect(ours);
	const client = new Client({ name: "test", version: "1" });
	await client.connect(theirs);
	cleanups.push(async () => {
		await client.close();
		await runtime.engine.idle();
		runtime.close();
		await rm(dataDir, { recursive: true });
	});
	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;
	return { call, dataDir, client, hatchlight, app };
}

const textOf = (result: CallToolResult) =>
	result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
const imagesOf = (result: CallToolResult) =>
	result.content.filter((c) => c.type === "image");
const idsIn = (value: string) => value.match(/ast_[A-Za-z0-9_-]+/g) ?? [];

test("it tells agents Hatchlight's own version", async () => {
	const { client } = await agent();
	expect(APP_VERSION).toBe(desktop.version);
	expect(client.getServerVersion()).toMatchObject({
		name: "hatchlight",
		version: APP_VERSION,
	});
});

test("it offers the tools an agent needs, and none that installs models", async () => {
	const { client } = await agent();
	const { tools } = await client.listTools();
	expect(tools.map((t) => t.name).sort()).toEqual([
		"check_consistency",
		"generate",
		"get_image",
		"job_status",
		"list_library",
		"list_models",
		"model_ranking",
		"save_image",
		"search_gallery",
		"upscale",
	]);
});

test("paid models stay out of reach unless the person allowed them", async () => {
	const local = await agent();
	expect(textOf(await local.call("list_models"))).toContain(
		"No local model is installed",
	);
	const refused = await local.call("generate", {
		prompt: "a fox",
		models: ["fake/alpha"],
	});
	expect(refused.isError).toBe(true);
	expect(textOf(refused)).toContain("Cannot use fake/alpha");

	const paid = await agent({ allowPaid: true });
	const listed = textOf(await paid.call("list_models"));
	expect(listed).toContain("fake/alpha");
	expect(listed).toContain("about $0.01 per image");
	expect(listed).toContain("Paid models are allowed, without a limit.");
});

test("a generation is waited for, compared across models, and shown", async () => {
	const { call } = await agent({ allowPaid: true });
	const result = await call("generate", {
		prompt: "a red fox in snow",
		models: ["fake/alpha", "fake/beta"],
		aspect_ratio: "16:9",
	});
	expect(result.isError).toBeFalsy();
	const said = textOf(result);
	expect(said).toMatch(/Session ses_\w+/);
	expect(said).toContain("Fake alpha: done");
	expect(said).toContain("Fake beta: done");
	expect(new Set(idsIn(said)).size).toBe(2);
	// Which preview is which, to compare them.
	expect(said).toMatch(
		/Previews below, in order: ast_\w+ by Fake alpha; ast_\w+ by Fake beta\./,
	);
	const images = imagesOf(result);
	expect(images).toHaveLength(2);
	expect(images[0]).toMatchObject({ mimeType: "image/jpeg" });
});

test("a result, or a file, is the picture the next generation starts from", async () => {
	const { call, dataDir } = await agent({ allowPaid: true });
	const first = textOf(
		await call("generate", { prompt: "a fox", models: ["fake/alpha"] }),
	);
	const session = first.match(/Session (ses_\w+)/)?.[1];
	const [made] = idsIn(first);
	const file = join(dataDir, "mine.png");
	await writeFile(file, picture(32, 32));
	const next = await call("generate", {
		prompt: "the same fox, at night",
		models: ["fake/alpha"],
		reference_images: [made, file],
		session_id: session,
	});
	expect(next.isError).toBeFalsy();
	expect(textOf(next)).toContain(`Session ${session}`);
});

test("a guide picture is followed by a model that takes one, and refused by others", async () => {
	const { call, dataDir } = await agent({ allowPaid: true });
	const listed = textOf(await call("list_models"));
	expect(listed).toContain(
		"follows a guide picture (outlines from any picture; pose, depth only from a ready map)",
	);
	const file = join(dataDir, "pose.png");
	await writeFile(file, picture(32, 32));
	const guided = await call("generate", {
		prompt: "a dancer on a stage",
		models: ["fake/alpha"],
		guide_image: file,
		guide_kind: "pose",
		guide_is_map: true,
		guide_strength: 0.6,
	});
	expect(guided.isError).toBeFalsy();
	expect(textOf(guided)).toContain("Fake alpha: done");
	// A pose found in a plain picture needs a model that makes the map.
	const unmade = await call("generate", {
		prompt: "a dancer on a stage",
		models: ["fake/alpha"],
		guide_image: file,
		guide_kind: "pose",
	});
	expect(unmade.isError).toBe(true);
	const refused = await call("generate", {
		prompt: "a dancer on a stage",
		models: ["fake/beta"],
		guide_image: file,
	});
	expect(refused.isError).toBe(true);
	const wrong = await call("generate", {
		prompt: "a dancer",
		models: ["fake/alpha"],
		guide_image: file,
		guide_strength: 2,
	});
	expect(wrong.isError).toBe(true);
});

test("spending stops at the limit the person set", async () => {
	const { call } = await agent({ allowPaid: true, spendLimitUsd: 0.015 });
	const first = await call("generate", { prompt: "a", models: ["fake/alpha"] });
	expect(first.isError).toBeFalsy();
	expect(textOf(first)).toContain("Spent or held so far: $0.01 of $0.01");
	const second = await call("generate", {
		prompt: "b",
		models: ["fake/alpha"],
	});
	expect(second.isError).toBe(true);
	expect(textOf(second)).toContain("over what is left");
});

test("what is not waited for still counts against the limit", async () => {
	const { call } = await agent({ allowPaid: true, spendLimitUsd: 0.015 });
	const [first, second] = await Promise.all([
		call("generate", { prompt: "a", models: ["fake/alpha"], wait: false }),
		call("generate", { prompt: "b", models: ["fake/alpha"], wait: false }),
	]);
	expect([first.isError, second.isError].filter(Boolean)).toHaveLength(1);
});

test("a generation not waited for is followed with job_status", async () => {
	const { call } = await agent({ allowPaid: true });
	const started = textOf(
		await call("generate", {
			prompt: "a fox",
			models: ["fake/alpha"],
			wait: false,
		}),
	);
	const session = started.match(/Session (ses_\w+)/)?.[1];
	let status = "";
	for (let i = 0; i < 100 && !status.includes("Fake alpha: done"); i++) {
		status = textOf(await call("job_status", { session_id: session }));
		await Bun.sleep(10);
	}
	expect(status).toContain("Fake alpha: done");
	expect(
		imagesOf(await call("job_status", { session_id: session })),
	).toHaveLength(1);
});

test("pictures made before are found, looked at and saved", async () => {
	const { call, dataDir } = await agent({ allowPaid: true });
	await call("generate", { prompt: "a lighthouse", models: ["fake/alpha"] });
	await call("generate", { prompt: "a fox", models: ["fake/alpha"] });
	const found = textOf(await call("search_gallery", { query: "lighthouse" }));
	const [id] = idsIn(found);
	expect(found).toContain('"a lighthouse"');
	expect(found).not.toContain('"a fox"');

	const seen = await call("get_image", { asset_id: id });
	expect(imagesOf(seen)).toHaveLength(1);

	const path = join(dataDir, "out", "lighthouse.bmp");
	const saved = await call("save_image", { asset_id: id, path });
	expect(textOf(saved)).toContain(`to ${path}`);
	expect((await readFile(path)).byteLength).toBeGreaterThan(0);
	const again = await call("save_image", { asset_id: id, path });
	expect(again.isError).toBe(true);
	const relative = await call("save_image", { asset_id: id, path: "x.png" });
	expect(textOf(relative)).toContain("must be absolute");
});

test("an agent reads which model the person prefers, and changes nothing", async () => {
	const { call, client, hatchlight } = await agent({ allowPaid: true });
	const { tools } = await client.listTools();
	expect(
		tools.find((t) => t.name === "model_ranking")?.annotations?.readOnlyHint,
	).toBe(true);
	expect(textOf(await call("model_ranking", { kind: "portrait" }))).toContain(
		"has not picked a best result in any comparison for portrait prompts",
	);

	const made = textOf(
		await call("generate", {
			prompt: "a portrait of a fox",
			models: ["fake/alpha", "fake/beta"],
		}),
	);
	const session = await hatchlight.session(
		made.match(/Session (ses_\w+)/)?.[1] as string,
	);
	const turn = session.turns[0];
	await hatchlight.pick(
		turn?.id as string,
		turn?.jobs[1]?.assets[0]?.id as string,
	);
	const ranked = textOf(await call("model_ranking", { kind: "portrait" }));
	expect(ranked).toContain("From 1 comparison(s) for portrait prompts");
	expect(ranked).toMatch(/1\. Fake beta \(fake\/beta\): won 1 of 1 \(100%\)/);
	expect(ranked).toContain("few comparisons");
	expect(textOf(await call("model_ranking", { kind: "landscape" }))).toContain(
		"has not picked",
	);
});

test("an agent lists the library and makes pictures with a character and a style by name", async () => {
	const { call, client, app, hatchlight } = await agent({ allowPaid: true });
	const { tools } = await client.listTools();
	expect(
		tools.find((t) => t.name === "list_library")?.annotations?.readOnlyHint,
	).toBe(true);
	expect(textOf(await call("list_library"))).toContain("The library is empty");
	const keep = (body: object) =>
		app.request("http://127.0.0.1:4096/api/library", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	await keep({ kind: "character", name: "Rex", prompt: "a corgi", seed: 4 });
	await keep({
		kind: "style",
		name: "Watercolor",
		prompt: "soft watercolor",
		modelId: "fake/beta",
	});
	await keep({ kind: "style", name: "Watercolor night", prompt: "dark" });
	const listed = textOf(await call("list_library", { kind: "style" }));
	expect(listed).toContain('style "Watercolor": words "soft watercolor"');
	expect(listed).not.toContain("Rex");

	const ambiguous = await call("generate", {
		prompt: "Rex on the beach",
		character: "rex",
		style: "water",
	});
	expect(ambiguous.isError).toBe(true);
	expect(textOf(ambiguous)).toContain('"Watercolor" or "Watercolor night"');
	expect((await call("generate", { prompt: "x", style: "oil" })).isError).toBe(
		true,
	);

	const made = await call("generate", {
		prompt: "Rex on the beach",
		character: "rex",
		style: "watercolor",
	});
	expect(made.isError).toBeFalsy();
	// No model named: the style's own.
	expect(textOf(made)).toContain("Fake beta: done");
	const session = await hatchlight.session(
		textOf(made).match(/Session (ses_\w+)/)?.[1] as string,
	);
	expect(session.turns[0]?.jobs[0]?.params).toMatchObject({
		prompt: "Rex on the beach, a corgi, soft watercolor",
		seed: 4,
		library: { character: "Rex", style: "Watercolor" },
	});
});

test("with names hidden until a pick, an agent gets the app's letters, not the models", async () => {
	const { call, hatchlight, app } = await agent({ allowPaid: true });
	await app.request("http://127.0.0.1:4096/api/settings", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ blindPicks: true }),
	});
	const made = textOf(
		await call("generate", {
			prompt: "a fox",
			models: ["fake/alpha", "fake/beta"],
		}),
	);
	expect(made).toContain("Model A: done.");
	expect(made).toContain("Model B: done.");
	expect(made).toContain("do not name or guess the models");
	expect(made).not.toMatch(/Fake (alpha|beta)| s,|\$0/);
	const sessionId = made.match(/Session (ses_\w+)/)?.[1] as string;
	const status = textOf(await call("job_status", { session_id: sessionId }));
	expect(status).toContain("Model A: done.");
	expect(status).not.toContain("Fake");
	// The same letters as the app: its blind order, by turn.
	const turn = (await hatchlight.session(sessionId)).turns[0];
	const first = blindOrder(turn?.jobs ?? [], turn?.id as string)[0];
	expect(status).toContain(`- Model A: done. ${first?.assets[0]?.id}`);
	expect(textOf(await call("search_gallery", { query: "fox" }))).toContain(
		"model hidden until the user picks",
	);

	await hatchlight.pick(turn?.id as string, first?.assets[0]?.id as string);
	const picked = textOf(await call("job_status", { session_id: sessionId }));
	expect(picked).toContain("Fake alpha: done");
	expect(picked).not.toContain("Model A");
	expect(textOf(await call("search_gallery", { query: "fox" }))).toContain(
		"fake/alpha",
	);
});

test("upscaling says how to get an upscaler when none is installed", async () => {
	const { call } = await agent();
	const result = await call("upscale", { image: "ast_x" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("install Real-ESRGAN");
});

test("the client reaches a server over the network by default", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json([]),
	});
	try {
		const client = new HatchlightClient(`http://127.0.0.1:${server.port}`);
		expect(await client.models()).toEqual([]);
	} finally {
		server.stop(true);
	}
});

test("without a model named, the best free one is used, the faster of equals", () => {
	const model = (
		id: string,
		quality: 1 | 2 | 3,
		speed: 1 | 2 | 3,
		over: Partial<ModelSpec["capabilities"]> = {},
		providerId = "local",
	): ModelSpec => ({
		id: `${providerId}/${id}`,
		providerId,
		providerModelId: id,
		name: id,
		media: "image",
		operations: ["generate"],
		capabilities: {
			aspectRatios: [],
			seed: true,
			maxCount: 1,
			maxReferenceImages: 0,
			...over,
		},
		profile: {
			family: id,
			name: id,
			author: "Example",
			speed,
			quality,
			text: false,
			bestFor: [],
		},
	});
	const models = [
		model("draft", 1, 3, { maxReferenceImages: 1 }),
		model("best-slow", 3, 1),
		model("best-fast", 3, 2),
		model("cloud-best", 3, 3, {}, "fal"),
		model("upscaler", 3, 3, { upscale: 4, maxReferenceImages: 1 }),
	];
	expect(bestLocalModel(models, 0)?.id).toBe("local/best-fast");
	// From a picture, only one that takes pictures.
	expect(bestLocalModel(models, 1)?.id).toBe("local/draft");
	expect(bestLocalModel(models.slice(1, 2), 1)).toBeUndefined();
	// Following a guide, only one that follows that kind.
	const guided = model("guided", 2, 2, {
		guide: {
			kinds: ["outlines", "pose"],
			makesMaps: ["outlines"],
			strength: 0.75,
		},
	});
	const withGuided = [...models, guided];
	expect(
		bestLocalModel(withGuided, 0, { kind: "outlines", ready: false })?.id,
	).toBe("local/guided");
	expect(bestLocalModel(withGuided, 0, { kind: "pose", ready: true })?.id).toBe(
		"local/guided",
	);
	expect(
		bestLocalModel(withGuided, 0, { kind: "pose", ready: false }),
	).toBeUndefined();
	expect(
		bestLocalModel(withGuided, 0, { kind: "depth", ready: true }),
	).toBeUndefined();
});
