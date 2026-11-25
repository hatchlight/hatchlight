import { createHash, randomBytes } from "node:crypto";
import {
	AccessError,
	formatBytes,
	type LocalModelStore,
	type SqliteVisitors,
	VISITOR_PREFIX,
} from "@hatchlight/core";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { demoAccess } from "./access";
import { routeOf } from "./auth";
import type { DemoConfig } from "./transport";

declare module "hono" {
	interface ContextVariableMap {
		/** In a demo, the user id of the anonymous visitor asking. */
		visitor: string;
	}
}

const HOUR = 60 * 60 * 1000;
/** How often a visitor's last visit is written down, at most. */
const TOUCH_EVERY = 60 * 1000;

/** Over https the cookie is bound to this host and never sent over http. */
const SECURE_VISITOR_COOKIE = "__Host-hatchlight-visitor";
/** Over plain http, as when trying the demo on one's own machine. */
const PLAIN_VISITOR_COOKIE = "hatchlight_visitor";
/** 32 random bytes, as base64url. */
const TOKEN = /^[\w-]{43}$/;

const hashOf = (token: string) =>
	createHash("sha256").update(token).digest("hex");

/**
 * Counts what each key (a visitor, an address) did in the last hour, to
 * hold it to a limit. Kept in memory: a restart forgives.
 */
export class HourlyCounter {
	private entries = new Map<string, { at: number; n: number }[]>();
	private now: () => number;
	private maxKeys: number;

	constructor(options: { now?: () => number; maxKeys?: number } = {}) {
		this.now = options.now ?? Date.now;
		this.maxKeys = options.maxKeys ?? 50_000;
	}

	/**
	 * Takes `n` more for `key` if that stays within `limit` in the last hour,
	 * and returns 0; otherwise takes nothing and returns how many
	 * milliseconds until enough of the hour has passed.
	 */
	take(key: string, n: number, limit: number): number {
		const now = this.now();
		const recent = (this.entries.get(key) ?? []).filter(
			(entry) => now - entry.at < HOUR,
		);
		let used = recent.reduce((sum, entry) => sum + entry.n, 0);
		if (used + n > limit) {
			// The oldest go first; the wait ends when enough of them have.
			for (const entry of recent) {
				used -= entry.n;
				if (used + n <= limit) return Math.max(1, entry.at + HOUR - now);
			}
			// More than the limit at once: never.
			return HOUR;
		}
		recent.push({ at: now, n });
		// Moved to the end: the map's order is the order of last use.
		this.entries.delete(key);
		this.entries.set(key, recent);
		while (this.entries.size > this.maxKeys) {
			this.entries.delete(this.entries.keys().next().value as string);
		}
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

/** The answer for a visitor or an address past its hourly limit. */
export const demoLimit = (waitMs: number) =>
	new AccessError(
		"You reached the limit of the demo. Try again later",
		"demoLimitReached",
		429,
		{ minutes: Math.max(1, Math.ceil(waitMs / 60_000)) },
	);

/**
 * Lets into a public demo only the routes DEMO_ACCESS allows, and gives
 * each visitor an anonymous identity: a random token in an HttpOnly cookie,
 * of which the server keeps only the hash. What a visitor makes is stored
 * under their own user id, so the same checks that keep the people of a
 * server apart keep visitors apart.
 */
export function demoGate(options: {
	visitors: SqliteVisitors;
	config: DemoConfig;
	/** New visitors made by each address in the last hour. */
	newVisitors?: HourlyCounter;
	now?: () => number;
}): MiddlewareHandler {
	const { visitors, config } = options;
	const now = options.now ?? Date.now;
	const newVisitors = options.newVisitors ?? new HourlyCounter({ now });
	return async (c, next) => {
		const route = routeOf(c);
		const access = route ? demoAccess(route.method, route.path) : "refused";
		if (access === "refused") throw notInDemo();
		if (access === "public") return next();
		const https = c.get("https") === true;
		const name = https ? SECURE_VISITOR_COOKIE : PLAIN_VISITOR_COOKIE;
		const token = getCookie(c, name);
		const at = now();
		const known =
			token && TOKEN.test(token) ? visitors.find(hashOf(token)) : null;
		// One gone idle was forgotten, with what it made; a new one starts.
		if (known && at - known.lastSeenAt < config.ttlHours * HOUR) {
			if (at - known.lastSeenAt >= TOUCH_EVERY) {
				visitors.touch(known.id, at);
				setVisitorCookie(c, name, token as string, config, https);
			}
			c.set("visitor", known.userId);
			return next();
		}
		const address = c.get("client") ?? "unknown";
		const wait = newVisitors.take(address, 1, config.visitorsPerHourPerIp);
		if (wait > 0) throw demoLimit(wait);
		const fresh = randomBytes(32).toString("base64url");
		const userId = VISITOR_PREFIX + randomBytes(16).toString("base64url");
		visitors.create({
			id: hashOf(fresh),
			userId,
			createdAt: at,
			lastSeenAt: at,
		});
		setVisitorCookie(c, name, fresh, config, https);
		c.set("visitor", userId);
		await next();
	};
}

function setVisitorCookie(
	c: Context,
	name: string,
	token: string,
	config: DemoConfig,
	https: boolean,
): void {
	setCookie(c, name, token, {
		httpOnly: true,
		path: "/",
		maxAge: config.ttlHours * 60 * 60,
		// A Space is shown inside a frame on huggingface.co, another site:
		// there only a cookie for every site, kept apart per top site
		// (partitioned), is sent. Changes need the page's own origin anyway.
		...(https
			? { secure: true, sameSite: "None" as const, partitioned: true }
			: { secure: false, sameSite: "Lax" as const }),
	});
}

/**
 * A turn as a demo allows it: a few pictures at a time, short videos, and
 * none of the settings that make a job heavier than its model's own.
 */
export function demoTurn(
	body: Record<string, unknown>,
	config: DemoConfig,
): Record<string, unknown> {
	const { extras: _extras, loras: _loras, ...rest } = body;
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
