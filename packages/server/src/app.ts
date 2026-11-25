import {
	AccessError,
	type AccountService,
	type Captioner,
	CodedError,
	type ErrorCode,
	IMPROVE_WITH,
	isDemoSize,
	isImproveWith,
	isTranslateWith,
	type JobEngine,
	type KeySource,
	LOCAL_USER,
	type LocalModelStore,
	type LocalModelsView,
	MAX_CHECKPOINT_BYTES,
	MAX_LORA_BYTES,
	mayUsePaid,
	NotFoundError,
	type PaidRefusal,
	paidError,
	type ReelService,
	SERVER_KEYS,
	type SettingsStore,
	TRANSLATE_WITH,
	type Trainer,
	type TrainerEvent,
	type TrainerStatus,
	type TrainingView,
	type UserContext,
	ValidationError,
} from "@hatchlight/core";
import type { Assistant } from "@hatchlight/tools";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { mountAccounts } from "./accounts-routes";
import type { Agents } from "./agents";
import { requireAccess } from "./auth";
import { DeviceCookies } from "./devices";
import { Limiter } from "./limiter";
import type { AssistantBrain, ImproveRequest } from "./runtime";
import {
	DEFAULT_LORA_QUOTA,
	hostName,
	isLoopback,
	type LoraQuota,
	requestOrigin,
	type ServerTransport,
} from "./transport";

export interface AppOptions {
	service: ReelService;
	engine: JobEngine;
	models: LocalModelStore;
	/** Starts moving the local models to another folder. */
	moveModels?: (path: string) => Promise<void>;
	/** A person's choices the server acts on, such as how to translate. */
	settings?: SettingsStore;
	/** Extra origins allowed to call the API, e.g. the Vite dev server. */
	allowedOrigins?: string[];
	/**
	 * Server mode: several people reach this server over the network, at its
	 * public address. Absent on a personal install, which only answers this
	 * computer.
	 */
	server?: ServerTransport;
	/** Whether keys the person relied on were set aside at start; see Runtime. */
	keysLost?: (user: { userId: string; owner: boolean }) => boolean;
	dismissKeysLost?: (userId: string) => void;
	/** LoRAs each member may add, on a server. Defaults to 20 files, 10 GB. */
	loraQuota?: LoraQuota;
	/**
	 * Signs device cookies; kept in the data directory so they outlive a
	 * restart. Without it, a new one each start.
	 */
	deviceKey?: Uint8Array;
	/** The people of a server, who sign in; needed in server mode. */
	accounts?: AccountService;
	/**
	 * Why a person, and the API token they ask with, may not spend on paid
	 * models now, or null; servers only.
	 */
	paidRefusal?: (who: UserContext, source: KeySource) => PaidRefusal | null;
	/** Maps a request to its user. Local installs have a single user. */
	resolveUser?: (c: Context) => UserContext;
	/** Connects AI agents to this installation; absent where it cannot. */
	agents?: Agents;
	/** Trains LoRAs on this computer; absent where it cannot. */
	trainer?: Trainer;
	/** Captions training pictures; absent where no model can see. */
	captioner?: Captioner;
	/**
	 * Answers MCP over HTTP at /mcp, for agents with an API token; servers
	 * only. Given the request and who it is from, once checked here.
	 */
	mcp?: (
		request: Request,
		caller: { token: string; origin: string; allowPaid: boolean },
		/** The JSON-RPC message, read and checked here already. */
		message: unknown,
	) => Promise<Response>;
	/** Makes and changes pictures by talking; absent where it cannot. */
	assistant?: Assistant;
	/** What a person's assistant thinks with now. */
	assistantBrain?: (ctx: UserContext) => Promise<AssistantBrain>;
	/** A richer prompt for a short idea; absent where no model can write. */
	improvePrompt?: (
		ctx: UserContext,
		request: ImproveRequest,
		signal: AbortSignal,
	) => Promise<string>;
}

/**
 * The longest idea a person may ask to improve: with the instructions and
 * the answer, it must fit the local language model's context.
 */
const MAX_IDEA_LENGTH = 1000;
/** More models than any composer offers at once. */
const MAX_IDEA_MODELS = 50;

/** The longest message a person may send the assistant. */
const MAX_MESSAGE_LENGTH = 4000;

/** Codes for a service the server relies on that failed: a bad gateway. */
const UPSTREAM_CODES = new Set<ErrorCode>([
	"connectionLost",
	"improveFailed",
	"localAssistantUnavailable",
	"noConnection",
	"providerBusy",
]);

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** The pictures training can use, and the extension each is written with. */
const TRAINING_TYPES: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};

/** More than any JSON request the interface sends. */
const MAX_JSON_BYTES = 1024 * 1024;
/** MCP calls one API token may have under way at once. */
const MAX_MCP_CALLS = 4;

/** A JSON-RPC error answering no message in particular. */
const rpcError = (code: number, message: string) => ({
	jsonrpc: "2.0",
	error: { code, message },
	id: null,
});

function hostname(host: string): string {
	return host.replace(/:\d+$/, "");
}

/** Methods that change something, which another website must never send. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * What the built interface needs and nothing more: its own scripts, styles
 * and fonts, pictures it draws itself (data: and blob:), the event stream,
 * and the desktop app's bridge (ipc:), which the desktop window talks to.
 */
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data: blob:",
	"media-src 'self' blob:",
	"font-src 'self' data:",
	"connect-src 'self' ipc: http://ipc.localhost",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
	"content-security-policy": CONTENT_SECURITY_POLICY,
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"permissions-policy":
		"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** The connection's address, which the server passes in as `peer`. */
