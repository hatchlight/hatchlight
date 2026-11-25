import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeProvider,
	type LocalEngineSpec,
	type LocalModelSpec,
} from "@hatchlight/core";
import { zip } from "@hatchlight/core/testing";
import { builtinLocalModels } from "@hatchlight/providers";
import {
	createApp,
	createRuntime,
	DEFAULT_DEMO_MODEL,
	DEMO_ACCESS,
	demoTurn,
	HourlyCounter,
	installDemoModel,
	ROUTE_ACCESS,
	type RuntimeOptions,
	serverConfig,
} from "./index";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const HARDWARE = async () => ({
	os: "linux" as const,
	arch: "x64" as const,
	wsl: false,
	memoryBytes: 8 * 1024 ** 3,
	gpus: [],
});

/** A demo at demo.example, as a Hugging Face Space would run it. */
async function demoApp(
	env: Record<string, string> = {},
	runtimeOptions: Partial<RuntimeOptions> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-demo-"));
	const fake = new FakeProvider();
	// A paid provider whose key is in the environment: a demo never uses it.
	const paid = Object.assign(new FakeProvider("paid", ["gamma"]), {
		keyEnv: "HATCHLIGHT_TEST_DEMO_PAID_KEY",
	});
	paid.requiresKey = true;
	process.env.HATCHLIGHT_TEST_DEMO_PAID_KEY = "sk-in-the-environment";
	const { transport, demo } = serverConfig(
		{ mode: "demo" },
		{ HATCHLIGHT_PUBLIC_URL: "https://demo.example", ...env },
	);
	if (!transport || !demo) throw new Error("Not a demo");
	const runtime = await createRuntime({
		dataDir: root,
		providers: [fake, paid],
		localModels: [],
		engines: [],
		hardware: HARDWARE,
		checkEngine: async () => null,
		fetch: async () => new Response("not here", { status: 404 }),
		...runtimeOptions,
	});
	let now = Date.now();
	cleanups.push(async () => {
		delete process.env.HATCHLIGHT_TEST_DEMO_PAID_KEY;
		await runtime.engine.idle();
		runtime.close();
		await rm(root, { recursive: true });
	});
	await runtime.start();
	const app = createApp({
		...runtime,
		server: transport,
		demo: { config: demo, visitors: runtime.visitors, now: () => now },
	});
	const call = (
		path: string,
		init: {
			method?: string;
			body?: unknown;
			cookie?: string;
			peer?: string;
			base?: string;
			origin?: string;
		} = {},
	) => {
		const method = init.method ?? "GET";
		const base = init.base ?? "https://demo.example";
		const headers: Record<string, string> = {};
		if (!["GET", "HEAD"].includes(method)) headers.origin = base;
		if (init.origin) headers.origin = init.origin;
		if (init.body !== undefined) headers["content-type"] = "application/json";
		if (init.cookie) headers.cookie = init.cookie;
		return app.request(
			`${base}${path}`,
			{
				method,
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			},
			{ peer: init.peer ?? "203.0.113.10" },
		);
	};
	/** A new visitor's cookie, as their browser would send it back. */
	const visitor = async (peer?: string) => {
		const response = await call("/api/sessions", { peer });
		expect(response.status).toBe(200);
		const match = /(__Host-hatchlight-visitor=[^;]+)/.exec(
			response.headers.get("set-cookie") ?? "",
		);
		if (!match?.[1]) throw new Error("No visitor cookie");
		return match[1];
	};
	/** Makes a picture as `cookie` and waits for it. */
	const make = async (cookie: string, body: Record<string, unknown> = {}) => {
		const response = await call("/api/turns", {
			method: "POST",
			cookie,
			body: { prompt: "a red fox", modelIds: ["fake/alpha"], ...body },
		});
		expect(response.status).toBe(201);
		const { session } = (await response.json()) as { session: { id: string } };
		await runtime.engine.idle();
		const detail = (await (
			await call(`/api/sessions/${session.id}`, { cookie })
		).json()) as {
			turns: {
				jobs: {
					id: string;
					params: { count: number };
					assets: { id: string }[];
				}[];
			}[];
		};
		const job = detail.turns[0]?.jobs[0];
		if (!job) throw new Error("No job");
		return { sessionId: session.id, job, assetId: job.assets[0]?.id ?? "" };
	};
	return {
		call,
		visitor,
		make,
		runtime,
		root,
		demo,
		tick: (ms: number) => {
			now += ms;
		},
	};
}

