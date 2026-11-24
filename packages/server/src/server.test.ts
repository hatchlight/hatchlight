import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	base32Decode,
	FakeProvider,
	LOCAL_USER,
	type TrainerEvent,
	type TrainerStatus,
	type TrainingView,
	totp,
} from "@hatchlight/core";
import { FAST_HASHER, safetensors } from "@hatchlight/core/testing";
import {
	type Access,
	type Agents,
	createApp,
	createRuntime,
	ROUTE_ACCESS,
	type Runtime,
	serverConfig,
} from "./index";

const PASSWORD = "correct horse battery";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Who a request is from: nobody, a browser session, or a program's token. */
interface Who {
	cookie?: string;
	token?: string;
}

interface CallInit {
	method?: string;
	body?: unknown;
	who?: Who;
	headers?: Record<string, string>;
	/** The connection's address. */
	peer?: string;
	/** Where the request was sent; nas.example by default. */
	base?: string;
	/** Aborts when the browser goes away. */
	signal?: AbortSignal;
}

/** A server for nas.example, behind a proxy at 10.0.0.0/8. */
async function serverApp(
	options: {
		trainer?: Runtime["trainer"];
		env?: Record<string, string>;
		/** Stands in for the internet, the cloud services included. */
		fetch?: (url: string, init?: RequestInit) => Promise<Response>;
		passwordHasher?: typeof FAST_HASHER;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-server-mode-"));
	const fake = new FakeProvider();
	const paid = new FakeProvider("paid");
	paid.requiresKey = true;
	// Holds the key the cloud language services use.
	const openai = new FakeProvider("openai", []);
	openai.requiresKey = true;
	const { transport, loraQuota, assetQuotaBytes } = serverConfig(
		{ mode: "server" },
		{
			HATCHLIGHT_PUBLIC_URL: "http://nas.example",
			HATCHLIGHT_ALLOWED_HOSTS: "192.168.1.20",
			HATCHLIGHT_TRUSTED_PROXIES: "10.0.0.0/8",
			...options.env,
		},
	);
	const runtime = await createRuntime({
		dataDir: root,
		providers: [fake, paid, openai],
		assetQuotaBytes,
		localModels: [],
		engines: [],
		server: true,
		passwordHasher: options.passwordHasher ?? FAST_HASHER,
		hardware: async () => ({
			os: "linux",
			arch: "x64",
			wsl: false,
			memoryBytes: 8 * 1024 ** 3,
			gpus: [],
		}),
		checkEngine: async () => null,
		fetch:
			options.fetch ?? (async () => new Response("not here", { status: 404 })),
		trainerOptions: {
			fetch: async () => new Response("not here", { status: 404 }),
		},
	});
	// Requests still under way finish before the database closes.
	const inFlight = new Set<Promise<unknown>>();
	cleanups.push(async () => {
		await Promise.allSettled([...inFlight]);
		await runtime.engine.idle();
		runtime.close();
		await rm(root, { recursive: true });
	});
	await runtime.start();
	const app = createApp({
		...runtime,
		trainer: options.trainer ?? runtime.trainer,
		server: transport ?? undefined,
		loraQuota: loraQuota ?? undefined,
		agents: { status: async () => ({}) } as unknown as Agents,
	});

	const call = (path: string, init: CallInit = {}) => {
		const method = init.method ?? "GET";
		const base = init.base ?? "http://nas.example";
		const headers: Record<string, string> = {};
		// Browsers name the origin of every change.
		if (!["GET", "HEAD"].includes(method))
			headers.origin = new URL(base).origin;
		const raw =
			init.body instanceof Uint8Array || init.body instanceof ReadableStream;
		if (init.body !== undefined && !raw) {
			headers["content-type"] = "application/json";
		}
		if (init.who?.cookie)
			headers.cookie = `hatchlight_session=${init.who.cookie}`;
		if (init.who?.token) headers.authorization = `Bearer ${init.who.token}`;
		const request = app.request(
			`${base}${path}`,
			{
				method,
				signal: init.signal,
				headers: { ...headers, ...init.headers },
				body:
					init.body === undefined
						? undefined
						: raw
							? (init.body as Uint8Array)
							: JSON.stringify(init.body),
			},
			{ peer: init.peer ?? "192.168.1.50" },
		);
		const pending = Promise.resolve(request);
		inFlight.add(pending);
		void pending.finally(() => inFlight.delete(pending));
		return pending;
	};
	const cookieOf = (response: Response): string => {
		const match = /hatchlight_session=([^;]+)/.exec(
			response.headers.get("set-cookie") ?? "",
		);
		if (!match?.[1]) throw new Error(`No session cookie (${response.status})`);
		return match[1];
	};
	const setupOwner = async (): Promise<Who> => {
		const response = await call("/api/setup", {
			method: "POST",
			body: {
				code: runtime.accounts.setupCode(),
				username: "owner",
				password: PASSWORD,
			},
		});
		expect(response.status).toBe(201);
		return { cookie: cookieOf(response) };
	};
	let joined = 0;
	/** Someone who joined through an invite from `by`. */
	const invite = async (
		by: Who,
		terms: Record<string, unknown> = {},
		username = `person${++joined}`,
	): Promise<Who & { username: string }> => {
		const created = await call("/api/invites", {
			method: "POST",
			body: { role: "member", ...terms },
			who: by,
		});
		expect(created.status).toBe(201);
		const { token } = (await created.json()) as { token: string };
		const accepted = await call(`/api/invites/${token}/accept`, {
			method: "POST",
			body: { username, password: PASSWORD },
		});
		expect(accepted.status).toBe(201);
		return { cookie: cookieOf(accepted), username };
	};
	const userId = (username: string) =>
		runtime.accounts.findUser(username)?.id as string;
	return {
		call,
		runtime,
		setupOwner,
		invite,
		cookieOf,
		userId,
		root,
		paid,
		fake,
	};
}

const errorCode = async (response: Response) =>
	((await response.json()) as { code?: string }).code;

test("nothing but the public routes answers before signing in", async () => {
	const { call } = await serverApp();
	expect((await call("/api/health")).status).toBe(200);
	expect(await (await call("/api/server")).json()).toEqual({
		mode: "server",
		secure: false,
	});
	expect(await (await call("/api/setup")).json()).toEqual({ needed: true });
	const models = await call("/api/models");
	expect(models.status).toBe(401);
	expect(await errorCode(models)).toBe("signInRequired");
	// Even routes that do not exist say nothing more.
	expect((await call("/api/nothing-here")).status).toBe(401);
});

test("the owner sets up the server with the code from its log", async () => {
	const { call, runtime, cookieOf } = await serverApp();
	// Made before there were accounts: it becomes the owner's.
	await runtime.service.startSession(LOCAL_USER, "before accounts");

	const wrong = await call("/api/setup", {
		method: "POST",
		body: { code: "AAAA-BBBB-CCCC", username: "owner", password: PASSWORD },
	});
	expect(wrong.status).toBe(403);
	expect(await errorCode(wrong)).toBe("badSetupCode");

	const done = await call("/api/setup", {
		method: "POST",
		body: {
			code: runtime.accounts.setupCode(),
			username: "owner",
			password: PASSWORD,
		},
	});
	expect(done.status).toBe(201);
	expect(await done.json()).toMatchObject({ username: "owner", role: "owner" });
	const owner = { cookie: cookieOf(done) };
	const sessions = (await (
		await call("/api/sessions", { who: owner })
	).json()) as { title: string }[];
	expect(sessions.map((s) => s.title)).toEqual(["before accounts"]);
	expect(await (await call("/api/setup")).json()).toEqual({ needed: false });
	expect(runtime.accounts.setupCode()).toBeNull();
});

test("signing in says nothing about which part was wrong, and slows guessing", async () => {
	const { call, setupOwner } = await serverApp();
	await setupOwner();
	const login = (username: string, password: string, peer?: string) =>
		call("/api/login", {
			method: "POST",
			body: { username, password },
			peer,
		});
	const wrongUser = await login("nobody", PASSWORD);
	const wrongPassword = await login("owner", "not the password");
	expect(wrongUser.status).toBe(401);
	expect(wrongPassword.status).toBe(401);
	expect(await wrongUser.json()).toEqual(await wrongPassword.json());

	// Five tries for a name from one address; then each waits.
	for (let i = 0; i < 4; i++) await login("owner", "not the password");
	const slowed = await login("owner", PASSWORD);
	expect(slowed.status).toBe(429);
	expect(await errorCode(slowed)).toBe("tooManyAttempts");
	expect(Number(slowed.headers.get("retry-after"))).toBeGreaterThan(0);
	// Another address is not locked out of the account, nor another name.
	expect((await login("owner", PASSWORD, "192.168.1.99")).status).toBe(200);
	expect((await login("nobody-else", "x")).status).toBe(401);
});

test("guesses sent all at once are counted before they are checked", async () => {
	const { call, setupOwner } = await serverApp();
	await setupOwner();
	const responses = await Promise.all(
		Array.from({ length: 20 }, () =>
			call("/api/login", {
				method: "POST",
				body: { username: "owner", password: "not the password" },
			}),
		),
	);
	const statuses = responses.map((r) => r.status);
	expect(statuses.filter((s) => s === 401)).toHaveLength(5);
	expect(statuses.filter((s) => s === 429)).toHaveLength(15);
});

test("someone guessing a name does not lock its owner out", async () => {
	const { call, setupOwner } = await serverApp();
	await setupOwner();
	for (let i = 0; i < 12; i++) {
		await call("/api/login", {
			method: "POST",
			body: { username: "owner", password: "not the password" },
			peer: "203.0.113.7",
		});
	}
	const owner = await call("/api/login", {
		method: "POST",
		body: { username: "owner", password: PASSWORD },
		peer: "198.51.100.4",
	});
	expect(owner.status).toBe(200);
});

test("setup and invite guesses do not use up signing in", async () => {
	const { call, setupOwner } = await serverApp();
	await setupOwner();
	for (let i = 0; i < 25; i++) {
		await call("/api/invites/made-up/accept", {
			method: "POST",
			body: { username: "intruder", password: PASSWORD },
		});
	}
	const login = await call("/api/login", {
		method: "POST",
		body: { username: "owner", password: PASSWORD },
	});
	expect(login.status).toBe(200);
	// Too long to be anyone's name: refused before it is counted or kept.
	const long = await call("/api/login", {
		method: "POST",
		body: { username: "x".repeat(33), password: PASSWORD },
	});
	expect(long.status).toBe(400);
});

test("the cookie is __Host- and Secure over https, and plain over http", async () => {
	const { call, setupOwner } = await serverApp();
	await setupOwner();
	const proxied = await call("/api/login", {
		method: "POST",
		base: "http://hatchlight:4096",
		peer: "10.0.0.5",
		headers: {
			"x-forwarded-proto": "https",
			"x-forwarded-host": "nas.example",
			origin: "https://nas.example",
		},
		body: { username: "owner", password: PASSWORD },
	});
	expect(proxied.status).toBe(200);
	const cookie = proxied.headers.get("set-cookie") ?? "";
	expect(cookie).toStartWith("__Host-hatchlight=");
	for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
		expect(cookie).toContain(flag);
	}
	expect(cookie).not.toContain("Domain");
	const token = /__Host-hatchlight=([^;]+)/.exec(cookie)?.[1];
	const me = await call("/api/account", {
		base: "http://hatchlight:4096",
		peer: "10.0.0.5",
		headers: {
			"x-forwarded-proto": "https",
			"x-forwarded-host": "nas.example",
			cookie: `__Host-hatchlight=${token}`,
		},
	});
	expect(me.status).toBe(200);
	const secure = await call("/api/server", {
		base: "http://hatchlight:4096",
		peer: "10.0.0.5",
		headers: {
			"x-forwarded-proto": "https",
			"x-forwarded-host": "nas.example",
		},
	});
	expect(await secure.json()).toEqual({ mode: "server", secure: true });

	const plain = await call("/api/login", {
		method: "POST",
		body: { username: "owner", password: PASSWORD },
	});
	const plainCookie = plain.headers.get("set-cookie") ?? "";
	expect(plainCookie).toStartWith("hatchlight_session=");
	expect(plainCookie).not.toContain("Secure");
	expect(plainCookie).toContain("HttpOnly");
});