const peerOf = (c: Context): string | null =>
	(c.env as { peer?: string } | undefined)?.peer ?? null;

/** Answer for what a server reached over the network must not do. */
const notOnServer = (c: Context) =>
	c.json(
		{
			error: "Not available when Hatchlight runs as a server",
			code: "notOnServer",
		},
		403,
	);

/**
 * Reads a single-range `Range` header. Anything else (no header, several
 * ranges, another unit) is answered with the whole file, as HTTP allows.
 */
function parseRange(
	header: string | undefined,
	size: number,
): { start: number; end: number } | "unsatisfiable" | null {
	const match = header?.match(/^bytes=(\d*)-(\d*)$/);
	if (!match || (match[1] === "" && match[2] === "")) return null;
	if (match[1] === "") {
		// "-N": the last N bytes.
		const length = Math.min(Number(match[2]), size);
		return length === 0
			? "unsatisfiable"
			: { start: size - length, end: size - 1 };
	}
	const start = Number(match[1]);
	const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	return start >= size || start > end ? "unsatisfiable" : { start, end };
}

/** Answers with a stored file, whole or the range the request asks for. */
function serveFile(c: Context, blob: Blob, mime: string): Response {
	const headers = {
		"content-type": mime,
		"accept-ranges": "bytes",
		"cache-control": "private, max-age=31536000, immutable",
		// Stored files come from outside; they must never run as a page.
		"x-content-type-options": "nosniff",
		"content-security-policy": "sandbox",
	};
	// Browsers ask for videos in pieces and cannot seek without this.
	const range = parseRange(c.req.header("range"), blob.size);
	if (range === "unsatisfiable") {
		return new Response(null, {
			status: 416,
			headers: { ...headers, "content-range": `bytes */${blob.size}` },
		});
	}
	if (range) {
		return new Response(blob.slice(range.start, range.end + 1), {
			status: 206,
			headers: {
				...headers,
				"content-length": String(range.end - range.start + 1),
				"content-range": `bytes ${range.start}-${range.end}/${blob.size}`,
			},
		});
	}
	return new Response(blob, {
		headers: { ...headers, "content-length": String(blob.size) },
	});
}

/**
 * Refuses a file upload that says it is too large. One that does not say
 * (sent in chunks) is not held in memory to find out: the shelf counts it
 * as it is written and stops at the limit.
 */
function declaredSize(options: {
	maxSize: number;
	onError: (c: Context) => Response;
}): MiddlewareHandler {
	return async (c, next) => {
		const length = c.req.header("content-length");
		if (
			length !== undefined &&
			!c.req.header("transfer-encoding") &&
			Number(length) > options.maxSize
		) {
			return options.onError(c);
		}
		await next();
	};
}