test("every route of the API is classified for the demo", () => {
	expect(Object.keys(DEMO_ACCESS).sort()).toEqual(
		Object.keys(ROUTE_ACCESS).sort(),
	);
	// Nothing for owners or admins, nor anything that trains or installs.
	const allowed = Object.entries(DEMO_ACCESS)
		.filter(([, access]) => access !== "refused")
		.map(([route]) => route);
	for (const route of allowed) {
		expect(["public", "member"]).toContain(ROUTE_ACCESS[route] as string);
	}
});

test("a demo refuses everything it does not allow, with no identity made", async () => {
	const { call } = await demoApp();
	const wrong: string[] = [];
	const refused = [
		...Object.entries(DEMO_ACCESS)
			.filter(([, access]) => access === "refused")
			.map(([route]) => route),
		// Not a route at all.
		"GET /api/nothing-here",
		"POST /api/admin",
	];
	for (const route of refused) {
		const [method = "GET", pattern = ""] = route.split(" ");
		const response = await call(pattern.replace(/:\w+/g, "x"), {
			method,
			body: ["GET", "HEAD"].includes(method) ? undefined : {},
		});
		const body = (await response.json()) as { code?: string };
		if (response.status !== 403 || body.code !== "notInDemo") {
			wrong.push(`${route}: ${response.status} ${body.code ?? ""}`);
		}
		if (response.headers.get("set-cookie")) wrong.push(`${route}: a cookie`);
	}
	expect(wrong).toEqual([]);
});

test("a demo says what it is, and its public routes need no visitor", async () => {
	const { call } = await demoApp({ HATCHLIGHT_DEMO_TTL_HOURS: "6" });
	const server = await call("/api/server");
	expect(await server.json()).toEqual({
		mode: "demo",
		secure: true,
		demo: { ttlHours: 6, picturesPerHour: 20 },
	});
	expect(server.headers.get("set-cookie")).toBeNull();
	const health = await call("/api/health");
	expect(health.status).toBe(200);
	expect(health.headers.get("set-cookie")).toBeNull();
});

test("each visitor gets a private, random identity in a cookie", async () => {
	const { call, runtime } = await demoApp();
	const first = await call("/api/sessions");
	const cookie = first.headers.get("set-cookie") ?? "";
	expect(cookie).toMatch(/^__Host-hatchlight-visitor=[\w-]{43};/);
	expect(cookie).toContain("HttpOnly");
	expect(cookie).toContain("Secure");
	expect(cookie).toContain("SameSite=None");
	expect(cookie).toContain("Partitioned");
	expect(cookie).toContain("Path=/");
	expect(cookie).toContain(`Max-Age=${24 * 60 * 60}`);
	// The server keeps only the token's hash.
	const token = /=([\w-]{43});/.exec(cookie)?.[1] ?? "";
	expect(runtime.visitors.find(token)).toBeNull();
	// Known again from the cookie, with no new one.
	const again = await call("/api/sessions", { cookie: cookie.split(";")[0] });
	expect(again.status).toBe(200);
	expect(again.headers.get("set-cookie")).toBeNull();
	// Over plain http (trying it on one's own machine) it cannot be Secure.
	const plain = await demoApp({ HATCHLIGHT_PUBLIC_URL: "http://demo.local" });
	const local = await plain.call("/api/sessions", {
		base: "http://demo.local",
	});
	const plainCookie = local.headers.get("set-cookie") ?? "";
	expect(plainCookie).toMatch(/^hatchlight_visitor=[\w-]{43};/);
	expect(plainCookie).toContain("HttpOnly");
	expect(plainCookie).toContain("SameSite=Lax");
	expect(plainCookie).not.toContain("Secure");
});

