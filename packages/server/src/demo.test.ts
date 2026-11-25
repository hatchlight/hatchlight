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
	installDemoModel,
	mediaKeyOf,
	RateCounter,
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

/** Routes only a demo has, beyond those every install declares. */
const DEMO_ONLY = ["POST /api/visitor"];

interface CallInit {
	method?: string;
	body?: unknown;
	cookie?: string;
	/** Sent as `Authorization: Bearer`. */
	token?: string;
	peer?: string;
	base?: string;
	/** The Origin header; a change names its page's by default. */
	origin?: string | null;
	headers?: Record<string, string>;
}

/** A visitor as the page knows them. */
interface Visitor {
	token: string;
	mediaKey: string;
	/** As the browser sends the cookie back. */
	cookie: string;
}

/** A demo at demo.example, as a Hugging Face Space would run it. */
async function demoApp(
	env: Record<string, string> = {},
	options: {
		runtime?: Partial<RuntimeOptions>;
		modelId?: string;
		freeBytes?: () => Promise<number>;
	} = {},
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
		...options.runtime,
	});
	let now = Date.now();
	const logged: string[] = [];
	cleanups.push(async () => {
		delete process.env.HATCHLIGHT_TEST_DEMO_PAID_KEY;
		fake.gate = null;
		await runtime.engine.idle();
		runtime.close();
		await rm(root, { recursive: true });
	});
	await runtime.start();
	const app = createApp({
		...runtime,
		server: transport,
		demo: {
			config: demo,
			visitors: runtime.visitors,
			modelId: options.modelId ?? "fake/alpha",
			freeBytes: options.freeBytes,
			log: (line) => logged.push(line),
			now: () => now,
		},
	});
	const call = (path: string, init: CallInit = {}) => {
		const method = init.method ?? "GET";
		const base = init.base ?? "https://demo.example";
		const headers: Record<string, string> = {};
		if (!["GET", "HEAD"].includes(method)) headers.origin = base;
		if (init.origin === null) delete headers.origin;
		else if (init.origin) headers.origin = init.origin;
		if (init.body !== undefined) headers["content-type"] = "application/json";
		if (init.cookie) headers.cookie = init.cookie;
		if (init.token) headers.authorization = `Bearer ${init.token}`;
		return app.request(
			`${base}${path}`,
			{
				method,
				headers: { ...headers, ...init.headers },
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			},
			{ peer: init.peer ?? "203.0.113.10" },
		);
	};
	/** A new visitor, made as the page makes one. */
	const visitor = async (peer?: string): Promise<Visitor> => {
		const response = await call("/api/visitor", { method: "POST", peer });
		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			token: string;
			mediaKey: string;
		};
		const match = /(__Host-hatchlight-visitor=[^;]+)/.exec(
			response.headers.get("set-cookie") ?? "",
		);
		if (!match?.[1]) throw new Error("No visitor cookie");
		return { ...body, cookie: match[1] };
	};
	const turn = (
		who: Visitor,
		body: Record<string, unknown> = {},
		peer?: string,
	) =>
		call("/api/turns", {
			method: "POST",
			cookie: who.cookie,
			peer,
			body: { prompt: "a red fox", modelIds: ["fake/alpha"], ...body },
		});
	/** Makes a picture as `who` and waits for it. */
	const make = async (
		who: Visitor,
		body: Record<string, unknown> = {},
		peer?: string,
	) => {
		const response = await turn(who, body, peer);
		expect(response.status).toBe(201);
		const { session } = (await response.json()) as { session: { id: string } };
		await runtime.engine.idle();
		const detail = (await (
			await call(`/api/sessions/${session.id}`, { cookie: who.cookie })
		).json()) as {
			turns: {
				jobs: {
					id: string;
					status: string;
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
		app,
		call,
		visitor,
		turn,
		make,
		runtime,
		fake,
		root,
		demo,
		logged,
		tick: (ms: number) => {
			now += ms;
		},
	};
}

const codeOf = async (response: Response) =>
	((await response.json()) as { code?: string }).code;

test("every route of the API is classified for the demo", async () => {
	expect(Object.keys(DEMO_ACCESS).sort()).toEqual(
		[...Object.keys(ROUTE_ACCESS), ...DEMO_ONLY].sort(),
	);
	// Nothing for owners or admins, nor anything that trains or installs.
	const allowed = Object.entries(DEMO_ACCESS)
		.filter(
			([route, access]) => access !== "refused" && !DEMO_ONLY.includes(route),
		)
		.map(([route]) => route);
	for (const route of allowed) {
		expect(["public", "member"]).toContain(ROUTE_ACCESS[route] as string);
	}
	// And every route a demo answers is named.
	const { app } = await demoApp();
	const routes = app.routes
		.filter((route) => route.method !== "ALL" && route.path !== "/api/*")
		.filter((route) => route.path.startsWith("/api/"))
		.map((route) => `${route.method} ${route.path}`);
	expect(routes.filter((route) => !(route in DEMO_ACCESS))).toEqual([]);
});

test("a demo refuses everything it does not allow", async () => {
	const { call, visitor } = await demoApp();
	const ana = await visitor();
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
		// Refused to strangers and visitors alike.
		for (const cookie of [undefined, ana.cookie]) {
			const response = await call(pattern.replace(/:\w+/g, "x"), {
				method,
				cookie,
				body: ["GET", "HEAD"].includes(method) ? undefined : {},
			});
			const code = await codeOf(response);
			if (response.status !== 403 || code !== "notInDemo") {
				wrong.push(`${route}: ${response.status} ${code ?? ""}`);
			}
			if (response.headers.get("set-cookie")) wrong.push(`${route}: a cookie`);
		}
	}
	expect(wrong).toEqual([]);
});

test("only POST /api/visitor makes a visitor; other routes ask for one", async () => {
	const { call, runtime } = await demoApp();
	const visitorRoutes = Object.entries(DEMO_ACCESS)
		.filter(([, access]) => access === "visitor")
		.map(([route]) => route);
	const wrong: string[] = [];
	for (const route of visitorRoutes) {
		const [method = "GET", pattern = ""] = route.split(" ");
		const response = await call(pattern.replace(/:\w+/g, "x"), {
			method,
			body: ["GET", "HEAD"].includes(method) ? undefined : {},
		});
		const code = await codeOf(response);
		if (response.status !== 401 || code !== "visitorRequired") {
			wrong.push(`${route}: ${response.status} ${code ?? ""}`);
		}
		if (response.headers.get("set-cookie")) wrong.push(`${route}: a cookie`);
	}
	expect(wrong).toEqual([]);
	// The page's first requests, all at once, made nobody.
	expect(runtime.visitors.forgetIdle(Number.MAX_SAFE_INTEGER)).toEqual([]);
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

test("a visitor is a random token, in the answer and an HttpOnly cookie", async () => {
	const { call, runtime } = await demoApp();
	const first = await call("/api/visitor", { method: "POST" });
	expect(first.status).toBe(201);
	const { token, mediaKey } = (await first.json()) as {
		token: string;
		mediaKey: string;
	};
	expect(token).toMatch(/^[\w-]{43}$/);
	expect(mediaKey).toBe(mediaKeyOf(token));
	const cookie = first.headers.get("set-cookie") ?? "";
	expect(cookie).toStartWith(`__Host-hatchlight-visitor=${token};`);
	for (const part of [
		"HttpOnly",
		"Secure",
		"SameSite=None",
		"Partitioned",
		"Path=/",
		`Max-Age=${24 * 60 * 60}`,
	]) {
		expect(cookie).toContain(part);
	}
	// The server keeps only hashes.
	expect(runtime.visitors.find(token)).toBeNull();
	// Asked again with the cookie or the token, it is the same visitor.
	for (const again of [
		await call("/api/visitor", {
			method: "POST",
			cookie: `__Host-hatchlight-visitor=${token}`,
		}),
		await call("/api/visitor", { method: "POST", token }),
	]) {
		expect(again.status).toBe(200);
		expect(((await again.json()) as { token: string }).token).toBe(token);
	}
	// Over plain http (trying it on one's own machine) it cannot be Secure.
	const plain = await demoApp({ HATCHLIGHT_PUBLIC_URL: "http://demo.local" });
	const local = await plain.call("/api/visitor", {
		method: "POST",
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
	// Ana sees her own, by cookie or by token.
	for (const who of [{ cookie: ana.cookie }, { token: ana.token }]) {
		expect((await call(`/api/sessions/${sessionId}`, who)).status).toBe(200);
		expect((await call(`/api/assets/${assetId}`, who)).status).toBe(200);
		const gallery = (await (
			await call("/api/gallery", who)
		).json()) as unknown[];
		expect(gallery).toHaveLength(1);
	}

	// Bia sees nothing of Ana's, and cannot touch it.
	for (const who of [{ cookie: bia.cookie }, { token: bia.token }]) {
		expect(await (await call("/api/sessions", who)).json()).toEqual([]);
		expect(await (await call("/api/gallery", who)).json()).toEqual([]);
		for (const [method, path] of [
			["GET", `/api/sessions/${sessionId}`],
			["DELETE", `/api/sessions/${sessionId}`],
			["GET", `/api/assets/${assetId}`],
			["GET", `/api/assets/${assetId}?m=${bia.mediaKey}`],
			["DELETE", `/api/assets/${assetId}`],
			["GET", `/api/jobs/${job.id}/preview`],
			["POST", `/api/jobs/${job.id}/cancel`],
			["POST", `/api/jobs/${job.id}/retry`],
		] as const) {
			const response = await call(path, { method, ...who });
			expect(`${method} ${path}: ${response.status}`).toBe(
				`${method} ${path}: 404`,
			);
		}
	}
	// Nor can she add a turn to Ana's session, or use Ana's picture.
	for (const body of [
		{ sessionId },
		{ referenceAssetIds: [assetId] },
		{ referenceAssetIds: [], maskAssetId: assetId },
	]) {
		const response = await call("/api/turns", {
			method: "POST",
			cookie: bia.cookie,
			body: { prompt: "mine now", modelIds: ["fake/alpha"], ...body },
		});
		expect([400, 404]).toContain(response.status);
	}
	// A made-up token is nobody: never Ana, and no new visitor either.
	for (const forged of [
		{ cookie: "__Host-hatchlight-visitor=not-a-token" },
		{ cookie: `__Host-hatchlight-visitor=${"a".repeat(43)}` },
		// Ana's cookie under the name used over http does not count over https.
		{
			cookie: ana.cookie.replace(
				"__Host-hatchlight-visitor",
				"hatchlight_visitor",
			),
		},
		{ token: "a".repeat(43) },
		// Her media key is not her token.
		{ token: ana.mediaKey },
		// A wrong header is not made good by her cookie beside it.
		{ token: "a".repeat(43), cookie: ana.cookie },
	]) {
		const response = await call("/api/sessions", forged);
		expect(response.status).toBe(401);
		expect(response.headers.get("set-cookie")).toBeNull();
	}
	// Ana's things are still there.
	expect(
		(await call(`/api/assets/${assetId}`, { cookie: ana.cookie })).status,
	).toBe(200);
});

test("a visitor's media key loads their pictures, and opens nothing else", async () => {
	const { call, visitor, make } = await demoApp();
	const ana = await visitor();
	const { sessionId, assetId } = await make(ana);
	// No cookie, no header: a frame that keeps no cookies, loading a picture.
	const picture = await call(`/api/assets/${assetId}?m=${ana.mediaKey}`);
	expect(picture.status).toBe(200);
	// Not her sessions, nor anything else but pictures.
	for (const path of [
		`/api/sessions/${sessionId}?m=${ana.mediaKey}`,
		`/api/gallery?m=${ana.mediaKey}`,
		`/api/sessions?m=${ana.mediaKey}`,
	]) {
		expect((await call(path)).status).toBe(401);
	}
	expect((await call(`/api/assets/${assetId}?m=${ana.token}`)).status).toBe(
		401,
	);
});

test("a token works without a cookie, and only for a demo's visitor routes", async () => {
	const { call, visitor } = await demoApp();
	const ana = await visitor();
	// A program, or a frame that keeps no cookies: the header alone, and no
	// Origin, as a cookie-less client sends.
	const made = await call("/api/turns", {
		method: "POST",
		token: ana.token,
		origin: null,
		body: { prompt: "a red fox", modelIds: ["fake/alpha"] },
	});
	expect(made.status).toBe(201);
	// With a cookie beside it, it could be a browser on another site.
	const withCookie = await call("/api/turns", {
		method: "POST",
		token: ana.token,
		cookie: ana.cookie,
		origin: null,
		body: { prompt: "a red fox", modelIds: ["fake/alpha"] },
	});
	expect(withCookie.status).toBe(403);
	// It opens nothing a demo refuses.
	const refused = await call("/api/local-models/x/install", {
		method: "POST",
		token: ana.token,
		origin: null,
	});
	expect(refused.status).toBe(403);
	expect(await codeOf(refused)).toBe("notInDemo");
});

test("a demo offers only its model, never a paid one, even with its key set", async () => {
	const { call, visitor, turn } = await demoApp();
	const ana = await visitor();
	const models = (await (
		await call("/api/models", { cookie: ana.cookie })
	).json()) as { id: string }[];
	expect(models.map((m) => m.id)).toEqual(["fake/alpha"]);
	const providers = (await (
		await call("/api/providers", { cookie: ana.cookie })
	).json()) as { id: string }[];
	expect(providers.map((p) => p.id)).not.toContain("paid");
	for (const modelIds of [
		["fake/alpha", "paid/gamma"],
		["paid/gamma"],
		// Free, but not the demo's.
		["fake/beta"],
		["fake/alpha", "fake/beta"],
	]) {
		const response = await turn(ana, { modelIds });
		expect(response.status).toBe(403);
		expect(await codeOf(response)).toBe("notInDemo");
	}
});

test("a demo's runtime does not even register providers that need a key", async () => {
	const { runtime } = await demoApp({}, { runtime: { demo: true } });
	expect(runtime.service.listModels().map((m) => m.providerId)).not.toContain(
		"paid",
	);
});

test("a turn is held to the demo's batch, video length and prompt length", async () => {
	const { demo, visitor, turn } = await demoApp({
		HATCHLIGHT_DEMO_MAX_BATCH: "2",
		HATCHLIGHT_DEMO_MAX_SECONDS: "4",
	});
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
	const ana = await visitor();
	expect((await turn(ana, { prompt: "x".repeat(1001) })).status).toBe(400);
	expect((await turn(ana, { prompt: "x".repeat(1000) })).status).toBe(201);
});

test("each visitor, address and the demo make only so many pictures an hour", async () => {
	const { visitor, make, turn, tick } = await demoApp({
		HATCHLIGHT_DEMO_PICTURES_PER_HOUR: "3",
		HATCHLIGHT_DEMO_PICTURES_PER_HOUR_PER_IP: "5",
		HATCHLIGHT_DEMO_TOTAL_PICTURES_PER_HOUR: "8",
		HATCHLIGHT_DEMO_MAX_BATCH: "1",
	});
	const ana = await visitor();
	// Asked for two, made one: the demo's batch.
	const { job } = await make(ana, { count: 2 });
	expect(job.params.count).toBe(1);
	await make(ana);
	await make(ana);
	const over = await turn(ana, { prompt: "one more" });
	expect(over.status).toBe(429);
	const body = (await over.json()) as {
		code: string;
		params: { minutes: number };
	};
	expect(body.code).toBe("demoLimitReached");
	expect(body.params.minutes).toBeGreaterThan(0);
	// Someone else from the same address has the address's two left.
	const bia = await visitor();
	await make(bia);
	await make(bia);
	expect((await turn(bia)).status).toBe(429);
	// From another address, she may.
	await make(bia, {}, "198.51.100.7");
	// A turn refused as invalid takes nothing from the limits.
	const carla = await visitor("192.0.2.30");
	expect((await turn(carla, { prompt: "" }, "192.0.2.30")).status).toBe(400);
	await make(carla, {}, "192.0.2.30");
	await make(carla, {}, "192.0.2.30");
	// Eight in all this hour: the demo's ceiling, whoever asks next.
	const dora = await visitor("192.0.2.40");
	expect((await turn(dora, {}, "192.0.2.40")).status).toBe(429);
	// An hour later, Ana may again.
	tick(60 * 60 * 1000 + 1);
	await make(ana);
});

test("addresses in one IPv6 /64 count as one", async () => {
	const { call, visitor, make, turn } = await demoApp({
		HATCHLIGHT_DEMO_PICTURES_PER_HOUR_PER_IP: "2",
		HATCHLIGHT_DEMO_VISITORS_PER_HOUR_PER_IP: "3",
	});
	const ana = await visitor("2001:db8:1:2::1");
	await make(ana, {}, "2001:db8:1:2::1");
	await make(ana, {}, "2001:db8:1:2:ffff:ffff:ffff:fffe");
	expect((await turn(ana, {}, "2001:db8:1:2:0:0:0:99")).status).toBe(429);
	// The next /64 is another address.
	await make(ana, {}, "2001:db8:1:3::1");
	// New visitors too.
	await visitor("2001:db8:1:2::7");
	await visitor("2001:db8:1:2:abcd::8");
	expect(
		(await call("/api/visitor", { method: "POST", peer: "2001:db8:1:2::9" }))
			.status,
	).toBe(429);
	// IPv4 written as IPv6 is that IPv4.
	await visitor("192.0.2.5");
	await visitor("::ffff:192.0.2.5");
	await visitor("192.0.2.5");
	expect(
		(await call("/api/visitor", { method: "POST", peer: "::ffff:c000:205" }))
			.status,
	).toBe(429);
});

test("a retry counts only when it queues the job again", async () => {
	const { call, visitor, make, fake, runtime } = await demoApp({
		HATCHLIGHT_DEMO_PICTURES_PER_HOUR: "3",
		HATCHLIGHT_DEMO_MAX_BATCH: "1",
	});
	const ana = await visitor();
	fake.failWith = "the card fell over";
	const { job } = await make(ana);
	expect(job.status).toBe("failed");
	fake.failWith = null;
	// Held, so the second click comes while the first runs.
	let open = () => {};
	fake.gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const retry = () =>
		call(`/api/jobs/${job.id}/retry`, { method: "POST", cookie: ana.cookie });
	// Two clicks at once: one queues it, the other finds it under way.
	expect((await Promise.all([retry(), retry()])).map((r) => r.status)).toEqual([
		204, 204,
	]);
	open();
	await runtime.engine.idle();
	// One turn and one retry: one picture left this hour.
	await make(ana);
	expect(
		(
			await call("/api/turns", {
				method: "POST",
				cookie: ana.cookie,
				body: { prompt: "a red fox", modelIds: ["fake/alpha"] },
			})
		).status,
	).toBe(429);
	// One that did not fail cannot be retried, and costs nothing for asking.
	const done = await call(`/api/jobs/${job.id}/retry`, {
		method: "POST",
		cookie: ana.cookie,
	});
	expect(done.status).toBe(400);
});

test("a busy demo takes no more work: its queue, a visitor's jobs, the disk", async () => {
	let free = 10 * 1024 ** 3;
	const { visitor, turn, fake } = await demoApp(
		{ HATCHLIGHT_DEMO_MAX_QUEUE: "4", HATCHLIGHT_DEMO_MIN_FREE_GB: "2" },
		{ freeBytes: async () => free },
	);
	let open = () => {};
	fake.gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const ana = await visitor();
	for (let i = 0; i < 3; i++) expect((await turn(ana)).status).toBe(201);
	// Three of hers under way: more than two.
	const hers = await turn(ana);
	expect(hers.status).toBe(503);
	expect(await codeOf(hers)).toBe("demoBusy");
	// Bia's first one fits; then the demo's four are under way.
	const bia = await visitor();
	expect((await turn(bia)).status).toBe(201);
	expect((await turn(bia)).status).toBe(503);
	// Low on disk, nobody makes more.
	const { visitor: other, turn: otherTurn } = await demoApp(
		{ HATCHLIGHT_DEMO_MIN_FREE_GB: "2" },
		{ freeBytes: async () => free },
	);
	free = 1024 ** 3;
	const carla = await other();
	const low = await otherTurn(carla);
	expect(low.status).toBe(503);
	expect(await codeOf(low)).toBe("demoBusy");
	open();
});

test("visitors are made only so often, per address and in all", async () => {
	const { call, visitor, tick } = await demoApp({
		HATCHLIGHT_DEMO_VISITORS_PER_HOUR_PER_IP: "2",
		HATCHLIGHT_DEMO_TOTAL_VISITORS_PER_HOUR: "3",
	});
	const ana = await visitor();
	await visitor();
	const third = await call("/api/visitor", { method: "POST" });
	expect(third.status).toBe(429);
	expect(await codeOf(third)).toBe("demoLimitReached");
	// Those already known go on.
	expect((await call("/api/sessions", { cookie: ana.cookie })).status).toBe(
		200,
	);
	// Another address starts its own, up to the demo's ceiling.
	await visitor("198.51.100.7");
	expect(
		(await call("/api/visitor", { method: "POST", peer: "192.0.2.9" })).status,
	).toBe(429);
	tick(60 * 60 * 1000 + 1);
	await visitor();
});

test("each address may make only so many requests a minute", async () => {
	const { call, visitor, tick } = await demoApp({
		HATCHLIGHT_DEMO_REQUESTS_PER_MINUTE_PER_IP: "5",
	});
	const ana = await visitor();
	for (let i = 0; i < 4; i++) {
		expect((await call("/api/sessions", { cookie: ana.cookie })).status).toBe(
			200,
		);
	}
	const over = await call("/api/sessions", { cookie: ana.cookie });
	expect(over.status).toBe(429);
	// Health checks and the first question are never held back.
	expect((await call("/api/health")).status).toBe(200);
	expect((await call("/api/server")).status).toBe(200);
	// Another address is not.
	expect(
		(await call("/api/sessions", { cookie: ana.cookie, peer: "192.0.2.9" }))
			.status,
	).toBe(200);
	tick(60 * 1000 + 1);
	expect((await call("/api/sessions", { cookie: ana.cookie })).status).toBe(
		200,
	);
});

test("a visitor, and an address, hold only a few event streams open", async () => {
	const { call, visitor } = await demoApp();
	const ana = await visitor();
	const streams: Response[] = [];
	for (let i = 0; i < 3; i++) {
		const stream = await call("/api/events", { cookie: ana.cookie });
		expect(stream.status).toBe(200);
		streams.push(stream);
	}
	const fourth = await call("/api/events", { cookie: ana.cookie });
	expect(fourth.status).toBe(429);
	// Others from the address get theirs, up to ten in all.
	for (let i = 0; i < 3; i++) {
		const other = await visitor();
		for (let j = 0; j < (i < 2 ? 3 : 1); j++) {
			const stream = await call("/api/events", { cookie: other.cookie });
			expect(stream.status).toBe(200);
			streams.push(stream);
		}
	}
	const last = await visitor();
	expect((await call("/api/events", { cookie: last.cookie })).status).toBe(429);
	// A stream closed frees its place.
	await streams[0]?.body?.cancel();
	await Bun.sleep(10);
	const again = await call("/api/events", { cookie: last.cookie });
	expect(again.status).toBe(200);
	streams.push(again);
	for (const stream of streams.slice(1)) await stream.body?.cancel();
});

test("what is installed is asked at most every few seconds, the demo's model only", async () => {
	const tiny = (id: string): LocalModelSpec => ({ ...TINY, id, name: id });
	const { call, visitor, runtime, tick } = await demoApp(
		{ HATCHLIGHT_DEMO_MODEL: "tiny" },
		{
			runtime: { localModels: [tiny("tiny"), tiny("other")], engines: ENGINES },
		},
	);
	let asked = 0;
	const list = runtime.models.listWithMemory.bind(runtime.models);
	runtime.models.listWithMemory = async () => {
		asked++;
		return list();
	};
	const ana = await visitor();
	const read = async () =>
		(await (
			await call("/api/local-models", { cookie: ana.cookie })
		).json()) as { models: { id: string }[] };
	expect((await read()).models.map((m) => m.id)).toEqual(["tiny"]);
	await read();
	await read();
	expect(asked).toBe(1);
	tick(5000);
	await read();
	expect(asked).toBe(2); // Nor are another model's demo pictures fetched for a visitor.
	const fetched: string[] = [];
	const demoOf = runtime.models.demo.bind(runtime.models);
	runtime.models.demo = async (id, index, size) => {
		fetched.push(id);
		return demoOf(id, index, size);
	};
	const other = await call("/api/local-models/other/demos/0", {
		cookie: ana.cookie,
	});
	expect(other.status).toBe(404);
	await call("/api/local-models/tiny/demos/0", { cookie: ana.cookie });
	expect(fetched).toEqual(["tiny"]);
});

test("the demo describes where requests come from, for its first minutes", async () => {
	const { call, logged, tick } = await demoApp({
		HATCHLIGHT_TRUSTED_PROXIES: "10.0.0.0/8",
	});
	const proxied = {
		peer: "10.1.2.3",
		headers: {
			"x-forwarded-for": "198.51.100.1, 203.0.113.50",
			"x-forwarded-proto": "https",
		},
	};
	await call("/api/health", proxied);
	await call("/api/health", proxied);
	expect(logged).toEqual([
		"Demo request: peer 10.1.2.3, X-Forwarded-For 198.51.100.1, 203.0.113.50, X-Forwarded-Proto https, client 203.0.113.50",
	]);
	tick(60 * 1000);
	await call("/api/health", proxied);
	expect(logged).toHaveLength(2);
	// After ten minutes, nothing more.
	tick(10 * 60 * 1000);
	await call("/api/health", proxied);
	expect(logged).toHaveLength(2);
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
	expect(
		(await call(`/api/assets/${assetId}`, { cookie: ana.cookie })).status,
	).toBe(200);

	// A day later all of it is, and Ana has not come back.
	expect(await runtime.sweepVisitors(Date.now() + 1000)).toEqual({
		sessions: 1,
		assets: 1,
		visitors: 1,
	});
	expect(await userDirs()).toEqual([]);
	// Her token names nobody now: she must start again, with nothing.
	tick(25 * 60 * 60 * 1000);
	expect((await call("/api/sessions", { cookie: ana.cookie })).status).toBe(
		401,
	);
	const back = await call("/api/visitor", {
		method: "POST",
		cookie: ana.cookie,
	});
	expect(back.status).toBe(201);
	const { token } = (await back.json()) as { token: string };
	expect(token).not.toBe(ana.token);
	expect((await call(`/api/sessions/${sessionId}`, { token })).status).toBe(
		404,
	);
});

test("a visitor idle past the time to keep things is not let back in", async () => {
	const { call, visitor, tick } = await demoApp({
		HATCHLIGHT_DEMO_TTL_HOURS: "1",
	});
	const ana = await visitor();
	tick(30 * 60 * 1000);
	// Seen again: the hour starts over, and the cookie with it.
	expect(
		(await call("/api/sessions", { cookie: ana.cookie })).headers.get(
			"set-cookie",
		),
	).toContain("Max-Age=3600");
	// Within the minute, nothing is written again.
	tick(30 * 1000);
	expect(
		(await call("/api/sessions", { cookie: ana.cookie })).headers.get(
			"set-cookie",
		),
	).toBeNull();
	// Over an hour without a visit, before any sweep: nobody.
	tick(61 * 60 * 1000);
	expect((await call("/api/sessions", { cookie: ana.cookie })).status).toBe(
		401,
	);
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
	const ana = await visitor();
	const forged = await call("/api/turns", {
		method: "POST",
		cookie: ana.cookie,
		origin: "https://evil.example",
		body: { prompt: "a red fox", modelIds: ["fake/alpha"] },
	});
	expect(forged.status).toBe(403);
	expect(
		await (await call("/api/sessions", { cookie: ana.cookie })).json(),
	).toEqual([]);
	// Nor is a visitor made for another site's page.
	const made = await call("/api/visitor", {
		method: "POST",
		origin: "https://evil.example",
	});
	expect(made.status).toBe(403);
	// Nor is a host the demo does not answer to.
	const host = await call("/api/sessions", { base: "https://evil.example" });
	expect(host.status).toBe(403);
});

test("the counter forgets after its window, gives back refunds, and fails closed", () => {
	let now = 0;
	const counter = new RateCounter({ now: () => now });
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

	// Full of keys still counting, a new key is refused, not let off.
	now = 0;
	const small = new RateCounter({ now: () => now, windowMs: 1000, maxKeys: 2 });
	expect(small.take("x", 1, 1)).toBe(0);
	expect(small.take("y", 1, 1)).toBe(0);
	expect(small.take("z", 1, 1)).toBeGreaterThan(0);
	// Nor is an old one forgotten to make room: it is still held.
	expect(small.take("x", 1, 1)).toBeGreaterThan(0);
	// Once theirs are spent, they go and make room.
	now = 1000;
	expect(small.take("z", 1, 1)).toBe(0);
	expect(small.take("w", 1, 1)).toBe(0);
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
			runtime: {
				localModels: [TINY],
				engines: ENGINES,
				fetch: async (url) =>
					new Response(url.endsWith(".zip") ? ENGINE : WEIGHTS),
			},
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
			runtime: {
				localModels: [TINY],
				engines: ENGINES,
				fetch: async () => new Response("gone", { status: 404 }),
			},
		},
	);
	const said: string[] = [];
	expect(
		await installDemoModel(runtime.models, "tiny", (line) => said.push(line)),
	).toBe(false);
	expect(said.at(-1)).toMatch(/^The demo model Tiny could not be installed/);
});