export function createApp(options: AppOptions): Hono {
	const { service, engine, models } = options;
	const server = options.server;
	// A personal install has no accounts, even when given them.
	const accounts = server ? options.accounts : undefined;
	if (server && !accounts) throw new Error("Server mode needs accounts");
	const user =
		options.resolveUser ??
		(server
			? (c: Context): UserContext => {
					const { user, apiToken } = c.get("viewer");
					return { userId: user.id, tokenId: apiToken?.ref ?? null };
				}
			: () => LOCAL_USER);
	const app = new Hono();

	// Every answer, the page included, keeps to what the interface needs.
	app.use("*", async (c, next) => {
		await next();
		const headers = c.res.headers;
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
			// Stored files keep their stricter sandbox.
			if (!headers.has(name)) headers.set(name, value);
		}
		if (c.get("https")) {
			headers.set("strict-transport-security", "max-age=31536000");
		}
	});

	// The server holds API keys and spends money, and browsers let any website
	// send requests to localhost. Refuse anything that is not same-origin.
	app.use(
		"*",
		server
			? async (c, next) => {
					// Behind a proxy, the address people used comes in its headers.
					const seen = requestOrigin(
						new URL(c.req.url),
						c.req.raw.headers,
						peerOf(c),
						server.trustedProxies,
					);
					const name = hostName(seen.host);
					// Loopback stays allowed for health checks from the machine itself.
					if (
						!name ||
						!(server.allowedHosts.includes(name) || LOCAL_HOSTS.includes(name))
					) {
						return c.json({ error: "Forbidden host" }, 403);
					}
					c.set("https", seen.scheme === "https");
					c.set("client", seen.client);
					const origin = c.req.header("origin");
					const own = new URL(`${seen.scheme}://${seen.host}`).origin;
					if (origin) {
						if (origin !== own && !options.allowedOrigins?.includes(origin)) {
							return c.json({ error: "Forbidden origin" }, 403);
						}
					} else if (
						UNSAFE_METHODS.has(c.req.method) &&
						c.req.header("sec-fetch-site") !== "same-origin" &&
						// Programs sign with a token, which no other site can send;
						// with a cookie beside it, it could be a browser.
						!(
							/^Bearer\s/i.test(c.req.header("authorization") ?? "") &&
							c.req.header("cookie") === undefined
						)
					) {
						// Browsers name the origin of every such request; without
						// it, nothing shows it comes from this site.
						return c.json({ error: "Missing origin" }, 403);
					}
					await next();
				}
			: async (c, next) => {
					// Without login, only this computer may come in, whatever
					// address the server was told to listen on.
					const peer = peerOf(c);
					if (peer !== null && !isLoopback(peer)) {
						return c.json({ error: "Forbidden address" }, 403);
					}
					// Bun builds the request URL from the Host header.
					const host = new URL(c.req.url).host;
					if (!LOCAL_HOSTS.includes(hostname(host))) {
						return c.json({ error: "Forbidden host" }, 403);
					}
					// Compared as text: `Origin` can be "null" or otherwise not a URL.
					const origin = c.req.header("origin");
					if (
						origin &&
						origin !== `http://${host}` &&
						!options.allowedOrigins?.includes(origin)
					) {
						return c.json({ error: "Forbidden origin" }, 403);
					}
					await next();
				},
	);

	// For container and proxy health checks: says nothing but that it is up.
	app.get("/api/health", (c) => c.json({ ok: true }));
	// Lets the interface leave out what only works on this computer, and warn
	// when passwords would cross the network unencrypted.
	app.get("/api/server", (c) =>
		c.json({
			mode: server ? "server" : "personal",
			secure: c.get("https") === true,
		}),
	);

	// Bodies are small JSON, except for the routes that take files, which
	// set their own limits.
	app.use("/api/*", async (c, next) => {
		const path = new URL(c.req.url).pathname;
		if (["/api/loras", "/api/checkpoints", "/api/assets"].includes(path)) {
			return next();
		}
		return bodyLimit({
			maxSize: MAX_JSON_BYTES,
			onError: (c) => c.json({ error: "The request is too large" }, 413),
		})(c, next);
	});

	if (accounts && options.mcp && server) {
		const answer = options.mcp;
		// Wrong tokens slow down, per address; a token runs a few calls at once.
		const failures = new Limiter({ freeTries: 10 });
		const running = new Map<string, number>();
		app.all(
			"/mcp",
			bodyLimit({
				maxSize: MAX_JSON_BYTES,
				onError: (c) => c.json({ error: "The request is too large" }, 413),
			}),
			async (c) => {
				// Without sessions, there is no stream to open or session to end.
				if (c.req.method !== "POST") {
					return c.json({ error: "Use POST" }, 405, { allow: "POST" });
				}
				const address = c.get("client") ?? peerOf(c) ?? "unknown";
				const wait = failures.wait(address);
				if (wait > 0) {
					throw new AccessError(
						"Too many wrong tokens. Try again later",
						"tooManyAttempts",
						429,
						{ seconds: Math.ceil(wait / 1000) },
					);
				}
				// A token only: a browser's cookie never opens this.
				const token = c.req
					.header("authorization")
					?.match(/^Bearer\s+(\S+)$/i)?.[1];
				const seen = token ? accounts.resolveApiToken(token) : null;
				if (!token || !seen?.apiToken) {
					failures.fail(address);
					c.header("www-authenticate", 'Bearer realm="hatchlight"');
					throw new AccessError(
						"An API token is needed: Authorization: Bearer <token>",
						"signInRequired",
						401,
					);
				}
				if (seen.user.mustChangePassword) {
					throw new AccessError(
						"Choose a new password before going on",
						"passwordChangeRequired",
						403,
					);
				}
				const ref = seen.apiToken.ref ?? seen.apiToken.id;
				const busy = running.get(ref) ?? 0;
				if (busy >= MAX_MCP_CALLS) {
					throw new AccessError(
						"This token has too many calls under way. Try again shortly",
						"tooManyAttempts",
						429,
						{ seconds: 5 },
					);
				}
				// One message per request: a batch would carry many calls past
				// the cap on calls under way.
				let message: unknown;
				try {
					message = JSON.parse(await c.req.text());
				} catch {
					return c.json(rpcError(-32700, "The body is not JSON"), 400);
				}
				if (Array.isArray(message)) {
					return c.json(
						rpcError(-32600, "Batches are not accepted: send one message"),
						400,
					);
				}
				running.set(ref, busy + 1);
				try {
					return await answer(
						c.req.raw,
						{
							token,
							origin: server.publicOrigin,
							allowPaid:
								seen.apiToken.scopes.includes("paid") && mayUsePaid(seen.user),
						},
						message,
					);
				} finally {
					const left = (running.get(ref) ?? 1) - 1;
					if (left > 0) running.set(ref, left);
					else running.delete(ref);
				}
			},
		);
	}

	app.onError((error, c) => {
		// The browser went away: nobody to answer, nothing to log.
		if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
		// The code and its values let the interface say it in the reader's language.
		const body = (e: CodedError) => ({
			error: e.message,
			...(e.code && { code: e.code, params: e.params }),
		});
		if (error instanceof ValidationError) return c.json(body(error), 400);
		if (error instanceof AccessError) {
			if (error.status === 503) c.header("retry-after", "5");
			return c.json(body(error), error.status);
		}
		if (error instanceof NotFoundError) return c.json(body(error), 404);
		// Something the server relies on failed in a way a person can be told.
		if (error instanceof CodedError && error.code) {
			if (UPSTREAM_CODES.has(error.code)) return c.json(body(error), 502);
			// Our own failure, still told in the reader's language.
			console.error(error);
			return c.json(body(error), 500);
		}
		console.error(error);
		return c.json({ error: "Internal error" }, 500);
	});

	const json = async (c: Context): Promise<Record<string, unknown>> => {
		const body = await c.req.json().catch(() => null);
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new ValidationError("Expected a JSON object");
		}
		return body;
	};

	if (accounts) {
		// On a server, every route but the public ones needs a signed-in person.
		app.use("/api/*", requireAccess(accounts));
		mountAccounts(
			app,
			accounts,
			json,
			new DeviceCookies(
				options.deviceKey ?? crypto.getRandomValues(new Uint8Array(32)),
			),
		);
	}

	/** Why the person asking may not spend on paid models now, if they may not. */
	const paidRefusal = (c: Context, source: KeySource) =>
		server ? (options.paidRefusal?.(user(c), source) ?? null) : null;

	app.get("/api/models", async (c) => {
		const models = service.listModels();
		// A token that may not pay is not shown what it could not use.
		const token = server ? c.get("viewer").apiToken : null;
		if (!token || token.scopes.includes("paid")) return c.json(models);
		const paid = new Set(
			(await service.listProviders(user(c)))
				.filter((p) => p.requiresKey)
				.map((p) => p.id),
		);
		return c.json(models.filter((m) => !paid.has(m.providerId)));
	});

	app.get("/api/providers", async (c) => {
		const providers = await service.listProviders(user(c));
		if (!server) return c.json(providers);
		// Usable now: their own key, or the server's while their limit allows.
		// A key from the environment is the server's.
		const notAllowed = paidRefusal(c, "personal") !== null;
		const serverRefused = paidRefusal(c, "server") !== null;
		return c.json(
			providers.map((p) =>
				p.requiresKey && p.keys
					? {
							...p,
							hasKey:
								!notAllowed &&
								(p.keys.personal || (p.keys.server && !serverRefused)),
						}
					: p,
			),
		);
	});

	// Connecting agents writes to their settings, on the person's request.
	const agents = options.agents;
	if (agents) {
		app.get("/api/agents", async (c) => c.json(await agents.status()));
		app.put("/api/agents/claude-desktop", async (c) => {
			// It writes settings on the machine that runs the server.
			if (server) return notOnServer(c);
			const body = (await c.req.json().catch(() => null)) as {
				allowPaid?: unknown;
				spendLimitUsd?: unknown;
			} | null;
			const limit = body?.spendLimitUsd ?? null;
			if (
				typeof body?.allowPaid !== "boolean" ||
				(limit !== null &&
					!(typeof limit === "number" && Number.isFinite(limit) && limit >= 0))
			) {
				throw new ValidationError(
					"allowPaid must be true or false, and spendLimitUsd zero or more, or null",
				);
			}
			await agents.connectClaudeDesktop({
				allowPaid: body.allowPaid,
				spendLimitUsd: body.allowPaid ? (limit as number | null) : null,
			});
			return c.body(null, 204);
		});
		app.delete("/api/agents/claude-desktop", async (c) => {
			if (server) return notOnServer(c);
			await agents.disconnectClaudeDesktop();
			return c.body(null, 204);
		});
	}
	// Keys the secret could not open were set aside at start: those who
	// relied on them are told to enter them again.
	app.get("/api/keys/lost", (c) =>
		c.json({
			lost:
				options.keysLost?.({
					userId: user(c).userId,
					owner: !server || c.get("viewer").user.role === "owner",
				}) ?? false,
		}),
	);
	app.delete("/api/keys/lost", (c) => {
		options.dismissKeysLost?.(user(c).userId);
		return c.body(null, 204);
	});
	// On a server, these are the server's keys; on a personal install, the
	// person's.
	const keysOf = (c: Context) => (server ? SERVER_KEYS : user(c));
	app.put("/api/providers/:id/key", async (c) => {
		const { key } = await json(c);
		if (typeof key !== "string") throw new ValidationError("Missing key");
		await service.setProviderKey(keysOf(c), c.req.param("id"), key);
		return c.body(null, 204);
	});
	app.delete("/api/providers/:id/key", async (c) => {
		await service.deleteProviderKey(keysOf(c), c.req.param("id"));
		return c.body(null, 204);
	});
	if (server) {
		// A person's own keys, used before the server's, for those who may
		// spend on paid models.
		const mayHaveKeys = (c: Context) => {
			const refusal = paidRefusal(c, "personal");
			if (refusal) throw paidError(refusal);
		};
		app.put("/api/account/keys/:id", async (c) => {
			mayHaveKeys(c);
			const { key } = await json(c);
			if (typeof key !== "string") throw new ValidationError("Missing key");
			await service.setProviderKey(user(c), c.req.param("id"), key);
			return c.body(null, 204);
		});
		app.delete("/api/account/keys/:id", async (c) => {
			// Removing one's own key is always allowed.
			await service.deleteProviderKey(user(c), c.req.param("id"));
			return c.body(null, 204);
		});
	}

	app.get("/api/sessions", async (c) =>
		c.json(await service.listSessions(user(c))),
	);
	app.get("/api/sessions/:id", async (c) =>
		c.json(await service.getSession(user(c), c.req.param("id"))),
	);
	app.delete("/api/sessions/:id", async (c) => {
		options.assistant?.forget(user(c), c.req.param("id"));
		await service.deleteSession(user(c), c.req.param("id"));
		return c.body(null, 204);
	});

	app.post("/api/turns", async (c) => {
		const body = await json(c);
		if (
			!Array.isArray(body.modelIds) ||
			body.modelIds.some((id) => typeof id !== "string")
		) {
			throw new ValidationError("modelIds must be a list of model ids");
		}
		if (body.sessionId != null && typeof body.sessionId !== "string") {
			throw new ValidationError("sessionId must be a string");
		}
		if (server) {
			// Each paid model is paid with the person's own key if they have
			// one, else the server's: refused if they may not, or past their
			// limit on the server's.
			const providers = new Map(
				(await service.listProviders(user(c))).map((p) => [p.id, p]),
			);
			const byId = new Map(service.listModels().map((m) => [m.id, m]));
			for (const id of body.modelIds as string[]) {
				const provider = providers.get(byId.get(id)?.providerId ?? "");
				if (!provider?.requiresKey) continue;
				const refusal = paidRefusal(
					c,
					provider.keys?.personal ? "personal" : "server",
				);
				if (refusal) throw paidError(refusal);
			}
		}
		// The remaining fields are validated by the service's schema.
		const result = await service.createTurn(user(c), body as never);
		return c.json(result, 201);
	});

	app.get("/api/jobs/:id/preview", (c) => {
		const { data, mime } = service.jobPreview(user(c), c.req.param("id"));
		return new Response(data, {
			headers: { "content-type": mime, "cache-control": "no-store" },
		});
	});

	app.post("/api/jobs/:id/cancel", async (c) => {
		await service.cancelJob(user(c), c.req.param("id"));
		return c.body(null, 204);
	});

	app.post("/api/jobs/:id/retry", async (c) => {
		await service.retryJob(user(c), c.req.param("id"));
		return c.body(null, 204);
	});

	/** People with an upload under way, on a server: one each. */
	const uploading = new Set<string>();
	app.post(
		"/api/assets",
		// On a server, one upload at a time each, and only if what it says
		// it brings fits the room left: two at once cannot both slip in.
		async (c, next) => {
			if (!accounts) return next();
			const { userId } = user(c);
			const declared = Number(c.req.header("content-length") ?? 0) || 0;
			const full = accounts.storageRefusal(userId, declared);
			if (full) throw full;
			if (uploading.has(userId)) {
				throw new AccessError(
					"Another of your uploads is still under way",
					"uploadBusy",
					409,
				);
			}
			uploading.add(userId);
			try {
				await next();
			} finally {
				uploading.delete(userId);
			}
		},
		bodyLimit({
			maxSize: MAX_UPLOAD_BYTES,
			onError: (c) => c.json({ error: "The image is larger than 20 MB" }, 413),
		}),
		async (c) => {
			const data = new Uint8Array(await c.req.arrayBuffer());
			if (data.byteLength === 0) throw new ValidationError("Empty upload");
			// What it really brought, when it did not say.
			const full = accounts?.storageRefusal(user(c).userId, data.byteLength);
			if (full) throw full;
			return c.json(await service.uploadAsset(user(c), data), 201);
		},
	);
	app.delete("/api/assets/:id", async (c) => {
		await service.deleteAsset(user(c), c.req.param("id"));
		return c.body(null, 204);
	});
	app.get("/api/assets/:id", async (c) => {
		const { asset, blob } = await service.getAssetFile(
			user(c),
			c.req.param("id"),
		);
		return serveFile(c, blob, asset.mime);
	});

	// Models are shared by everyone using this installation.
	/** Whether the person asking may see where the server keeps its files. */
	const seesFolders = (c: Context) =>
		!server || ["owner", "admin"].includes(c.get("viewer").user.role);
	app.get("/api/local-models", async (c) => {
		const view = await models.listWithMemory();
		if (seesFolders(c)) return c.json(view);
		// The server's folders are none of a member's business.
		return c.json({
			...view,
			disk: {
				...view.disk,
				path: "",
				changeable: false,
				moving: view.disk.moving && { ...view.disk.moving, to: "" },
				moveError: null,
			},
		} satisfies LocalModelsView);
	});
	app.post("/api/prompts/improve", async (c) => {
		if (!options.improvePrompt) throw new NotFoundError("No writer here");
		const body = await json(c);
		const { prompt, modelIds, editing, language } = body;
		if (typeof prompt !== "string" || !prompt.trim()) {
			throw new ValidationError("prompt must be some text");
		}
		if (prompt.length > MAX_IDEA_LENGTH) {
			throw new ValidationError(
				`prompt must be at most ${MAX_IDEA_LENGTH} characters`,
			);
		}
		if (
			!Array.isArray(modelIds) ||
			modelIds.length > MAX_IDEA_MODELS ||
			!modelIds.every((id) => typeof id === "string")
		) {
			throw new ValidationError("modelIds must be a list of model ids");
		}
		if (
			language !== undefined &&
			(typeof language !== "string" ||
				!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language))
		) {
			throw new ValidationError(
				"language must be a language code such as pt-BR",
			);
		}
		const improved = await options.improvePrompt(
			user(c),
			{
				prompt,
				modelIds,
				editing: editing === true,
				...(typeof language === "string" && { language }),
			},
			// The person gave up: the language model stops too.
			c.req.raw.signal,
		);
		return c.json({ prompt: improved });
	});
	app.post("/api/local-models/:id/install", async (c) => {
		// No body, or one naming the variant to install instead of the best fit.
		const body = await c.req.json().catch(() => ({}));
		const variant = (body as { variant?: unknown } | null)?.variant;
		if (variant != null && typeof variant !== "string") {
			throw new ValidationError("variant must be a string");
		}
		await models.install(c.req.param("id"), variant ?? undefined);
		return c.body(null, 202);
	});
	app.post("/api/local-models/:id/cancel", async (c) => {
		await models.cancel(c.req.param("id"));
		return c.body(null, 204);
	});
	app.get("/api/settings", async (c) => {
		if (!options.settings) throw new NotFoundError("No settings here");
		return c.json(await options.settings.get(user(c)));
	});
	app.put("/api/settings", async (c) => {
		if (!options.settings) throw new NotFoundError("No settings here");
		const body = await json(c);
		if (
			body.translateWith !== undefined &&
			!isTranslateWith(body.translateWith)
		) {
			throw new ValidationError(
				`translateWith must be one of ${TRANSLATE_WITH.join(", ")}`,
			);
		}
		if (body.improveWith !== undefined && !isImproveWith(body.improveWith)) {
			throw new ValidationError(
				`improveWith must be one of ${IMPROVE_WITH.join(", ")}`,
			);
		}
		if (
			body.assistantWith !== undefined &&
			!isImproveWith(body.assistantWith)
		) {
			throw new ValidationError(
				`assistantWith must be one of ${IMPROVE_WITH.join(", ")}`,
			);
		}
		return c.json(
			await options.settings.set(user(c), {
				...(isImproveWith(body.assistantWith) && {
					assistantWith: body.assistantWith,
				}),
				...(isTranslateWith(body.translateWith) && {
					translateWith: body.translateWith,
				}),
				...(isImproveWith(body.improveWith) && {
					improveWith: body.improveWith,
				}),
			}),
		);
	});

	// The move goes on after the answer; its progress comes as events.
	app.post("/api/local-models/location", async (c) => {
		// A path typed in a browser names a folder on another machine.
		if (server) return notOnServer(c);
		const body = await json(c);
		if (typeof body.path !== "string" || !body.path.trim()) {
			throw new ValidationError("path must name a folder");
		}
		const move = options.moveModels ?? ((path) => models.relocate(path));
		await move(body.path);
		return c.body(null, 202);
	});
	app.delete("/api/local-models/:id", async (c) => {
		await models.remove(c.req.param("id"));
		return c.body(null, 204);
	});
	// LoRAs, like models, are shared by everyone using this installation.
	/** People with a LoRA upload under way, held to one each. */
	const loraUploads = new Set<string>();
	app.get("/api/loras", async (c) => c.json(await models.loras.list()));
	app.post(
		"/api/loras",
		declaredSize({
			maxSize: MAX_LORA_BYTES,
			onError: (c) =>
				c.json(
					{
						error: "This file is too large to be a LoRA",
						code: "loraTooLarge",
						params: {},
					},
					413,
				),
		}),
		async (c) => {
			// The file comes as the body, its name in the address.
			const name = c.req.query("name") ?? "";
			if (!/\.safetensors$/i.test(name)) {
				throw new ValidationError(
					"Choose a .safetensors file",
					"loraUnreadable",
				);
			}
			const body = c.req.raw.body;
			if (!body) throw new ValidationError("Empty upload", "loraUnreadable");
			// On a server, members may add only so many: the disk is shared.
			const uploader = accounts ? c.get("viewer").user : null;
			const quota = options.loraQuota ?? DEFAULT_LORA_QUOTA;
			const limited =
				uploader && accounts && !["owner", "admin"].includes(uploader.role);
			const over = () =>
				new AccessError(
					"You added as many LoRAs as this server allows",
					"loraQuotaReached",
					403,
					{ files: quota.files, maxBytes: quota.bytes },
				);
			if (!limited || !uploader || !accounts) {
				const lora = await models.loras.add(body, name);
				if (uploader)
					accounts?.recordLoraUpload(uploader.id, lora.id, lora.size);
				return c.json(lora, 201);
			}
			// One at a time each: two at once would both fit what is left.
			if (loraUploads.has(uploader.id)) {
				throw new AccessError(
					"Another of your LoRAs is still uploading",
					"loraUploadBusy",
					409,
				);
			}
			loraUploads.add(uploader.id);
			try {
				const used = accounts.loraUsage(
					uploader.id,
					new Set((await models.loras.list()).map((l) => l.id)),
				);
				const left = quota.bytes - used.bytes;
				const incoming = Number(c.req.header("content-length") ?? 0) || 0;
				if (used.files >= quota.files || incoming > left) throw over();
				// The upload stops as soon as it passes what is left.
				const lora = await models.loras.add(body, name, {
					maxBytes: left,
					error: over,
				});
				accounts.recordLoraUpload(uploader.id, lora.id, lora.size);
				return c.json(lora, 201);
			} finally {
				loraUploads.delete(uploader.id);
			}
		},
	);
	app.delete("/api/loras/:id", async (c) => {
		await models.loras.remove(c.req.param("id"));
		accounts?.forgetLoraUpload(c.req.param("id"));
		return c.body(null, 204);
	});

	// Whole models added by hand, shared like the others.
	app.get("/api/checkpoints", async (c) =>
		c.json(await models.checkpoints.list()),
	);
	app.post(
		"/api/checkpoints",
		declaredSize({
			maxSize: MAX_CHECKPOINT_BYTES,
			onError: (c) =>
				c.json(
					{
						error: "This file is too large",
						code: "checkpointTooLarge",
						params: {},
					},
					413,
				),
		}),
		async (c) => {
			const name = c.req.query("name") ?? "";
			if (!/\.safetensors$/i.test(name)) {
				throw new ValidationError(
					"Choose a .safetensors file",
					"checkpointUnreadable",
				);
			}
			const body = c.req.raw.body;
			if (!body) {
				throw new ValidationError("Empty upload", "checkpointUnreadable");
			}
			return c.json(await models.checkpoints.add(body, name), 201);
		},
	);
	app.patch("/api/checkpoints/:id", async (c) => {
		const body = await json(c);
		const change: Record<string, unknown> = {};
		for (const key of ["name", "steps", "cfgScale", "clipSkip"]) {
			if (key in body) change[key] = body[key];
		}
		return c.json(await models.checkpoints.update(c.req.param("id"), change));
	});
	app.delete("/api/checkpoints/:id", async (c) => {
		await models.checkpoints.remove(c.req.param("id"));
		return c.body(null, 204);
	});
	// Other apps' folders, whose models are used where they are. Machine-wide
	// like the models: on a server, the paths are the server's.
	// Where the folders are on the machine is for those who change them.
	app.get("/api/model-folders", async (c) => {
		const folders = await models.folders.list();
		const admin =
			!server || ["owner", "admin"].includes(c.get("viewer").user.role);
		return c.json(
			admin ? folders : folders.map(({ path: _, ...folder }) => folder),
		);
	});
	app.get("/api/model-folders/suggestions", async (c) =>
		c.json(await models.folders.suggestions()),
	);
	app.post("/api/model-folders", async (c) => {
		const body = await json(c);
		if (typeof body.path !== "string" || !body.path.trim()) {
			throw new ValidationError("path must name a folder");
		}
		return c.json(await models.folders.add(body.path), 201);
	});
	app.post("/api/model-folders/rescan", async (c) =>
		c.json(await models.folders.rescan()),
	);
	app.delete("/api/model-folders/:id", async (c) => {
		await models.folders.remove(c.req.param("id"));
		return c.body(null, 204);
	});
	// Pictures being described now: no training starts beside them.
	let captioning = 0;
	// The LoRA trainer, shared like the models it trains on.
	const trainer = () => {
		if (!options.trainer) throw new NotFoundError("No trainer here");
		return options.trainer;
	};
	// On a server, a training shows only to who started it, and to those who
	// run the server: its name and samples are theirs.
	const runsServer = (c: Context) =>
		["owner", "admin"].includes(c.get("viewer").user.role);
	const maySee = (c: Context, training: TrainingView) =>
		!server || training.startedBy?.userId === user(c).userId || runsServer(c);
	const forViewer = (c: Context, status: TrainerStatus): TrainerStatus =>
		status.training && !maySee(c, status.training)
			? { ...status, training: null }
			: status;
	const assertMayManageTraining = async (c: Context) => {
		const training = (await trainer().status()).training;
		if (training && !maySee(c, training)) {
			throw new AccessError(
				"Only who started this training can stop it",
				"forbidden",
				403,
			);
		}
	};
	app.get("/api/trainer", async (c) =>
		c.json(forViewer(c, await trainer().status())),
	);
	app.post("/api/trainer/install", async (c) => {
		await trainer().install();
		return c.body(null, 202);
	});
	app.post("/api/trainer/install/cancel", (c) => {
		trainer().cancelInstall();
		return c.body(null, 204);
	});
	app.delete("/api/trainer", async (c) => {
		await trainer().remove();
		return c.body(null, 204);
	});
	app.post("/api/trainings", async (c) => {
		const body = await json(c);
		const { name, trigger, steps, pictures, consent } = body;
		if (consent !== true) {
			throw new ValidationError(
				"Confirm the pictures are yours to use, and that anyone in them agreed",
				"trainingNeedsConsent",
			);
		}
		if (typeof name !== "string" || typeof trigger !== "string") {
			throw new ValidationError("name and trigger must be text");
		}
		if (typeof steps !== "number") {
			throw new ValidationError("steps must be a number");
		}
		if (!Array.isArray(pictures) || pictures.length > 200) {
			throw new ValidationError("pictures must be a list of pictures");
		}
		// Before reading up to 200 pictures for nothing.
		await trainer().assertCanTrain();
		// Describing a picture holds the memory training needs.
		if (captioning > 0) {
			throw new ValidationError("The trainer is busy", "trainerBusy");
		}
		const read = [];
		for (const picture of pictures) {
			const { assetId, caption } = (picture ?? {}) as Record<string, unknown>;
			if (
				typeof assetId !== "string" ||
				(caption != null && typeof caption !== "string")
			) {
				throw new ValidationError(
					"Each picture needs an assetId and may have a caption",
				);
			}
			const { asset, blob } = await service.getAssetFile(user(c), assetId);
			// What the training scripts read.
			const extension = TRAINING_TYPES[asset.mime];
			if (!extension) {
				throw new ValidationError(
					"Only PNG, JPEG and WebP pictures can be trained on",
					"uploadType",
				);
			}
			read.push({
				data: new Uint8Array(await blob.arrayBuffer()),
				extension,
				caption: typeof caption === "string" ? caption.slice(0, 500) : "",
			});
		}
		const viewer = server ? c.get("viewer").user : null;
		const training = await trainer().train({
			name,
			trigger,
			steps,
			pictures: read,
			startedBy: viewer
				? { userId: viewer.id, name: viewer.displayName }
				: undefined,
		});
		return c.json(training, 202);
	});
	app.post("/api/trainings/cancel", async (c) => {
		await assertMayManageTraining(c);
		trainer().cancelTraining();
		return c.body(null, 204);
	});
	app.post("/api/trainings/finish", async (c) => {
		await assertMayManageTraining(c);
		trainer().finishTraining();
		return c.body(null, 204);
	});
	app.get("/api/trainings/:id/samples/:step", async (c) => {
		const training = (await trainer().status()).training;
		if (!training || !maySee(c, training)) {
			throw new NotFoundError("Sample not found");
		}
		const file = trainer().sampleFile(
			c.req.param("id"),
			Number(c.req.param("step")),
		);
		const blob = file ? Bun.file(file) : null;
		if (!blob || !(await blob.exists())) {
			throw new NotFoundError("Sample not found");
		}
		return serveFile(c, blob, "image/png");
	});
	// Captions for training pictures, from the model that looks at pictures.
	app.get("/api/captioner", async (c) =>
		c.json({ ready: (await options.captioner?.ready()) ?? false }),
	);
	app.post("/api/captions", async (c) => {
		const { assetId } = await json(c);
		if (typeof assetId !== "string") {
			throw new ValidationError("assetId must be text");
		}
		const captioner = options.captioner;
		if (!captioner || !(await captioner.ready())) {
			throw new ValidationError(
				"Install Qwen2.5-VL in Models to describe pictures",
				"captionNeedsModel",
			);
		}
		// It needs gigabytes of memory that training needs too.
		if ((await options.trainer?.status())?.training?.state === "running") {
			throw new ValidationError("The trainer is busy", "trainerBusy");
		}
		const { asset, blob } = await service.getAssetFile(user(c), assetId);
		if (!TRAINING_TYPES[asset.mime]) {
			throw new ValidationError(
				"Only PNG, JPEG and WebP pictures can be trained on",
				"uploadType",
			);
		}
		captioning++;
		try {
			const caption = await captioner.caption(
				{
					data: Buffer.from(await blob.arrayBuffer()).toString("base64"),
					mimeType: asset.mime,
				},
				c.req.raw.signal,
			);
			return c.json({ caption });
		} finally {
			captioning--;
		}
	});
	app.get("/api/local-models/:id/demos/:index", async (c) => {
		const index = Number(c.req.param("index"));
		if (!Number.isInteger(index)) throw new NotFoundError("Demo not found");
		const size = c.req.query("size") ?? "original";
		if (!isDemoSize(size)) throw new ValidationError("Unknown demo size");
		const demo = await models.demo(c.req.param("id"), index, size);
		return serveFile(c, demo.blob, demo.mime);
	});

	app.get("/api/gallery", async (c) => {
		const limit = Number(c.req.query("limit") ?? 60);
		const before = c.req.query("before");
		const beforeId = c.req.query("beforeId");
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			throw new ValidationError("limit must be between 1 and 200");
		}
		if (
			(before == null) !== (beforeId == null) ||
			Number.isNaN(Number(before ?? 0))
		) {
			throw new ValidationError("before and beforeId must be given together");
		}
		return c.json(
			await service.listGallery(user(c), {
				limit,
				before:
					before != null && beforeId != null
						? { createdAt: Number(before), id: beforeId }
						: undefined,
				query: c.req.query("query") || undefined,
			}),
		);
	});

	// The assistant: one conversation per session, answered in the background;
	// its progress comes as events.
	const assistant = () => {
		if (!options.assistant) throw new NotFoundError("No assistant here");
		return options.assistant;
	};
	const languageOf = (value: unknown) => {
		if (value === undefined) return undefined;
		if (
			typeof value !== "string" ||
			!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)
		) {
			throw new ValidationError(
				"language must be a language code such as pt-BR",
			);
		}
		return value;
	};
	app.get("/api/assistant", async (c) =>
		c.json({
			brain: options.assistantBrain
				? await options.assistantBrain(user(c))
				: null,
		}),
	);
	app.post("/api/assistant/messages", async (c) => {
		const body = await json(c);
		const { text, sessionId } = body;
		if (typeof text !== "string" || !text.trim()) {
			throw new ValidationError("text must be some words");
		}
		if (text.length > MAX_MESSAGE_LENGTH) {
			throw new ValidationError(
				`text must be at most ${MAX_MESSAGE_LENGTH} characters`,
			);
		}
		if (sessionId !== undefined && typeof sessionId !== "string") {
			throw new ValidationError("sessionId must be a session id");
		}
		const language = languageOf(body.language);
		return c.json(
			await assistant().send(user(c), {
				text,
				...(sessionId !== undefined && { sessionId }),
				...(language && { language }),
			}),
		);
	});
	app.get("/api/sessions/:id/assistant", async (c) => {
		const ctx = user(c);
		// Someone else's session is not found.
		await service.getSession(ctx, c.req.param("id"));
		return c.json(await assistant().view(ctx, c.req.param("id")));
	});
	app.post("/api/sessions/:id/assistant/stop", async (c) => {
		assistant().stop(user(c), c.req.param("id"));
		return c.body(null, 204);
	});
	app.post("/api/sessions/:id/assistant/answers", async (c) => {
		const body = await json(c);
		const { entryId, approve } = body;
		if (typeof entryId !== "string" || typeof approve !== "boolean") {
			throw new ValidationError(
				"entryId and approve (true or false) are needed",
			);
		}
		const ctx = user(c);
		await service.getSession(ctx, c.req.param("id"));
		await assistant().answer(
			ctx,
			c.req.param("id"),
			entryId,
			approve,
			languageOf(body.language),
		);
		return c.body(null, 202);
	});

	app.get("/api/events", (c) => {
		const { userId } = user(c);
		return streamSSE(c, async (stream) => {
			const send = (event: { type: string } | TrainerEvent) =>
				void stream.writeSSE({
					event: event.type,
					data: JSON.stringify(event),
				});
			const unsubscribeJobs = engine.subscribe((target, event) => {
				if (target === userId) send(event);
			});
			const folders = seesFolders(c);
			const unsubscribeModels = models.subscribe((event) =>
				send(
					event.type === "models.moving" && !folders
						? { ...event, to: "" }
						: event,
				),
			);
			const unsubscribeTrainer = options.trainer?.subscribe((event) => {
				const trainer = forViewer(c, event.trainer);
				send({ ...event, trainer } satisfies TrainerEvent);
			});
			const unsubscribeAssistant = options.assistant?.subscribe(
				(target, event) => {
					if (target === userId) send(event);
				},
			);
			const unsubscribe = () => {
				unsubscribeJobs();
				unsubscribeModels();
				unsubscribeTrainer?.();
				unsubscribeAssistant?.();
			};
			stream.onAbort(unsubscribe);
			await stream.writeSSE({ event: "ready", data: "{}" });
			// Keeps the connection alive through idle proxies and detects dead clients.
			while (!stream.aborted && !stream.closed) {
				await stream.sleep(15_000);
				await stream.writeSSE({ event: "ping", data: "{}" });
			}
			unsubscribe();
		});
	});

	app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

	return app;
}