test("a visitor never sees another visitor's sessions, pictures or gallery", async () => {
	const { call, visitor, make } = await demoApp();
	const ana = await visitor();
	const bia = await visitor();
	const { sessionId, job, assetId } = await make(ana);
	expect(assetId).not.toBe("");
	// Ana sees her own.
	expect(
		(await call(`/api/sessions/${sessionId}`, { cookie: ana })).status,
	).toBe(200);
	expect((await call(`/api/assets/${assetId}`, { cookie: ana })).status).toBe(
		200,
	);
	const anaGallery = (await (
		await call("/api/gallery", { cookie: ana })
	).json()) as unknown[];
	expect(anaGallery).toHaveLength(1);

	// Bia sees nothing of Ana's, and cannot touch it.
	expect(await (await call("/api/sessions", { cookie: bia })).json()).toEqual(
		[],
	);
	expect(await (await call("/api/gallery", { cookie: bia })).json()).toEqual(
		[],
	);
	for (const [method, path] of [
		["GET", `/api/sessions/${sessionId}`],
		["DELETE", `/api/sessions/${sessionId}`],
		["GET", `/api/assets/${assetId}`],
		["DELETE", `/api/assets/${assetId}`],
		["GET", `/api/jobs/${job.id}/preview`],
		["POST", `/api/jobs/${job.id}/cancel`],
		["POST", `/api/jobs/${job.id}/retry`],
	] as const) {
		const response = await call(path, { method, cookie: bia });
		expect(`${method} ${path}: ${response.status}`).toBe(
			`${method} ${path}: 404`,
		);
	}
	// Nor can she add a turn to Ana's session, or use Ana's picture.
	for (const body of [
		{ sessionId },
		{ referenceAssetIds: [assetId] },
		{ referenceAssetIds: [], maskAssetId: assetId },
	]) {
		const response = await call("/api/turns", {
			method: "POST",
			cookie: bia,
			body: { prompt: "mine now", modelIds: ["fake/alpha"], ...body },
		});
		expect([400, 404]).toContain(response.status);
	}
	// A made-up or stolen-looking cookie is a new visitor, never Ana.
	for (const forged of [
		"__Host-hatchlight-visitor=not-a-token",
		`__Host-hatchlight-visitor=${"a".repeat(43)}`,
		// Ana's cookie under the name used over http does not count over https.
		ana.replace("__Host-hatchlight-visitor", "hatchlight_visitor"),
	]) {
		const response = await call("/api/sessions", { cookie: forged });
		expect(await response.json()).toEqual([]);
		expect(response.headers.get("set-cookie")).toContain(
			"__Host-hatchlight-visitor=",
		);
	}
	// Ana's things are still there.
	expect((await call(`/api/assets/${assetId}`, { cookie: ana })).status).toBe(
		200,
	);
});

test("a demo offers no paid model, even with its key in the environment", async () => {
	const { call, visitor } = await demoApp();
	const cookie = await visitor();
	const models = (await (await call("/api/models", { cookie })).json()) as {
		id: string;
	}[];
	expect(models.map((m) => m.id).sort()).toEqual(["fake/alpha", "fake/beta"]);
	const providers = (await (
		await call("/api/providers", { cookie })
	).json()) as { id: string }[];
	expect(providers.map((p) => p.id)).not.toContain("paid");
	const turn = await call("/api/turns", {
		method: "POST",
		cookie,
		body: { prompt: "a red fox", modelIds: ["fake/alpha", "paid/gamma"] },
	});
	expect(turn.status).toBe(403);
	expect(((await turn.json()) as { code: string }).code).toBe("notInDemo");
});

test("a demo's runtime does not even register providers that need a key", async () => {
	const { runtime } = await demoApp({}, { demo: true });
	expect(runtime.service.listModels().map((m) => m.providerId)).not.toContain(
		"paid",
	);
});

