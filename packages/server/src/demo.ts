import { createHash, randomBytes } from "node:crypto";
import {
	AccessError,
	formatBytes,
	type LocalModelStore,
	type SqliteVisitors,
	VISITOR_PREFIX,
	type VisitorRow,
} from "@hatchlight/core";
import type { Context, Handler, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { demoAccess } from "./access";
import { routeOf } from "./auth";
import { addressKey, type DemoConfig } from "./transport";

declare module "hono" {
	interface ContextVariableMap {
		/** In a demo, the user id of the anonymous visitor asking. */
		visitor: string;
	}
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
/** How often a visitor's last visit is written down, at most. */
const TOUCH_EVERY = MINUTE;

/** Over https the cookie is bound to this host and never sent over http. */
const SECURE_VISITOR_COOKIE = "__Host-hatchlight-visitor";
/** Over plain http, as when trying the demo on one's own machine. */
const PLAIN_VISITOR_COOKIE = "hatchlight_visitor";
/** 32 random bytes, or a SHA-256, as base64url. */
const TOKEN = /^[\w-]{43}$/;

/**
 * Routes a browser loads as addresses (pictures, videos), where neither a
 * header nor, in a frame that keeps no cookies, a cookie can go: they also
 * take the visitor's media key in `?m=`, which opens nothing else.
 */
const MEDIA_ROUTES = new Set([
	"GET /api/assets/:id",
	"GET /api/jobs/:id/preview",
	"GET /api/local-models/:id/demos/:index",
]);
/** Asked by health checks and before anything else: never held back. */
const UNLIMITED_ROUTES = new Set(["GET /api/health", "GET /api/server"]);

const hashOf = (token: string) =>
	createHash("sha256").update(token).digest("hex");

/** The media key of a visitor's token: known to the visitor, stored hashed. */
export const mediaKeyOf = (token: string) =>
	createHash("sha256").update(`media\n${token}`).digest("base64url");

/**
 * Counts what each key (a visitor, an address, everyone) did in a sliding
 * window, to hold it to a limit. Kept in memory: a restart forgives. It
 * keeps at most `maxKeys` keys and forgets only those with nothing left in
 * the window; full of live ones, it refuses new keys rather than forgive.
 */
export class RateCounter {
	private entries = new Map<string, { at: number; n: number }[]>();
	private now: () => number;
	private windowMs: number;
	private maxKeys: number;

	constructor(
		options: { now?: () => number; windowMs?: number; maxKeys?: number } = {},
	) {
		this.now = options.now ?? Date.now;
		this.windowMs = options.windowMs ?? HOUR;
		this.maxKeys = options.maxKeys ?? 100_000;
	}

	/**
	 * Takes `n` more for `key` if that stays within `limit` in the window,
	 * and returns 0; otherwise takes nothing and returns how many
	 * milliseconds until there is room.
	 */
	take(key: string, n: number, limit: number): number {
		const now = this.now();
		const live = (entry: { at: number }) => now - entry.at < this.windowMs;
		const recent = (this.entries.get(key) ?? []).filter(live);
		let used = recent.reduce((sum, entry) => sum + entry.n, 0);
		if (used + n > limit) {
			// The oldest go first; the wait ends when enough of them have.
			for (const entry of recent) {
				used -= entry.n;
				if (used + n <= limit) {
					return Math.max(1, entry.at + this.windowMs - now);
				}
			}
			// More than the limit at once: never.
			return this.windowMs;
		}
		if (!this.entries.has(key)) {
			// The least recently used come first; only spent ones may go.
			for (const [oldest, entries] of this.entries) {
				if (this.entries.size < this.maxKeys) break;
				const newest = entries.at(-1);
				if (newest && live(newest)) {
					return Math.max(1, newest.at + this.windowMs - now);
				}
				this.entries.delete(oldest);
			}
		}
		recent.push({ at: now, n });
		// Moved to the end: the map's order is the order of last use.
		this.entries.delete(key);
		this.entries.set(key, recent);
		return 0;
	}

	/** Gives back what was taken for something that did not happen. */
	refund(key: string, n: number): void {
		const entries = this.entries.get(key);
		const last = entries?.findLastIndex((entry) => entry.n === n) ?? -1;
		if (entries && last >= 0) entries.splice(last, 1);
	}
}

/** The answer for what a demo does not do. */
export const notInDemo = () =>
	new AccessError(
		"Not available in the public demo. Install Hatchlight to use everything",
		"notInDemo",
		403,
	);

/** The answer for a visitor or an address past its limit. */
export const demoLimit = (waitMs: number) =>
	new AccessError(
		"You reached the limit of the demo. Try again later",
		"demoLimitReached",
		429,
		{ minutes: Math.max(1, Math.ceil(waitMs / 60_000)) },
	);

/** The answer when the demo has no room for more work now. */
export const demoBusy = () =>
	new AccessError(
		"The demo is busy. Try again in a few minutes",
		"demoBusy",
		503,
	);

/** The answer for a request from no known visitor. */
const visitorRequired = () =>
	new AccessError(
		"Start a visit first: POST /api/visitor",
		"visitorRequired",
		401,
	);

/**
 * The visitors of a public demo. Only `start` (POST /api/visitor) makes
 * one: a random token, sent back in the answer and in an HttpOnly cookie,
 * of which the server keeps only the hash. `gate` lets in only the routes
 * DEMO_ACCESS allows, and on visitor routes only a known visitor, named by
 * `Authorization: Bearer <token>` or else the cookie. What a visitor makes
 * is stored under their own user id, so the checks that keep the people of
 * a server apart keep visitors apart.
 */
export function demoVisitors(options: {
	visitors: SqliteVisitors;
	config: DemoConfig;
	now?: () => number;
}): { gate: MiddlewareHandler; start: Handler } {
	const { visitors, config } = options;
	const now = options.now ?? Date.now;
	const ttl = config.ttlHours * HOUR;
	// Everyone's new visitors count under one key, and stay below the
	// ceiling: the counters per address never hold more live keys than that.
	const newVisitors = new RateCounter({ now });
	const requests = new RateCounter({ now, windowMs: MINUTE });
	const cookieName = (c: Context) =>
		c.get("https") === true ? SECURE_VISITOR_COOKIE : PLAIN_VISITOR_COOKIE;

	/** The visitor a request names, and how, or null. */
	const resolve = (
		c: Context,
		media: boolean,
	): { row: VisitorRow; token: string | null; cookie: boolean } | null => {
		const at = now();
		const live = (row: VisitorRow | null) =>
			row && at - row.lastSeenAt < ttl ? row : null;
		const header = c.req.header("authorization");
		// A header counts alone: a wrong one is not made good by a cookie.
		if (header !== undefined) {
			const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? "";
			const row = TOKEN.test(token) ? live(visitors.find(hashOf(token))) : null;
			return row && { row, token, cookie: false };
		}
		const token = getCookie(c, cookieName(c));
		const row =
			token && TOKEN.test(token) ? live(visitors.find(hashOf(token))) : null;
		if (row && token) return { row, token, cookie: true };
		const key = media ? c.req.query("m") : undefined;
		const byMedia =
			key && TOKEN.test(key) ? live(visitors.findByMedia(hashOf(key))) : null;
		return byMedia && { row: byMedia, token: null, cookie: false };
	};

	const seen = (
		c: Context,
		found: { row: VisitorRow; token: string | null; cookie: boolean },
	) => {
		const at = now();
		if (at - found.row.lastSeenAt < TOUCH_EVERY) return;
		visitors.touch(found.row.id, at);
		// The cookie slides with use, when it is what named the visitor.
		if (found.cookie && found.token) setVisitorCookie(c, found.token, config);
	};

	const gate: MiddlewareHandler = async (c, next) => {
		const route = routeOf(c);
		const key = route ? `${route.method} ${route.path}` : "";
		const access = route ? demoAccess(route.method, route.path) : "refused";
		if (access === "refused") throw notInDemo();
		if (!UNLIMITED_ROUTES.has(key)) {
			const address = addressKey(c.get("client") ?? "unknown");
			const wait = requests.take(address, 1, config.requestsPerMinutePerIp);
			if (wait > 0) throw demoLimit(wait);
		}
		if (access === "public") return next();
		const found = resolve(c, MEDIA_ROUTES.has(key));
		if (!found) throw visitorRequired();
		seen(c, found);
		c.set("visitor", found.row.userId);
		await next();
	};

	const start: Handler = (c) => {
		// A visitor already known goes on as themselves.
		const found = resolve(c, false);
		if (found?.token) {
			seen(c, found);
			setVisitorCookie(c, found.token, config);
			return c.json({
				token: found.token,
				mediaKey: mediaKeyOf(found.token),
			});
		}
		const address = addressKey(c.get("client") ?? "unknown");
		const wait = newVisitors.take(
			`address ${address}`,
			1,
			config.visitorsPerHourPerIp,
		);
		if (wait > 0) throw demoLimit(wait);
		const total = newVisitors.take("everyone", 1, config.totalVisitorsPerHour);
		if (total > 0) {
			newVisitors.refund(`address ${address}`, 1);
			throw demoLimit(total);
		}
		const at = now();
		const token = randomBytes(32).toString("base64url");
		const mediaKey = mediaKeyOf(token);
		visitors.create({
			id: hashOf(token),
			userId: VISITOR_PREFIX + randomBytes(16).toString("base64url"),
			mediaId: hashOf(mediaKey),
			createdAt: at,
			lastSeenAt: at,
		});
		setVisitorCookie(c, token, config);
		return c.json({ token, mediaKey }, 201);
	};

	const setVisitorCookie = (c: Context, token: string, conf: DemoConfig) => {
		const https = c.get("https") === true;
		setCookie(c, cookieName(c), token, {
			httpOnly: true,
			path: "/",
			maxAge: conf.ttlHours * 60 * 60,
			// A Space is shown inside a frame on huggingface.co, another site:
			// there only a cookie for every site, kept apart per top site
			// (partitioned), is sent. Changes need the page's own origin anyway.
			...(https
				? { secure: true, sameSite: "None" as const, partitioned: true }
				: { secure: false, sameSite: "Lax" as const }),
		});
	};

	return { gate, start };
}

/**
 * A turn as a demo allows it: a few pictures at a time, short videos, and
 * none of the settings that make a job heavier than its model's own.
 */
export function demoTurn(
	body: Record<string, unknown>,
	config: DemoConfig,
): Record<string, unknown> {
	// Nor a library: a visitor keeps none.
	const {
		extras: _extras,
		loras: _loras,
		characterId: _characterId,
		styleId: _styleId,
		// More steps than the model's own make a job heavier.
		steps: _steps,
		// Some samplers run the model twice a step.
		sampler: _sampler,
		...rest
	} = body;
	const clamp = (value: unknown, most: number) =>
		typeof value === "number" && Number.isFinite(value)
			? Math.min(value, most)
			: value;
	return {
		...rest,
		count: clamp(body.count ?? 1, config.maxBatch),
		...(body.durationSeconds !== undefined && {
			durationSeconds: clamp(body.durationSeconds, config.maxSeconds),
		}),
	};
}

/**
 * Installs the demo's model at start, unless it is ready, by the same path
 * as the app's install button, and says how it goes. Never throws: the demo
 * runs on, and says the model is missing, if it could not be installed.
 */
export async function installDemoModel(
	models: LocalModelStore,
	id: string,
	say: (line: string) => void,
	options: { reportEveryMs?: number } = {},
): Promise<boolean> {
	const reportEvery = options.reportEveryMs ?? 15_000;
	const status = async () =>
		(await models.list()).models.find((model) => model.id === id);
	try {
		const first = await status();
		if (!first) {
			say(`The demo model ${id} is not in the catalog of local models`);
			return false;
		}
		if (first.ready) {
			say(`Demo model ready: ${first.name}`);
			return true;
		}
		say(`Installing the demo model ${first.name} (${formatBytes(first.size)})`);
		let lastReport = 0;
		const done = new Promise<boolean>((resolve) => {
			const unsubscribe = models.subscribe((event) => {
				if (event.type !== "models.changed") return;
				void status().then((model) => {
					if (!model) return;
					const busy = ["queued", "downloading", "verifying"].includes(
						model.state,
					);
					if (busy) {
						if (Date.now() - lastReport < reportEvery) return;
						lastReport = Date.now();
						const share = model.size
							? Math.floor((model.receivedBytes / model.size) * 100)
							: 0;
						say(
							`Installing ${model.name}: ${share}% of ${formatBytes(model.size)}`,
						);
						return;
					}
					unsubscribe();
					if (model.ready) say(`Demo model installed: ${model.name}`);
					else {
						say(
							`The demo model ${model.name} could not be installed: ${model.error ?? "unknown error"}`,
						);
					}
					resolve(model.ready);
				});
			});
		});
		await models.install(id);
		return await done;
	} catch (error) {
		say(
			`The demo model ${id} could not be installed: ${(error as Error).message}`,
		);
		return false;
	}
}