test("people list and end their sessions, and sign out", async () => {
	const { call, setupOwner, cookieOf } = await serverApp();
	const owner = await setupOwner();
	const login = async () =>
		({
			cookie: cookieOf(
				await call("/api/login", {
					method: "POST",
					body: { username: "owner", password: PASSWORD },
					headers: { "user-agent": "Phone" },
				}),
			),
		}) satisfies Who;
	const phone = await login();
	const tablet = await login();
	const list = (await (
		await call("/api/account/sessions", { who: owner })
	).json()) as { id: string; current: boolean; userAgent: string | null }[];
	expect(list).toHaveLength(3);
	expect(list.filter((s) => s.current)).toHaveLength(1);

	const phoneId = (
		(await (await call("/api/account/sessions", { who: phone })).json()) as {
			id: string;
			current: boolean;
		}[]
	).find((s) => s.current)?.id;
	expect(
		(
			await call(`/api/account/sessions/${phoneId}`, {
				method: "DELETE",
				who: owner,
			})
		).status,
	).toBe(204);
	expect((await call("/api/models", { who: phone })).status).toBe(401);

	expect(
		(await call("/api/account/sessions", { method: "DELETE", who: owner }))
			.status,
	).toBe(204);
	expect((await call("/api/models", { who: tablet })).status).toBe(401);
	expect((await call("/api/models", { who: owner })).status).toBe(200);

	const out = await call("/api/logout", { method: "POST", who: owner });
	expect(out.status).toBe(204);
	expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
	expect((await call("/api/models", { who: owner })).status).toBe(401);
});

test("a new password or a disabled account ends the other sessions", async () => {
	const { call, setupOwner, invite, cookieOf, userId } = await serverApp();
	const owner = await setupOwner();
	const member = await invite(owner);
	const second = {
		cookie: cookieOf(
			await call("/api/login", {
				method: "POST",
				body: { username: member.username, password: PASSWORD },
			}),
		),
	};
	const changed = await call("/api/account/password", {
		method: "PUT",
		who: member,
		body: { current: PASSWORD, next: "a whole new password" },
	});
	expect(changed.status).toBe(204);
	expect((await call("/api/models", { who: second })).status).toBe(401);
	expect((await call("/api/models", { who: member })).status).toBe(200);

	const disabled = await call(`/api/users/${userId(member.username)}`, {
		method: "PATCH",
		who: owner,
		body: { disabled: true },
	});
	expect(disabled.status).toBe(200);
	expect((await call("/api/models", { who: member })).status).toBe(401);
});