test("a turn is held to the demo's batch and video length", () => {
	const { demo } = serverConfig(
		{ mode: "demo" },
		{
			HATCHLIGHT_PUBLIC_URL: "https://demo.example",
			HATCHLIGHT_DEMO_MAX_BATCH: "2",
			HATCHLIGHT_DEMO_MAX_SECONDS: "4",
		},
	);
	if (!demo) throw new Error("Not a demo");
	expect(
		demoTurn(
			{
				prompt: "x",
				modelIds: ["a"],
				count: 8,
				durationSeconds: 60,
				extras: { steps: 500, width: 4096 },
				loras: [{ id: "big", weight: 1 }],
			},
			demo,
		),
	).toEqual({ prompt: "x", modelIds: ["a"], count: 2, durationSeconds: 4 });
	// Unset, one picture; what is not a number is left for the schema to refuse.
	expect(demoTurn({ prompt: "x" }, demo)).toEqual({ prompt: "x", count: 1 });
	expect(demoTurn({ count: "many" }, demo).count).toBe("many");
});

test("each visitor, and each address, makes only so many pictures an hour", async () => {
	const { call, visitor, make, tick } = await demoApp({
		HATCHLIGHT_DEMO_PICTURES_PER_HOUR: "3",
		HATCHLIGHT_DEMO_PICTURES_PER_HOUR_PER_IP: "5",
		HATCHLIGHT_DEMO_MAX_BATCH: "1",
	});
	const ana = await visitor();
	// Asked for two, made one: the demo's batch.
	const { job } = await make(ana, { count: 2 });
	expect(job.params.count).toBe(1);
	await make(ana);
	await make(ana);
	const over = await call("/api/turns", {
		method: "POST",
		cookie: ana,
		body: { prompt: "one more", modelIds: ["fake/alpha"] },
	});
	expect(over.status).toBe(429);
	const body = (await over.json()) as {
		code: string;
		params: { minutes: number };
	};
	expect(body.code).toBe("demoLimitReached");
	expect(body.params.minutes).toBeGreaterThan(0);
	// A retry makes pictures too.
	const retry = await call(`/api/jobs/${job.id}/retry`, {
		method: "POST",
		cookie: ana,
	});
	expect(retry.status).toBe(429);
	// Someone else from the same address has the address's two left.
	const bia = await visitor();
	await make(bia);
	await make(bia);
	const crowded = await call("/api/turns", {
		method: "POST",
		cookie: bia,
		body: { prompt: "one more", modelIds: ["fake/alpha"] },
	});
	expect(crowded.status).toBe(429);
	// From another address, she may.
	const elsewhere = await call("/api/turns", {
		method: "POST",
		cookie: bia,
		peer: "198.51.100.7",
		body: { prompt: "from home", modelIds: ["fake/alpha"] },
	});
	expect(elsewhere.status).toBe(201);
	// A turn refused as invalid takes nothing from the limits.
	const carla = await visitor("192.0.2.30");
	const bad = await call("/api/turns", {
		method: "POST",
		cookie: carla,
		peer: "192.0.2.30",
		body: { prompt: "", modelIds: ["fake/alpha"] },
	});
	expect(bad.status).toBe(400);
	for (let i = 0; i < 3; i++) {
		const good = await call("/api/turns", {
			method: "POST",
			cookie: carla,
			peer: "192.0.2.30",
			body: { prompt: "a red fox", modelIds: ["fake/alpha"] },
		});
		expect(good.status).toBe(201);
	}
	// An hour later, Ana may again.
	tick(60 * 60 * 1000 + 1);
	await make(ana);
});

test("one address starts only so many visitors an hour", async () => {
	const { call, visitor, tick } = await demoApp({
		HATCHLIGHT_DEMO_VISITORS_PER_HOUR_PER_IP: "2",
	});
	const ana = await visitor();
	await visitor();
	const third = await call("/api/sessions");
	expect(third.status).toBe(429);
	expect(((await third.json()) as { code: string }).code).toBe(
		"demoLimitReached",
	);
	// Those already known go on; another address starts its own.
	expect((await call("/api/sessions", { cookie: ana })).status).toBe(200);
	expect((await call("/api/sessions", { peer: "198.51.100.7" })).status).toBe(
		200,
	);
	tick(60 * 60 * 1000 + 1);
	expect((await call("/api/sessions")).status).toBe(200);
});

