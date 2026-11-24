import {
	AccessError,
	type AccountService,
	type ApiTokenRow,
	mayTrain,
	type SignedIn,
	type UserRow,
} from "@hatchlight/core";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { matchedRoutes } from "hono/route";
import { type Access, routeAccess, routeScope } from "./access";

/** Who is asking, once a server knows. */
export interface Viewer {
	user: UserRow;
	/** The browser session, when signed in with a cookie. */
	sessionId: string | null;
	/** The token, when a program asks. */
	apiToken: ApiTokenRow | null;
}

declare module "hono" {
	interface ContextVariableMap {
		/** Set on a server for every signed-in request. */
		viewer: Viewer;
		/** The browser reached the server over https, through its proxy or not. */
		https: boolean;
		/** The browser's address, past trusted proxies. */
		client: string | null;
	}
}

/** Over https the cookie is bound to this host and never sent over http. */
const SECURE_COOKIE = "__Host-hatchlight";
/** Over plain http, as on a home network without certificates. */
const PLAIN_COOKIE = "hatchlight_session";

const isHttps = (c: Context) => c.get("https") === true;

export function setSessionCookie(c: Context, signed: SignedIn): void {
	const https = isHttps(c);
	setCookie(c, https ? SECURE_COOKIE : PLAIN_COOKIE, signed.token, {
		httpOnly: true,
		secure: https,
		sameSite: "Lax",
		path: "/",
		maxAge: Math.max(0, Math.floor((signed.expiresAt - Date.now()) / 1000)),
	});
}

/** Device cookies last a year: they only vouch that a browser signed in before. */
const DEVICE_MAX_AGE = 365 * 24 * 60 * 60;
const SECURE_DEVICE_COOKIE = "__Host-hatchlight-device";
const PLAIN_DEVICE_COOKIE = "hatchlight_device";

export function setDeviceCookie(c: Context, value: string): void {
	const https = isHttps(c);
	setCookie(c, https ? SECURE_DEVICE_COOKIE : PLAIN_DEVICE_COOKIE, value, {
		httpOnly: true,
		secure: https,
		sameSite: "Lax",
		path: "/",
		maxAge: DEVICE_MAX_AGE,
	});
}

export function deviceCookie(c: Context): string | undefined {
	return getCookie(c, isHttps(c) ? SECURE_DEVICE_COOKIE : PLAIN_DEVICE_COOKIE);
}

export function clearSessionCookie(c: Context): void {
	if (isHttps(c)) {
		deleteCookie(c, SECURE_COOKIE, { path: "/", secure: true });
	} else {
		deleteCookie(c, PLAIN_COOKIE, { path: "/" });
	}
}

/** The person a request is from, by its token or its cookie. */
function resolve(c: Context, accounts: AccountService): Viewer | null {
	const authorization = c.req.header("authorization");
	// A program's token alone counts: a cookie beside it is never used.
	if (authorization !== undefined) {
		const match = authorization.match(/^Bearer\s+(\S+)$/i);
		return match?.[1] ? accounts.resolveApiToken(match[1]) : null;
	}
	const token = getCookie(c, isHttps(c) ? SECURE_COOKIE : PLAIN_COOKIE);
	if (!token) return null;
	const seen = accounts.resolveSession(token);
	if (!seen) return null;
	// The cookie lasts as long as the session, which slides with use.
	setSessionCookie(c, { user: seen.user, token, expiresAt: seen.expiresAt });
	return seen;
}

/** Whether `user` may call a route that needs `access`. */
export function allows(access: Access, user: UserRow): boolean {
	switch (access) {
		case "public":
		case "account":
		case "member":
			return true;
		case "train":
			return mayTrain(user);
		case "admin":
			return user.role === "owner" || user.role === "admin";
		case "owner":
			return user.role === "owner";
	}
}

/** The route a request reached, as the access registry names it. */
function routeOf(c: Context): { method: string; path: string } | null {
	const route = matchedRoutes(c).find(
		(r) => r.method !== "ALL" && r.path.startsWith("/api/"),
	);
	const method = c.req.method === "HEAD" ? "GET" : c.req.method;
	return route ? { method, path: route.path } : null;
}

/** The access the route a request reached needs. */
function accessOf(c: Context): Access {
	const route = routeOf(c);
	// Nothing answers here: say so only to those signed in.
	return route ? routeAccess(route.method, route.path) : "member";
}

/**
 * Lets a request through only when who asks may do what it asks. Every
 * route but the public ones needs a session or an API token; tokens are for
 * using the server, not for managing accounts or the server.
 */
export function requireAccess(accounts: AccountService): MiddlewareHandler {
	return async (c, next) => {
		const access = accessOf(c);
		if (access === "public") return next();
		const viewer = resolve(c, accounts);
		if (!viewer) {
			throw new AccessError("Sign in to go on", "signInRequired", 401);
		}
		if (viewer.apiToken) {
			if (access === "account" || access === "admin" || access === "owner") {
				throw new AccessError("Tokens cannot do this", "forbidden", 403);
			}
			// Only what the token was made for.
			const route = routeOf(c);
			const scope = route ? routeScope(route.method, route.path) : "read";
			if (!scope || !viewer.apiToken.scopes.includes(scope)) {
				throw new AccessError(
					scope
						? `This API token needs the ${scope} scope`
						: "API tokens cannot do this",
					"tokenScope",
					403,
					{ scope: scope ?? "" },
				);
			}
		}
		if (viewer.user.mustChangePassword && access !== "account") {
			throw new AccessError(
				"Choose a new password before going on",
				"passwordChangeRequired",
				403,
			);
		}
		if (!allows(access, viewer.user)) {
			throw new AccessError("Your account cannot do this", "forbidden", 403);
		}
		c.set("viewer", viewer);
		await next();
	};
}