test("a console reset password must be changed before anything else", async () => {
	const { call, setupOwner, invite, cookieOf, userId, runtime } =
		await serverApp();
	const owner = await setupOwner();
	const member = await invite(owner);
	const password = await runtime.accounts.resetPasswordFromConsole(
		userId(member.username),
	);
	const signed = await call("/api/login", {
		method: "POST",
		body: { username: member.username, password },
	});
	expect(await signed.json()).toMatchObject({ mustChangePassword: true });
	const who = { cookie: cookieOf(signed) };
	const blocked = await call("/api/models", { who });
	expect(blocked.status).toBe(403);
	expect(await errorCode(blocked)).toBe("passwordChangeRequired");
	expect((await call("/api/account", { who })).status).toBe(200);
	await call("/api/account/password", {
		method: "PUT",
		who,
		body: { current: password, next: "my very own password" },
	});
	expect((await call("/api/models", { who })).status).toBe(200);
});

test("admins give out reset links, never passwords, and only for members", async () => {
	const { call, setupOwner, invite, userId } = await serverApp();
	const owner = await setupOwner();
	const admin = await invite(owner, { role: "admin" });
	const other = await invite(owner, { role: "admin" });
	const member = await invite(owner);
	const reset = (who: Who, username: string) =>
		call(`/api/users/${userId(username)}/password`, { method: "POST", who });
	expect((await reset(admin, other.username)).status).toBe(403);
	expect((await reset(admin, admin.username)).status).toBe(403);
	// Nor change their own limit.
	const own = await call(`/api/users/${userId(admin.username)}`, {
		method: "PATCH",
		who: admin,
		body: { monthlyLimitUsd: null },
	});
	expect(own.status).toBe(403);

	const created = await reset(admin, member.username);
	expect(created.status).toBe(201);
	const link = (await created.json()) as { token: string; password?: string };
	expect(link.password).toBeUndefined();
	expect(
		await (await call(`/api/password-resets/${link.token}`)).json(),
	).toEqual({ username: member.username });
	const set = await call(`/api/password-resets/${link.token}`, {
		method: "POST",
		body: { password: "chosen by the member" },
	});
	expect(set.status).toBe(204);
	// Signed out everywhere; the new password works, the link no more.
	expect((await call("/api/models", { who: member })).status).toBe(401);
	expect(
		(
			await call("/api/login", {
				method: "POST",
				body: { username: member.username, password: "chosen by the member" },
			})
		).status,
	).toBe(200);
	expect((await call(`/api/password-resets/${link.token}`)).status).toBe(404);
});

test("two-step sign-in is set up with the password and a code, then asked for", async () => {
	const { call, setupOwner } = await serverApp();
	const owner = await setupOwner();
	const { secret, uri } = (await (
		await call("/api/account/totp", { method: "POST", who: owner })
	).json()) as { secret: string; uri: string };
	expect(uri).toStartWith("otpauth://totp/Hatchlight%3Aowner?");
	// The code of the next step: the current one turns it on and is spent.
	const code = (stepsAhead = 0) =>
		totp(
			base32Decode(secret) as Uint8Array,
			Math.floor(Date.now() / 1000) + 30 * stepsAhead,
		);
	const enable = (body: Record<string, unknown>) =>
		call("/api/account/totp", { method: "PUT", who: owner, body });
	expect(
		(await enable({ secret, code: "000000", password: PASSWORD })).status,
	).toBe(403);
	expect(
		await errorCode(
			await enable({ secret, code: code(), password: "not the password" }),
		),
	).toBe("badPassword");
	// Taken together, so a step ending meanwhile changes nothing.
	const [current, next] = [code(), code(1)];
	expect(
		(await enable({ secret, code: current, password: PASSWORD })).status,
	).toBe(204);

	const login = (totpCode?: string) =>
		call("/api/login", {
			method: "POST",
			body: { username: "owner", password: PASSWORD, totp: totpCode },
		});
	const asked = await login();
	expect(asked.status).toBe(401);
	expect(await errorCode(asked)).toBe("totpRequired");
	// Each code works once.
	expect(await errorCode(await login(current))).toBe("badTotp");
	expect((await login(next)).status).toBe(200);
	expect(await errorCode(await login(next))).toBe("badTotp");
});

test("people see only their own sessions, pictures, jobs and events", async () => {
	const { call, setupOwner, invite } = await serverApp();
	const owner = await setupOwner();
	const ana = await invite(owner);
	const bia = await invite(owner);

	// Bia listens first.
	const stream = await call("/api/events", { who: bia });
	const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
	let heard = "";
	const listening = (async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			heard += new TextDecoder().decode(value);
		}
	})();

	const upload = await call("/api/assets", {
		method: "POST",
		who: ana,
		body: PNG,
		headers: { "content-type": "image/png" },
	});
	const asset = (await upload.json()) as { id: string };
	const created = await call("/api/turns", {
		method: "POST",
		who: ana,
		body: { prompt: "ana's fox", modelIds: ["fake/alpha"] },
	});
	expect(created.status).toBe(201);
	const { session, turn } = (await created.json()) as {
		session: { id: string };
		turn: { jobs: { id: string }[] };
	};
	const job = turn.jobs[0]?.id as string;

	for (const [method, path] of [
		["GET", `/api/sessions/${session.id}`],
		["GET", `/api/assets/${asset.id}`],
		["POST", `/api/jobs/${job}/cancel`],
		["POST", `/api/jobs/${job}/retry`],
		["GET", `/api/sessions/${session.id}/assistant`],
	] as const) {
		expect((await call(path, { method, who: bia })).status).toBe(404);
		// The same ids answer their owner.
		if (method === "GET") {
			expect((await call(path, { method, who: ana })).status).toBe(200);
		}
	}
	expect(await (await call("/api/sessions", { who: bia })).json()).toEqual([]);
	// Using another's picture as a reference finds nothing.
	const borrowed = await call("/api/turns", {
		method: "POST",
		who: bia,
		body: {
			prompt: "x",
			modelIds: ["fake/alpha"],
			referenceAssetIds: [asset.id],
		},
	});
	expect(borrowed.status).toBe(400);
	expect(await errorCode(borrowed)).toBe("referenceNotFound");

	// Ana's job finishes; Bia's stream heard nothing of it.
	await new Promise((resolve) => setTimeout(resolve, 2500));
	const gallery = (await (
		await call("/api/gallery", { who: ana })
	).json()) as unknown[];
	expect(gallery.length).toBeGreaterThan(0);
	expect(await (await call("/api/gallery", { who: bia })).json()).toEqual([]);
	expect(heard).toContain("event: ready");
	expect(heard).not.toContain(job);
	expect(heard).not.toContain("ana's fox");
	await reader.cancel();
	await listening;
});