test("old pictures, sessions and idle visitors are deleted", async () => {
	const { call, visitor, make, runtime, root, tick } = await demoApp({
		HATCHLIGHT_DEMO_TTL_HOURS: "24",
	});
	const ana = await visitor();
	const { sessionId, assetId } = await make(ana);
	const userDirs = async () =>
		(await readdir(join(root, "assets")).catch(() => [])).filter((name) =>
			name.startsWith("vis_"),
		);
	expect(await userDirs()).toHaveLength(1);

	// Nothing is old yet.
	expect(await runtime.sweepVisitors(Date.now() - 24 * 60 * 60 * 1000)).toEqual(
		{ sessions: 0, assets: 0, visitors: 0 },
	);
	expect((await call(`/api/assets/${assetId}`, { cookie: ana })).status).toBe(
		200,
	);

	// A day later all of it is, and Ana has not come back.
	expect(await runtime.sweepVisitors(Date.now() + 1000)).toEqual({
		sessions: 1,
		assets: 1,
		visitors: 1,
	});
	expect(await userDirs()).toEqual([]);
	// Her cookie names nobody now: she starts again, with nothing.
	tick(25 * 60 * 60 * 1000);
	const back = await call("/api/sessions", { cookie: ana });
	expect(await back.json()).toEqual([]);
	expect(back.headers.get("set-cookie")).toContain(
		"__Host-hatchlight-visitor=",
	);
	expect(
		(await call(`/api/sessions/${sessionId}`, { cookie: ana })).status,
	).toBe(404);
});

test("a visitor idle past the time to keep things is not let back in", async () => {
	const { call, visitor, tick } = await demoApp({
		HATCHLIGHT_DEMO_TTL_HOURS: "1",
	});
	const ana = await visitor();
	tick(30 * 60 * 1000);
	// Seen again: the hour starts over.
	expect(
		(await call("/api/sessions", { cookie: ana })).headers.get("set-cookie"),
	).toContain("Max-Age=3600");
	// Within the minute, nothing is written again.
	tick(30 * 1000);
	expect(
		(await call("/api/sessions", { cookie: ana })).headers.get("set-cookie"),
	).toBeNull();
	// Over an hour without a visit, before any sweep: a new visitor.
	tick(61 * 60 * 1000);
	expect(
		(await call("/api/sessions", { cookie: ana })).headers.get("set-cookie"),
	).toContain("__Host-hatchlight-visitor=");
});

test("a demo may be shown in a frame on the sites it names", async () => {
	const { call } = await demoApp({
		HATCHLIGHT_FRAME_ANCESTORS: "https://huggingface.co",
	});
	const page = await call("/api/health");
	expect(page.headers.get("content-security-policy")).toContain(
		"frame-ancestors 'self' https://huggingface.co",
	);
	expect(page.headers.get("x-frame-options")).toBeNull();
	// Unnamed, no site may.
	const closed = await demoApp();
	const response = await closed.call("/api/health");
	expect(response.headers.get("content-security-policy")).toContain(
		"frame-ancestors 'none'",
	);
	expect(response.headers.get("x-frame-options")).toBe("DENY");
});

test("changes from another site are refused, as on a server", async () => {
	const { call, visitor } = await demoApp();
	const cookie = await visitor();
	const forged = await call("/api/turns", {
		method: "POST",
		cookie,
		origin: "https://evil.example",
		body: { prompt: "a red fox", modelIds: ["fake/alpha"] },
	});
	expect(forged.status).toBe(403);
	expect(await (await call("/api/sessions", { cookie })).json()).toEqual([]);
	// Nor is a host the demo does not answer to.
	const host = await call("/api/sessions", { base: "https://evil.example" });
	expect(host.status).toBe(403);
});