test("a training shows only to whoever started it, and to admins", async () => {
	let training: TrainingView = {
		id: "trn_1",
		name: "ana's dog",
		trigger: "ohwx",
		state: "running",
		stage: "training",
		step: 1,
		steps: 10,
		secondsLeft: null,
		startedAt: 1,
		finishedAt: null,
		freeMemoryBytes: null,
		loraId: null,
		samples: [],
		savedStep: null,
		keptStep: null,
		error: null,
	} as unknown as TrainingView;
	let status: TrainerStatus = {
		state: "ready",
		install: null,
		error: null,
		downloadBytes: 0,
		training: null,
	} as unknown as TrainerStatus;
	const listeners = new Set<(event: TrainerEvent) => void>();
	const trainer = {
		status: async () => status,
		subscribe: (listener: (event: TrainerEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		assertCanTrain: async () => {},
		train: async (request: { startedBy?: TrainingView["startedBy"] }) => {
			training = { ...training, startedBy: request.startedBy ?? null };
			status = { ...status, training };
			return training;
		},
		cancelTraining: () => {},
		sampleFile: () => null,
	} as unknown as Runtime["trainer"];
	const { call, setupOwner, invite } = await serverApp({ trainer });
	const owner = await setupOwner();
	const ana = await invite(owner, { canTrain: true });
	const bia = await invite(owner, { canTrain: true });

	const stream = await call("/api/events", { who: bia });
	const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
	await reader.read();

	const started = await call("/api/trainings", {
		method: "POST",
		who: ana,
		body: {
			name: "ana's dog",
			trigger: "ohwx",
			steps: 10,
			pictures: [],
			consent: true,
		},
	});
	expect(started.status).toBe(202);
	const seen = async (who: Who) =>
		((await (await call("/api/trainer", { who })).json()) as TrainerStatus)
			.training?.name ?? null;
	expect(await seen(ana)).toBe("ana's dog");
	expect(await seen(bia)).toBeNull();
	// Those who run the server see it, and who started it.
	expect(await seen(owner)).toBe("ana's dog");
	const forOwner = (await (
		await call("/api/trainer", { who: owner })
	).json()) as TrainerStatus;
	expect(forOwner.training?.startedBy?.name).toBe(ana.username);

	for (const listener of listeners) {
		listener({ type: "trainer.changed", trainer: status });
	}
	const { value } = await reader.read();
	const event = new TextDecoder().decode(value);
	expect(event).toContain("trainer.changed");
	expect(event).not.toContain("ana's dog");
	await reader.cancel();

	// Others cannot stop it; an admin can.
	const stop = await call("/api/trainings/cancel", {
		method: "POST",
		who: bia,
	});
	expect(stop.status).toBe(403);
	expect(
		(await call("/api/trainings/cancel", { method: "POST", who: owner }))
			.status,
	).toBe(204);
});

test("paid models need permission, and stop at the monthly limit", async () => {
	const { call, setupOwner, invite, userId } = await serverApp();
	const owner = await setupOwner();
	await call("/api/providers/paid/key", {
		method: "PUT",
		who: owner,
		body: { key: "server-key" },
	});
	const member = await invite(owner);
	const paidTurn = (who: Who) =>
		call("/api/turns", {
			method: "POST",
			who,
			body: { prompt: "x", modelIds: ["paid/alpha"] },
		});

	const refused = await paidTurn(member);
	expect(refused.status).toBe(403);
	expect(await errorCode(refused)).toBe("paidNotAllowed");
	const providers = (await (
		await call("/api/providers", { who: member })
	).json()) as { id: string; hasKey: boolean }[];
	expect(providers.find((p) => p.id === "paid")?.hasKey).toBe(false);
	// Free models are fine.
	expect(
		(
			await call("/api/turns", {
				method: "POST",
				who: member,
				body: { prompt: "x", modelIds: ["fake/alpha"] },
			})
		).status,
	).toBe(201);

	const id = userId(member.username);
	await call(`/api/users/${id}`, {
		method: "PATCH",
		who: owner,
		body: { canUsePaid: true },
	});
	expect((await paidTurn(member)).status).toBe(201);
	await call(`/api/users/${id}`, {
		method: "PATCH",
		who: owner,
		body: { monthlyLimitUsd: 0 },
	});
	const limited = await paidTurn(member);
	expect(limited.status).toBe(403);
	expect(await errorCode(limited)).toBe("monthlyLimitReached");
	// The owner's own spending is not limited by it.
	expect((await paidTurn(owner)).status).toBe(201);
});

test("the last owner can be neither demoted nor disabled", async () => {
	const { call, setupOwner, userId, invite } = await serverApp();
	const owner = await setupOwner();
	const id = userId("owner");
	for (const body of [{ role: "admin" }, { disabled: true }]) {
		const response = await call(`/api/users/${id}`, {
			method: "PATCH",
			who: owner,
			body,
		});
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe("lastOwner");
	}
	// Admins cannot make owners.
	const admin = await invite(owner, { role: "admin" });
	const member = await invite(owner);
	const promote = await call(`/api/users/${userId(member.username)}`, {
		method: "PATCH",
		who: admin,
		body: { role: "owner" },
	});
	expect(promote.status).toBe(403);
	const ownerInvite = await call("/api/invites", {
		method: "POST",
		who: admin,
		body: { role: "owner" },
	});
	expect(ownerInvite.status).toBe(403);
});

test("an API token acts for its person, and only to use the server", async () => {
	const { call, setupOwner, runtime, userId } = await serverApp();
	await setupOwner();
	const token = runtime.accounts.createApiToken(userId("owner"), {
		name: "agent",
	});
	// A program sends no Origin; its token shows it is not another website.
	const turn = await call("/api/turns", {
		method: "POST",
		who: { token },
		headers: { origin: "" },
		body: { prompt: "x", modelIds: ["fake/alpha"] },
	});
	expect(turn.status).toBe(201);
	// With a cookie beside it, it could be a browser: the origin is checked.
	const withCookie = await call("/api/turns", {
		method: "POST",
		who: { token },
		headers: { origin: "", cookie: "hatchlight_session=anything" },
		body: { prompt: "x", modelIds: ["fake/alpha"] },
	});
	expect(withCookie.status).toBe(403);
	expect(await withCookie.json()).toEqual({ error: "Missing origin" });
	// Not for managing the server or accounts, even an owner's.
	expect((await call("/api/users", { who: { token } })).status).toBe(403);
	expect((await call("/api/account", { who: { token } })).status).toBe(403);
	for (const [method, path] of [
		["POST", "/api/invites"],
		["PUT", "/api/providers/paid/key"],
		["POST", "/api/trainer/install"],
		["POST", "/api/logout"],
	] as const) {
		const response = await call(path, {
			method,
			who: { token },
			headers: { origin: "" },
			body: {},
		});
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe("forbidden");
	}
	expect(
		(await call("/api/models", { who: { token: "made-up" } })).status,
	).toBe(401);
});

/** Who may call a route, by its access. */
const MAY: Record<Access, string[]> = {
	public: ["anonymous", "member", "trainer", "admin", "owner", "token"],
	account: ["member", "trainer", "admin", "owner"],
	member: ["member", "trainer", "admin", "owner", "token"],
	train: ["trainer", "admin", "owner"],
	admin: ["admin", "owner"],
	owner: ["owner"],
};

test("every route lets in exactly who it should", async () => {
	const { call, setupOwner, invite, runtime, userId } = await serverApp();
	const owner = await setupOwner();
	const principals: Record<string, Who> = {
		anonymous: {},
		member: await invite(owner, {}, "member"),
		trainer: await invite(owner, { canTrain: true }, "trainer"),
		admin: await invite(owner, { role: "admin" }, "admin"),
		owner,
		token: {
			token: runtime.accounts.createApiToken(userId("member"), { name: "t" }),
		},
	};
	// Signing out last, so the sessions stay for the other routes.
	const routes = Object.entries(ROUTE_ACCESS).sort(([a], [b]) =>
		a === "POST /api/logout" ? 1 : b === "POST /api/logout" ? -1 : 0,
	);
	const wrong: string[] = [];
	for (const [route, access] of routes) {
		const [method = "GET", pattern = ""] = route.split(" ");
		const path = pattern.replace(/:\w+/g, "x");
		for (const [name, who] of Object.entries(principals)) {
			const response = await call(path, {
				method,
				who,
				body: ["GET", "HEAD"].includes(method) ? undefined : {},
			});
			// Only refusals matter, and they are JSON; streams are left unread.
			const isJson = response.headers
				.get("content-type")
				?.includes("application/json");
			if (!isJson) await response.body?.cancel();
			const body = (isJson ? await response.json() : {}) as { code?: string };
			const refused =
				response.status === 401 ||
				(response.status === 403 &&
					["forbidden", "signInRequired"].includes(body.code ?? ""));
			const allowed = MAY[access].includes(name);
			if (refused === allowed) {
				wrong.push(
					`${route} as ${name}: ${response.status} ${body.code ?? ""}`,
				);
			}
		}
	}
	expect(wrong).toEqual([]);
}, 60_000);

test("every API route declares who may call it", async () => {
	const { runtime } = await serverApp();
	const { transport } = serverConfig(
		{ mode: "server" },
		{ HATCHLIGHT_PUBLIC_URL: "https://nas.example" },
	);
	const app = createApp({
		...runtime,
		server: transport ?? undefined,
		agents: {} as Agents,
	});
	const routes = new Set(
		app.routes
			// Middleware and the catch-all apply to every route.
			.filter((route) => route.method !== "ALL" && route.path !== "/api/*")
			.filter((route) => route.path.startsWith("/api/"))
			.map((route) => `${route.method} ${route.path}`),
	);
	const undeclared = [...routes].filter((route) => !(route in ROUTE_ACCESS));
	expect(undeclared).toEqual([]);
	// Nothing declared that no longer exists.
	const stale = Object.keys(ROUTE_ACCESS).filter((route) => !routes.has(route));
	expect(stale).toEqual([]);
});

// Transport: hosts, origins, proxies and headers.

const PROXIED = {
	"x-forwarded-proto": "https",
	"x-forwarded-host": "nas.example",
};

test("forwarded headers count only from a trusted proxy", async () => {
	const { call, setupOwner } = await serverApp();
	await setupOwner();
	const proxied = await call("/api/login", {
		method: "POST",
		base: "http://hatchlight:4096",
		peer: "10.0.0.5",
		headers: { ...PROXIED, origin: "https://nas.example" },
		body: { username: "owner", password: PASSWORD },
	});
	expect(proxied.status).toBe(200);
	expect(proxied.headers.get("strict-transport-security")).toContain(
		"max-age=",
	);

	// The same headers from anyone else are ignored, and the host they
	// reached is not this server's.
	const direct = await call("/api/health", {
		base: "http://hatchlight:4096",
		peer: "203.0.113.9",
		headers: PROXIED,
	});
	expect(direct.status).toBe(403);
	expect(direct.headers.get("strict-transport-security")).toBeNull();
	// A trusted proxy cannot name a host that is not this server's either.
	const forged = await call("/api/health", {
		base: "http://hatchlight:4096",
		peer: "10.0.0.5",
		headers: { ...PROXIED, "x-forwarded-host": "evil.example" },
	});
	expect(forged.status).toBe(403);
});

test("changes must come from the server's own https origin", async () => {
	const { call } = await serverApp();
	const post = (headers: Record<string, string>) =>
		call("/api/login", {
			method: "POST",
			base: "http://hatchlight:4096",
			peer: "10.0.0.5",
			headers: { ...PROXIED, ...headers },
			body: { username: "x", password: "y" },
		});
	// The page is on https: its http twin is another origin.
	expect((await post({ origin: "http://nas.example" })).status).toBe(403);
	expect((await post({ origin: "https://evil.example" })).status).toBe(403);
	expect((await post({ origin: "null" })).status).toBe(403);
	const missing = await post({ origin: "" });
	expect(missing.status).toBe(403);
	expect(await missing.json()).toEqual({ error: "Missing origin" });
	expect(
		(await post({ origin: "", "sec-fetch-site": "cross-site" })).status,
	).toBe(403);
	// Past the origin check, the sign-in itself is what fails.
	expect(
		(await post({ origin: "", "sec-fetch-site": "same-origin" })).status,
	).toBe(401);
	expect((await post({ origin: "https://nas.example" })).status).toBe(401);
});

test("the public, extra and loopback hosts answer, and no other", async () => {
	const { call } = await serverApp();
	expect((await call("/api/health")).status).toBe(200);
	expect(
		(await call("/api/health", { base: "http://192.168.1.20:4096" })).status,
	).toBe(200);
	// A name that points at this server but is not its own: DNS rebinding.
	expect(
		(await call("/api/health", { base: "http://evil.example" })).status,
	).toBe(403);
	// Health checks from the container itself.
	const health = await call("/api/health", {
		base: "http://localhost:4096",
		peer: "127.0.0.1",
	});
	expect(health.status).toBe(200);
	expect(await health.json()).toEqual({ ok: true });
});

test("what only works on the server's own computer is left out", async () => {
	const { call, setupOwner } = await serverApp();
	const owner = await setupOwner();
	for (const [method, path, body] of [
		["POST", "/api/local-models/location", { path: "/mnt/elsewhere" }],
		["PUT", "/api/agents/claude-desktop", { allowPaid: false }],
		["DELETE", "/api/agents/claude-desktop", {}],
	] as const) {
		const response = await call(path, { method, who: owner, body });
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe("notOnServer");
	}
});

test("only admins and owners see where the server keeps its files", async () => {
	const { call, setupOwner, invite } = await serverApp();
	const owner = await setupOwner();
	const admin = await invite(owner, { role: "admin" });
	const member = await invite(owner);
	type View = { disk: { path: string; changeable: boolean } };
	const disk = async (who: Who) =>
		((await (await call("/api/local-models", { who })).json()) as View).disk;
	expect((await disk(owner)).path).not.toBe("");
	expect((await disk(admin)).path).not.toBe("");
	expect(await disk(member)).toMatchObject({ path: "", changeable: false });
});

test("a setup cut short before the files moved is finished at the next start", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-adopt-"));
	cleanups.push(() => rm(root, { recursive: true }));
	const start = () =>
		createRuntime({
			dataDir: root,
			providers: [new FakeProvider()],
			localModels: [],
			engines: [],
			server: true,
			passwordHasher: FAST_HASHER,
		});
	// Before accounts: a picture made on the install.
	const before = await start();
	const asset = await before.service.uploadAsset(LOCAL_USER, PNG);
	before.close();

	// Setup moved the rows, then the process died before moving the files.
	const crashed = await start();
	const owner = await crashed.accounts.setup({
		code: crashed.accounts.setupCode() as string,
		username: "owner",
		password: PASSWORD,
	});
	crashed.close();
	const ownerDir = join(root, "assets", owner.user.id);
	const localDir = join(root, "assets", "local");
	await rename(ownerDir, localDir);
	const ctx = { userId: owner.user.id };

	const restarted = await start();
	cleanups.push(async () => restarted.close());
	const file = await restarted.service.getAssetFile(ctx, asset.id);
	expect(file.blob.size).toBe(PNG.byteLength);
	expect(
		await Bun.file(join(localDir, asset.hash.slice(0, 2), asset.hash)).exists(),
	).toBe(false);
	// Nothing left to move is fine too.
	await restarted.accounts.resumeAdoption();
});

test("deleting sessions does not give back what was spent", async () => {
	const { call, setupOwner, invite, userId, runtime } = await serverApp();
	const owner = await setupOwner();
	await call("/api/providers/paid/key", {
		method: "PUT",
		who: owner,
		body: { key: "server-key" },
	});
	const member = await invite(owner, {
		canUsePaid: true,
		monthlyLimitUsd: 0.015,
	});
	const paidTurn = () =>
		call("/api/turns", {
			method: "POST",
			who: member,
			body: { prompt: "x", modelIds: ["paid/alpha"] },
		});
	// Two pictures at a cent each: the second goes over the limit.
	for (let i = 0; i < 2; i++) {
		expect((await paidTurn()).status).toBe(201);
		await runtime.engine.idle();
	}
	expect(await errorCode(await paidTurn())).toBe("monthlyLimitReached");
	const sessions = (await (
		await call("/api/sessions", { who: member })
	).json()) as { id: string }[];
	for (const session of sessions) {
		await call(`/api/sessions/${session.id}`, {
			method: "DELETE",
			who: member,
		});
	}
	expect(runtime.accounts.spentThisMonth(userId(member.username))).toBeCloseTo(
		0.02,
	);
	expect(await errorCode(await paidTurn())).toBe("monthlyLimitReached");
});

test("language services on the server's keys count toward the monthly limit", async () => {
	let calls = 0;
	const { call, setupOwner, invite, runtime, userId } = await serverApp({
		fetch: async (url) => {
			if (!url.startsWith("https://api.openai.com/")) {
				return new Response("not here", { status: 404 });
			}
			calls++;
			return Response.json({
				choices: [{ message: { content: "a richer prompt" } }],
			});
		},
	});
	const owner = await setupOwner();
	await call("/api/providers/openai/key", {
		method: "PUT",
		who: owner,
		body: { key: "server-key" },
	});
	const member = await invite(owner, {
		canUsePaid: true,
		monthlyLimitUsd: 0.025,
	});
	await call("/api/settings", {
		method: "PUT",
		who: member,
		body: { improveWith: "openai" },
	});
	const improve = () =>
		call("/api/prompts/improve", {
			method: "POST",
			who: member,
			body: { prompt: "a fox", modelIds: ["fake/alpha"], editing: false },
		});
	for (let i = 0; i < 3; i++) expect((await improve()).status).toBe(200);
	expect(runtime.accounts.spentThisMonth(userId(member.username))).toBeCloseTo(
		0.03,
	);
	// Over the limit: refused, and the service is not called.
	const refused = await improve();
	expect(refused.status).toBeGreaterThanOrEqual(400);
	expect(calls).toBe(3);
});

test("members may add only so many LoRAs; admins are not held to it", async () => {
	const { call, setupOwner, invite } = await serverApp({
		env: { HATCHLIGHT_LORA_FILES_PER_PERSON: "1" },
	});
	const owner = await setupOwner();
	const member = await invite(owner, { canTrain: true });
	const add = (who: Who, name: string, title: string) =>
		call(`/api/loras?${new URLSearchParams({ name })}`, {
			method: "POST",
			who,
			headers: { "content-type": "application/octet-stream" },
			body: safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"], {
				"modelspec.title": title,
			}),
		});
	const first = await add(member, "one.safetensors", "One");
	expect(first.status).toBe(201);
	const second = await add(member, "two.safetensors", "Two");
	expect(second.status).toBe(403);
	expect(await errorCode(second)).toBe("loraQuotaReached");
	expect((await add(owner, "three.safetensors", "Three")).status).toBe(201);
	// Deleting one makes room again.
	const { id } = (await first.json()) as { id: string };
	await call(`/api/loras/${id}`, { method: "DELETE", who: owner });
	expect((await add(member, "two.safetensors", "Two")).status).toBe(201);
});

test("password checks from one address run one at a time", async () => {
	const seen = { now: 0, most: 0, calls: 0 };
	const { call, setupOwner } = await serverApp({
		passwordHasher: {
			hash: FAST_HASHER.hash,
			verify: async (password, hash) => {
				seen.calls++;
				seen.now++;
				seen.most = Math.max(seen.most, seen.now);
				try {
					// Long enough that checks let through together would overlap.
					await Bun.sleep(5);
					return await FAST_HASHER.verify(password, hash);
				} finally {
					seen.now--;
				}
			},
		},
	});
	await setupOwner();
	const login = (peer: string) =>
		call("/api/login", {
			method: "POST",
			body: { username: "owner", password: "not the password" },
			peer,
		});
	await Promise.all(Array.from({ length: 5 }, () => login("192.168.1.50")));
	expect(seen.calls).toBe(5);
	expect(seen.most).toBe(1);
	// Other addresses are not held up by it.
	seen.most = 0;
	await Promise.all(
		["192.168.1.61", "192.168.1.62", "192.168.1.63"].map((peer) => login(peer)),
	);
	expect(seen.most).toBeGreaterThan(1);
});

test("a browser that signed in before gets past strangers guessing its name", async () => {
	const { call, runtime } = await serverApp();
	const setup = await call("/api/setup", {
		method: "POST",
		body: {
			code: runtime.accounts.setupCode(),
			username: "owner",
			password: PASSWORD,
		},
	});
	const cookies = setup.headers.getSetCookie();
	const device = cookies.find((c) => c.startsWith("hatchlight_device="));
	expect(device).toContain("HttpOnly");
	expect(device).toContain("SameSite=Lax");
	const deviceCookie = device?.split(";")[0] as string;
	// Sixty addresses each guess once: the name as a whole is now slowed.
	for (let i = 0; i < 60; i++) {
		await call("/api/login", {
			method: "POST",
			body: { username: "owner", password: "not the password" },
			peer: `203.0.113.${i + 1}`,
		});
	}
	const login = (headers: Record<string, string> = {}) =>
		call("/api/login", {
			method: "POST",
			body: { username: "owner", password: PASSWORD },
			peer: "198.51.100.4",
			headers,
		});
	// An unknown browser waits like everyone else.
	expect((await login()).status).toBe(429);
	// The owner's own browser gets in.
	expect((await login({ cookie: deviceCookie })).status).toBe(200);
	// A cookie for another name, or a forged one, does not help.
	const forged = deviceCookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
	expect((await login({ cookie: forged })).status).toBe(429);
});