test("the hourly counter forgets after an hour and gives back refunds", () => {
	let now = 0;
	const counter = new HourlyCounter({ now: () => now });
	expect(counter.take("a", 2, 3)).toBe(0);
	now = 10 * 60 * 1000;
	expect(counter.take("a", 1, 3)).toBe(0);
	// Full: room comes back when the first two are an hour old.
	expect(counter.take("a", 1, 3)).toBe(50 * 60 * 1000);
	expect(counter.take("b", 1, 3)).toBe(0);
	counter.refund("a", 1);
	expect(counter.take("a", 1, 3)).toBe(0);
	// More than the limit at once never fits.
	expect(counter.take("c", 4, 3)).toBeGreaterThan(0);
	now = 60 * 60 * 1000;
	expect(counter.take("a", 2, 3)).toBe(0);
});

test("the default demo model is in the catalog", () => {
	expect(builtinLocalModels().map((m) => m.id)).toContain(DEFAULT_DEMO_MODEL);
});

const ENGINE = zip([{ name: "run", data: new TextEncoder().encode("run") }]);
const WEIGHTS = new TextEncoder().encode("the weights of a small model");
const hash = (data: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(data).digest("hex");
const ENGINES: LocalEngineSpec[] = [
	{
		id: "run",
		name: "Runner",
		homepage: "https://engine.example",
		license: "MIT",
		builds: [
			{
				id: "run-cpu",
				engine: "run",
				version: "1",
				backend: "cpu",
				os: "linux",
				arch: "x64",
				executable: "run",
				files: [
					{
						name: "run.zip",
						url: "https://models.example/run.zip",
						size: ENGINE.byteLength,
						sha256: hash(ENGINE),
					},
				],
			},
		],
	},
];
const TINY: LocalModelSpec = {
	id: "tiny",
	name: "Tiny",
	author: "Example",
	media: "image",
	tasks: ["text-to-image"],
	summary: "A model for tests.",
	license: "MIT",
	licenseUrl: "https://license.example",
	commercial: { kind: "allowed" },
	homepage: "https://models.example",
	variants: [
		{
			id: "full",
			label: "Full",
			engine: "run",
			memoryBytes: 1,
			files: [
				{
					name: "tiny.safetensors",
					url: "https://models.example/tiny.safetensors",
					size: WEIGHTS.byteLength,
					sha256: hash(WEIGHTS),
					role: "model",
				},
			],
		},
	],
	demos: [],
	defaults: { size: 512, aspectRatios: ["1:1"], steps: 1, cfgScale: 1 },
};

test("the demo installs its model at start, and only once", async () => {
	const { runtime } = await demoApp(
		{},
		{
			localModels: [TINY],
			engines: ENGINES,
			fetch: async (url) =>
				new Response(url.endsWith(".zip") ? ENGINE : WEIGHTS),
		},
	);
	const said: string[] = [];
	const say = (line: string) => said.push(line);
	expect(await installDemoModel(runtime.models, "tiny", say)).toBe(true);
	expect(said[0]).toMatch(/^Installing the demo model Tiny/);
	expect(said.at(-1)).toBe("Demo model installed: Tiny");
	const view = await runtime.models.list();
	expect(view.models.find((m) => m.id === "tiny")?.ready).toBe(true);
	// Ready: nothing more is downloaded.
	said.length = 0;
	expect(await installDemoModel(runtime.models, "tiny", say)).toBe(true);
	expect(said).toEqual(["Demo model ready: Tiny"]);
	// One not in the catalog is said, and the demo goes on.
	said.length = 0;
	expect(await installDemoModel(runtime.models, "nope", say)).toBe(false);
	expect(said[0]).toContain("not in the catalog");
});

test("the demo says when its model could not be installed", async () => {
	const { runtime } = await demoApp(
		{},
		{
			localModels: [TINY],
			engines: ENGINES,
			fetch: async () => new Response("gone", { status: 404 }),
		},
	);
	const said: string[] = [];
	expect(
		await installDemoModel(runtime.models, "tiny", (line) => said.push(line)),
	).toBe(false);
	expect(said.at(-1)).toMatch(/^The demo model Tiny could not be installed/);
});