test("after a reset, the person is told once who reset it", async () => {
	const { call, setupOwner, invite, userId, cookieOf } = await serverApp();
	const owner = await setupOwner();
	const admin = await invite(owner, { role: "admin" });
	const member = await invite(owner);
	const created = await call(`/api/users/${userId(member.username)}/password`, {
		method: "POST",
		who: admin,
	});
	const { token } = (await created.json()) as { token: string };
	await call(`/api/password-resets/${token}`, {
		method: "POST",
		body: { password: "chosen by the member" },
	});
	const signed = await call("/api/login", {
		method: "POST",
		body: { username: member.username, password: "chosen by the member" },
	});
	const who = { cookie: cookieOf(signed) };
	type Me = { resetNotice: { by: string; at: number } | null };
	const me = async () =>
		(await (await call("/api/account", { who })).json()) as Me;
	expect((await me()).resetNotice?.by).toBe(admin.username);
	expect(
		(await call("/api/account/reset-notice", { method: "DELETE", who })).status,
	).toBe(204);
	expect((await me()).resetNotice).toBeNull();
	// Owners and admins see the last reset in the list of people.
	const people = (await (await call("/api/users", { who: owner })).json()) as {
		username: string;
		lastReset: { by: string } | null;
	}[];
	expect(
		people.find((p) => p.username === member.username)?.lastReset?.by,
	).toBe(admin.username);
});

test("a member's LoRA upload stops as soon as it passes what is left", async () => {
	const { call, setupOwner, invite, root } = await serverApp({
		// About 10 KB each.
		env: { HATCHLIGHT_LORA_GB_PER_PERSON: String(10_000 / 1024 ** 3) },
	});
	const owner = await setupOwner();
	const member = await invite(owner, { canTrain: true });
	let pulled = 0;
	// A file that would go on and on: 1 KB at a time, for 10 MB.
	const endless = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled++;
			if (pulled > 10_000) controller.close();
			else controller.enqueue(new Uint8Array(1024));
		},
	});
	const response = await call(
		`/api/loras?${new URLSearchParams({ name: "big.safetensors" })}`,
		{
			method: "POST",
			who: member,
			headers: { "content-type": "application/octet-stream" },
			body: endless,
		},
	);
	expect(response.status).toBe(403);
	expect(await errorCode(response)).toBe("loraQuotaReached");
	// Stopped near the limit, not at the end of the file.
	expect(pulled).toBeLessThan(100);
	const folder = join(root, "models", "loras");
	const left = await readdir(folder).catch(() => []);
	expect(left.filter((name) => name.endsWith(".part"))).toEqual([]);
});

test("a member uploads one LoRA at a time", async () => {
	const { call, setupOwner, invite } = await serverApp();
	const owner = await setupOwner();
	const member = await invite(owner, { canTrain: true });
	let finish: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const file = safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"], {
		"modelspec.title": "Slow",
	});
	// Sent in two halves, the second once the test says so.
	const slow = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(file.slice(0, 8));
			await held;
			controller.enqueue(file.slice(8));
			controller.close();
		},
	});
	const upload = (body: Uint8Array | ReadableStream, name: string) =>
		call(`/api/loras?${new URLSearchParams({ name })}`, {
			method: "POST",
			who: member,
			headers: { "content-type": "application/octet-stream" },
			body,
		});
	const first = upload(slow, "slow.safetensors");
	await Bun.sleep(50);
	const second = await upload(file, "other.safetensors");
	expect(second.status).toBe(409);
	expect(await errorCode(second)).toBe("loraUploadBusy");
	finish();
	expect((await first).status).toBe(201);
});

test("two-step sign-in moves to another app with the password and both codes", async () => {
	const { call, setupOwner } = await serverApp();
	const owner = await setupOwner();
	const start = async () =>
		(await (
			await call("/api/account/totp", { method: "POST", who: owner })
		).json()) as { secret: string };
	const codes = (secret: string) => {
		const now = Math.floor(Date.now() / 1000);
		const key = base32Decode(secret) as Uint8Array;
		return [totp(key, now), totp(key, now + 30)] as const;
	};
	const old = await start();
	const [oldNow, oldNext] = codes(old.secret);
	await call("/api/account/totp", {
		method: "PUT",
		who: owner,
		body: { secret: old.secret, code: oldNow, password: PASSWORD },
	});
	const fresh = await start();
	const [newNow, newNext] = codes(fresh.secret);
	const move = (body: Record<string, unknown>) =>
		call("/api/account/totp", { method: "PUT", who: owner, body });
	// Without the code of the app in use, it stays where it is.
	const without = await move({
		secret: fresh.secret,
		code: newNow,
		password: PASSWORD,
	});
	expect(await errorCode(without)).toBe("totpRequired");
	expect(
		(
			await move({
				secret: fresh.secret,
				code: newNow,
				password: PASSWORD,
				current: oldNext,
			})
		).status,
	).toBe(204);
	const login = (totpCode: string) =>
		call("/api/login", {
			method: "POST",
			body: { username: "owner", password: PASSWORD, totp: totpCode },
			peer: "198.51.100.8",
		});
	// The old app's codes no longer work; the new app's do.
	expect(
		await errorCode(
			await login(
				totp(
					base32Decode(old.secret) as Uint8Array,
					Math.floor(Date.now() / 1000) + 30,
				),
			),
		),
	).toBe("badTotp");
	expect((await login(newNext)).status).toBe(200);
});

test("a sign-in whose browser left while it waited is never checked", async () => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const checked: string[] = [];
	const { call, setupOwner } = await serverApp({
		passwordHasher: {
			hash: FAST_HASHER.hash,
			verify: async (password, hash) => {
				checked.push(password);
				// The first check holds the line until the test lets it go.
				if (checked.length === 1) await held;
				return FAST_HASHER.verify(password, hash);
			},
		},
	});
	await setupOwner();
	const login = (password: string, signal?: AbortSignal) =>
		call("/api/login", {
			method: "POST",
			body: { username: "owner", password },
			signal,
		});
	const first = login("first password try");
	await Bun.sleep(20);
	const gone = new AbortController();
	const second = login("second password try", gone.signal).then(
		(response) => response.status,
		() => "aborted",
	);
	await Bun.sleep(20);
	gone.abort();
	release();
	expect((await first).status).toBe(401);
	// Answered quietly: a request that went away is not a server error.
	expect(await second).not.toBe(500);
	expect(checked).toEqual(["first password try"]);
});

test("a person's own key is used before the server's, and is not held to the limit", async () => {
	const { call, setupOwner, invite, userId, runtime, paid } = await serverApp();
	const owner = await setupOwner();
	await call("/api/providers/paid/key", {
		method: "PUT",
		who: owner,
		body: { key: "server-key" },
	});
	const member = await invite(owner, { canUsePaid: true, monthlyLimitUsd: 0 });
	const paidTurn = () =>
		call("/api/turns", {
			method: "POST",
			who: member,
			body: { prompt: "x", modelIds: ["paid/alpha"] },
		});
	// The server's key is past its limit for them.
	expect(await errorCode(await paidTurn())).toBe("monthlyLimitReached");
	const set = await call("/api/account/keys/paid", {
		method: "PUT",
		who: member,
		body: { key: "member-key" },
	});
	expect(set.status).toBe(204);
	type Provider = {
		id: string;
		hasKey: boolean;
		keys: { personal: boolean; server: boolean };
	};
	const providers = (await (
		await call("/api/providers", { who: member })
	).json()) as Provider[];
	expect(providers.find((p) => p.id === "paid")).toMatchObject({
		hasKey: true,
		keys: { personal: true, server: true },
	});
	// Their own money: no limit, and their key, not the server's.
	expect((await paidTurn()).status).toBe(201);
	await runtime.engine.idle();
	expect(paid.keysUsed.at(-1)).toBe("member-key");
	// Written down as theirs, and not counted toward the limit.
	const id = userId(member.username);
	expect(runtime.accounts.spentThisMonth(id)).toBe(0);
	// Others still use the server's key.
	const other = await invite(owner, { canUsePaid: true });
	await call("/api/turns", {
		method: "POST",
		who: other,
		body: { prompt: "x", modelIds: ["paid/alpha"] },
	});
	await runtime.engine.idle();
	expect(paid.keysUsed.at(-1)).toBe("server-key");
	// Never sent back.
	const text = await (await call("/api/providers", { who: member })).text();
	expect(text).not.toContain("member-key");
	expect(text).not.toContain("server-key");
});

test("only people who may spend can keep keys of their own", async () => {
	const { call, setupOwner, invite } = await serverApp();
	const owner = await setupOwner();
	const member = await invite(owner);
	const refused = await call("/api/account/keys/paid", {
		method: "PUT",
		who: member,
		body: { key: "k" },
	});
	expect(refused.status).toBe(403);
	expect(await errorCode(refused)).toBe("paidNotAllowed");
	// Nor set the server's.
	const server = await call("/api/providers/paid/key", {
		method: "PUT",
		who: member,
		body: { key: "k" },
	});
	expect(server.status).toBe(403);
	// An owner may keep their own too.
	expect(
		(
			await call("/api/account/keys/paid", {
				method: "PUT",
				who: owner,
				body: { key: "owner-own" },
			})
		).status,
	).toBe(204);
});

test("a member past their room starts no new pictures, but those under way finish", async () => {
	const { call, setupOwner, invite, runtime } = await serverApp({
		// About a hundred bytes: one small picture fills it.
		env: { HATCHLIGHT_ASSET_GB_PER_PERSON: String(100 / 1024 ** 3) },
	});
	const owner = await setupOwner();
	const member = await invite(owner);
	const turn = (who: Who) =>
		call("/api/turns", {
			method: "POST",
			who,
			body: { prompt: "x", modelIds: ["fake/alpha"] },
		});
	type Me = { storage: { usedBytes: number; quotaBytes: number | null } };
	const me = async (who: Who) =>
		((await (await call("/api/account", { who })).json()) as Me).storage;
	expect(await me(member)).toEqual({ usedBytes: 0, quotaBytes: 100 });
	// The first one goes past the room, and still finishes.
	expect((await turn(member)).status).toBe(201);
	await runtime.engine.idle();
	const gallery = (await (
		await call("/api/gallery", { who: member })
	).json()) as unknown[];
	expect(gallery).toHaveLength(1);
	const used = (await me(member)).usedBytes;
	expect(used).toBeGreaterThan(100);
	// Now new pictures, and uploads, wait for room.
	const refused = await turn(member);
	expect(refused.status).toBe(403);
	expect(await errorCode(refused)).toBe("storageFull");
	const upload = await call("/api/assets", {
		method: "POST",
		who: member,
		body: PNG,
		headers: { "content-type": "image/png" },
	});
	expect(await errorCode(upload)).toBe("storageFull");
	// Owners and admins have no such limit.
	expect((await turn(owner)).status).toBe(201);
	expect((await me(owner)).quotaBytes).toBeNull();
});

test("a job tried again is a new picture, held to the room left", async () => {
	const { call, setupOwner, invite, runtime, fake } = await serverApp({
		env: { HATCHLIGHT_ASSET_GB_PER_PERSON: String(100 / 1024 ** 3) },
	});
	const owner = await setupOwner();
	const member = await invite(owner);
	const turn = async () => {
		const response = await call("/api/turns", {
			method: "POST",
			who: member,
			body: { prompt: "x", modelIds: ["fake/alpha"] },
		});
		return ((await response.json()) as { turn: { jobs: { id: string }[] } })
			.turn.jobs[0]?.id as string;
	};
	// A job stopped before it made anything, kept for later.
	let release: () => void = () => {};
	fake.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const kept = await turn();
	await Bun.sleep(20);
	await call(`/api/jobs/${kept}/cancel`, { method: "POST", who: member });
	release();
	fake.gate = null;
	await runtime.engine.idle();
	// The room fills.
	await turn();
	await runtime.engine.idle();
	const retried = await call(`/api/jobs/${kept}/retry`, {
		method: "POST",
		who: member,
	});
	expect(retried.status).toBe(403);
	expect(await errorCode(retried)).toBe("storageFull");
});

test("uploads take turns, and one that would not fit is refused before it is read", async () => {
	const { call, setupOwner, invite } = await serverApp({
		env: { HATCHLIGHT_ASSET_GB_PER_PERSON: String(100 / 1024 ** 3) },
	});
	const owner = await setupOwner();
	const member = await invite(owner);
	const upload = (body: Uint8Array | ReadableStream, headers = {}) =>
		call("/api/assets", {
			method: "POST",
			who: member,
			body,
			headers: { "content-type": "image/png", ...headers },
		});
	// Says it brings more than the room left: refused before it is read.
	let pulled = 0;
	const declared = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled++;
			if (pulled > 20) controller.close();
			else controller.enqueue(new Uint8Array(10).fill(1));
		},
	});
	const big = await upload(declared, { "content-length": "200" });
	expect(await errorCode(big)).toBe("storageFull");
	expect(pulled).toBeLessThan(5);
	// One at a time: a second while the first is still coming is refused.
	let finish: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const slow = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(PNG.slice(0, 4));
			await held;
			controller.enqueue(PNG.slice(4));
			controller.close();
		},
	});
	const first = upload(slow);
	await Bun.sleep(30);
	const second = await upload(PNG);
	expect(second.status).toBe(409);
	expect(await errorCode(second)).toBe("uploadBusy");
	finish();
	expect((await first).status).toBe(201);
	expect((await upload(PNG)).status).toBe(201);
});

test("deleting pictures frees room once no picture of theirs shares the file", async () => {
	const { call, setupOwner, invite, runtime, root, userId } = await serverApp({
		env: { HATCHLIGHT_ASSET_GB_PER_PERSON: String(100 / 1024 ** 3) },
	});
	const owner = await setupOwner();
	const member = await invite(owner);
	const other = await invite(owner);
	const used = () =>
		runtime.accounts.view(
			runtime.accounts.getUser(userId(member.username)) as never,
		).storage.usedBytes;
	const upload = async () =>
		(await (
			await call("/api/assets", {
				method: "POST",
				who: member,
				body: PNG,
				headers: { "content-type": "image/png" },
			})
		).json()) as { id: string; hash: string };
	// The same picture twice: two in the gallery, one file on disk.
	const first = await upload();
	const second = await upload();
	expect(used()).toBe(PNG.byteLength);
	const file = join(
		root,
		"assets",
		userId(member.username),
		first.hash.slice(0, 2),
		first.hash,
	);
	const remove = (id: string, who: Who) =>
		call(`/api/assets/${id}`, { method: "DELETE", who });
	// Nobody else's to delete.
	expect((await remove(first.id, other)).status).toBe(404);
	expect((await remove(first.id, member)).status).toBe(204);
	expect((await call(`/api/assets/${first.id}`, { who: member })).status).toBe(
		404,
	);
	// The other one still shows, so the file stays and still counts.
	expect((await call(`/api/assets/${second.id}`, { who: member })).status).toBe(
		200,
	);
	expect(await Bun.file(file).exists()).toBe(true);
	expect(used()).toBe(PNG.byteLength);
	expect((await remove(second.id, member)).status).toBe(204);
	expect(await Bun.file(file).exists()).toBe(false);
	expect(used()).toBe(0);

	// A picture a turn made: the turn keeps its place without it.
	const turn = await call("/api/turns", {
		method: "POST",
		who: member,
		body: { prompt: "x", modelIds: ["fake/alpha"] },
	});
	const { session } = (await turn.json()) as { session: { id: string } };
	await runtime.engine.idle();
	type Detail = {
		turns: { jobs: { status: string; assets: { id: string }[] }[] }[];
	};
	const detail = async () =>
		(await (
			await call(`/api/sessions/${session.id}`, { who: member })
		).json()) as Detail;
	const made = (await detail()).turns[0]?.jobs[0]?.assets[0]?.id as string;
	expect((await remove(made, member)).status).toBe(204);
	const after = await detail();
	expect(after.turns[0]?.jobs[0]).toMatchObject({
		status: "succeeded",
		assets: [],
	});
	expect(await (await call("/api/gallery", { who: member })).json()).toEqual(
		[],
	);
});
