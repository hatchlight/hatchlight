import {
	AccessError,
	type AccountService,
	type InviteTerms,
	NotFoundError,
	USER_ROLES,
	type UserRole,
	ValidationError,
} from "@hatchlight/core";
import type { Context, Hono } from "hono";
import {
	clearSessionCookie,
	deviceCookie,
	setDeviceCookie,
	setSessionCookie,
} from "./auth";
import type { DeviceCookies } from "./devices";
import { Limiter } from "./limiter";
import { parseIp } from "./transport";

/**
 * Sign-in, one's own account, invites and people: the routes a server has
 * and a personal install does not.
 */
export function mountAccounts(
	app: Hono,
	accounts: AccountService,
	json: (c: Context) => Promise<Record<string, unknown>>,
	devices: DeviceCookies,
	limits = {
		// Guesses from one address, whatever name they try.
		byAddress: new Limiter({ freeTries: 20 }),
		// One name from one address: the real lock.
		byNameAndAddress: new Limiter({ freeTries: 5 }),
		// One name from everywhere: soft, so nobody can lock its owner out.
		byName: new Limiter({ freeTries: 50, maxDelayMs: 30_000 }),
		// Setup codes and invites, apart from signing in.
		joining: new Limiter({ freeTries: 10 }),
	},
): void {
	const where = (c: Context) => ({
		userAgent: c.req.header("user-agent") ?? null,
		ip: c.get("client") ?? null,
		signal: c.req.raw.signal,
	});
	/**
	 * Password work from one address runs one at a time: many requests at
	 * once from one place wait for each other, not for everyone's.
	 */
	const running = new Map<string, Promise<unknown>>();
	const oneAtATime = <T>(key: string, work: () => Promise<T>): Promise<T> => {
		const before = running.get(key) ?? Promise.resolve();
		const mine = before.catch(() => {}).then(work);
		const settled = mine.catch(() => {});
		running.set(key, settled);
		void settled.then(() => {
			if (running.get(key) === settled) running.delete(key);
		});
		return mine;
	};
	const text = (value: unknown, name: string): string => {
		if (typeof value !== "string") {
			throw new ValidationError(`${name} must be text`);
		}
		return value;
	};

	/**
	 * Runs a guess (a password, a code) unless the address or name guessed too
	 * often lately. The try is counted before the work, so tries sent at once
	 * cannot slip through, and given back when it was right.
	 */
	const guarded = async <T>(
		c: Context,
		name: string | null,
		kind: "signIn" | "joining",
		attempt: () => Promise<T>,
	): Promise<T> => {
		const address = `ip:${addressGroup(c.get("client"))}`;
		const lowered = name?.trim().toLowerCase() ?? null;
		// A browser that signed in as this name before is not held back by
		// strangers guessing it from elsewhere.
		const known = lowered === null ? null : accounts.findUser(lowered);
		const knownDevice = devices.vouchesFor(deviceCookie(c), known);
		const counted: [Limiter, string][] =
			kind === "joining"
				? [[limits.joining, address]]
				: [
						[limits.byAddress, address],
						...(lowered
							? ([
									[limits.byNameAndAddress, `${lowered}|${address}`],
									...(knownDevice ? [] : [[limits.byName, `user:${lowered}`]]),
								] as [Limiter, string][])
							: []),
					];
		const wait = Math.max(...counted.map(([limit, key]) => limit.wait(key)));
		if (wait > 0) {
			const seconds = Math.ceil(wait / 1000);
			c.header("retry-after", String(seconds));
			throw new AccessError(
				`Too many tries. Wait ${seconds} seconds`,
				"tooManyAttempts",
				429,
				{ seconds },
			);
		}
		for (const [limit, key] of counted) limit.fail(key);
		const refund = () => {
			for (const [limit, key] of counted) limit.refund(key);
		};
		try {
			const result = await oneAtATime(address, () => {
				// Gone while it waited its turn: nothing left to do for it.
				c.req.raw.signal.throwIfAborted();
				return attempt();
			});
			refund();
			if (lowered) limits.byNameAndAddress.succeed(`${lowered}|${address}`);
			return result;
		} catch (error) {
			// Asking for the second step is not a failed guess, nor is a
			// request that guessed nothing.
			if (!(error instanceof AccessError) || error.code === "totpRequired") {
				refund();
			}
			throw error;
		}
	};

	app.get("/api/setup", (c) => c.json({ needed: accounts.needsSetup() }));
	app.post("/api/setup", async (c) => {
		const body = await json(c);
		const signed = await guarded(c, null, "joining", () =>
			accounts.setup(
				{
					code: text(body.code, "code"),
					username: text(body.username, "username"),
					password: text(body.password, "password"),
				},
				where(c),
			),
		);
		setSessionCookie(c, signed);
		setDeviceCookie(c, devices.issue(signed.user));
		return c.json(accounts.view(signed.user, true), 201);
	});

	app.post("/api/login", async (c) => {
		const body = await json(c);
		const username = text(body.username, "username");
		// No account has a longer name: nothing to guess, nothing to keep.
		if (username.trim().length > 32) {
			throw new ValidationError("No such username", "usernameInvalid");
		}
		const signed = await guarded(c, username, "signIn", () =>
			accounts.login(
				{
					username,
					password: text(body.password, "password"),
					totp: typeof body.totp === "string" ? body.totp : undefined,
				},
				where(c),
			),
		);
		setSessionCookie(c, signed);
		setDeviceCookie(c, devices.issue(signed.user));
		return c.json(accounts.view(signed.user, true));
	});

	app.post("/api/logout", (c) => {
		const { user, sessionId } = c.get("viewer");
		if (sessionId) accounts.logout(user.id, sessionId);
		clearSessionCookie(c);
		return c.body(null, 204);
	});

	app.get("/api/account", (c) =>
		c.json(accounts.view(c.get("viewer").user, true)),
	);
	app.delete("/api/account/reset-notice", (c) => {
		accounts.dismissResetNotice(c.get("viewer").user.id);
		return c.body(null, 204);
	});
	app.put("/api/account/password", async (c) => {
		const body = await json(c);
		const { user, sessionId } = c.get("viewer");
		await guarded(c, user.username, "signIn", () =>
			accounts.changePassword(
				user.id,
				{
					current: text(body.current, "current"),
					next: text(body.next, "next"),
				},
				sessionId,
				c.req.raw.signal,
			),
		);
		return c.body(null, 204);
	});
	app.get("/api/account/sessions", (c) => {
		const { user, sessionId } = c.get("viewer");
		return c.json(accounts.sessions(user.id, sessionId));
	});
	app.delete("/api/account/sessions", (c) => {
		const { user, sessionId } = c.get("viewer");
		// ?tokens=true ends the API tokens too.
		accounts.revokeOtherSessions(user.id, sessionId, {
			tokens: c.req.query("tokens") === "true",
		});
		return c.body(null, 204);
	});
	app.delete("/api/account/sessions/:id", (c) => {
		const { user } = c.get("viewer");
		accounts.revokeSession(user.id, c.req.param("id"));
		return c.body(null, 204);
	});
	// Tokens for programs and agents: made, seen and revoked in a browser.
	app.get("/api/account/tokens", (c) =>
		c.json(accounts.listApiTokens(c.get("viewer").user.id)),
	);
	app.post("/api/account/tokens", async (c) => {
		const body = await json(c);
		const { user } = c.get("viewer");
		if (user.mustChangePassword) {
			throw new AccessError(
				"Choose a new password before going on",
				"passwordChangeRequired",
				403,
			);
		}
		if (
			!Array.isArray(body.scopes) ||
			body.scopes.some((scope) => typeof scope !== "string")
		) {
			throw new ValidationError("scopes must be a list of scopes");
		}
		const spend = body.spendLimitUsd ?? null;
		if (spend !== null && typeof spend !== "number") {
			throw new ValidationError("spendLimitUsd must be a number or null");
		}
		// Left out, 90 days; null for a token that never ends.
		const days = body.expiresInDays;
		if (days !== undefined && days !== null && typeof days !== "number") {
			throw new ValidationError("expiresInDays must be a number or null");
		}
		// The password, and the two-step code when it is on, as for any
		// change a stolen session must not make; guessing slows down.
		const { token, view } = await guarded(c, user.username, "signIn", () =>
			accounts.createApiTokenConfirmed(
				user.id,
				{
					password: text(body.password, "password"),
					code: optionalText(body.code, "code"),
				},
				{
					name: text(body.name, "name"),
					scopes: body.scopes as string[],
					spendLimitUsd: spend,
					expiresInDays: days,
				},
				c.req.raw.signal,
			),
		);
		// The only time the token is shown.
		return c.json({ ...view, token }, 201);
	});
	app.delete("/api/account/tokens/:id", (c) => {
		accounts.revokeApiToken(c.get("viewer").user.id, c.req.param("id"));
		return c.body(null, 204);
	});
	app.post("/api/account/totp", (c) =>
		c.json(accounts.startTotp(c.get("viewer").user.id)),
	);
	const optionalText = (value: unknown, name: string) =>
		value === undefined || value === null ? undefined : text(value, name);
	app.put("/api/account/totp", async (c) => {
		const body = await json(c);
		const { user } = c.get("viewer");
		await guarded(c, user.username, "signIn", () =>
			accounts.enableTotp(
				user.id,
				{
					secret: text(body.secret, "secret"),
					code: text(body.code, "code"),
					password: text(body.password, "password"),
					current: optionalText(body.current, "current"),
				},
				c.req.raw.signal,
			),
		);
		return c.body(null, 204);
	});
	app.delete("/api/account/totp", async (c) => {
		const body = await json(c);
		const { user } = c.get("viewer");
		await guarded(c, user.username, "signIn", () =>
			accounts.disableTotp(
				user.id,
				{
					password: text(body.password, "password"),
					code: optionalText(body.code, "code"),
				},
				c.req.raw.signal,
			),
		);
		return c.body(null, 204);
	});

	// Reset links: given by admins and owners, opened by the person.
	app.get("/api/password-resets/:token", (c) => {
		const reset = accounts.passwordResetFor(c.req.param("token"));
		if (!reset) {
			throw new NotFoundError(
				"This link has expired or was already used",
				"resetInvalid",
			);
		}
		return c.json(reset);
	});
	app.post("/api/password-resets/:token", async (c) => {
		const body = await json(c);
		await guarded(c, null, "joining", () =>
			accounts.usePasswordReset(
				c.req.param("token"),
				text(body.password, "password"),
				c.req.raw.signal,
			),
		);
		return c.body(null, 204);
	});

	// Invites: made by admins, opened by anyone holding the link.
	app.get("/api/invites/:token", (c) => {
		const invite = accounts.inviteFor(c.req.param("token"));
		if (!invite) {
			throw new NotFoundError(
				"This invite has expired or was already used",
				"inviteInvalid",
			);
		}
		return c.json({ role: invite.role, expiresAt: invite.expiresAt });
	});
	app.post("/api/invites/:token/accept", async (c) => {
		const body = await json(c);
		const signed = await guarded(c, null, "joining", () =>
			accounts.acceptInvite(
				c.req.param("token"),
				{
					username: text(body.username, "username"),
					password: text(body.password, "password"),
				},
				where(c),
			),
		);
		setSessionCookie(c, signed);
		setDeviceCookie(c, devices.issue(signed.user));
		return c.json(accounts.view(signed.user, true), 201);
	});
	app.get("/api/invites", (c) => c.json(accounts.invites()));
	app.post("/api/invites", async (c) => {
		const created = accounts.createInvite(
			c.get("viewer").user,
			inviteTerms(await json(c)),
		);
		return c.json(created, 201);
	});
	app.delete("/api/invites/:id", (c) => {
		accounts.deleteInvite(c.req.param("id"));
		return c.body(null, 204);
	});

	app.get("/api/users", (c) => c.json(accounts.users()));
	app.patch("/api/users/:id", async (c) => {
		const body = await json(c);
		const change: Partial<InviteTerms> & {
			disabled?: boolean;
			displayName?: string;
		} = {};
		if (body.role !== undefined) change.role = role(body.role);
		for (const key of ["canUsePaid", "canTrain", "disabled"] as const) {
			if (body[key] === undefined) continue;
			if (typeof body[key] !== "boolean") {
				throw new ValidationError(`${key} must be true or false`);
			}
			change[key] = body[key];
		}
		if (body.monthlyLimitUsd !== undefined) {
			change.monthlyLimitUsd = limit(body.monthlyLimitUsd);
		}
		if (body.displayName !== undefined) {
			change.displayName = text(body.displayName, "displayName");
		}
		return c.json(
			accounts.updateUser(c.get("viewer").user, c.req.param("id"), change),
		);
	});
	// Another person's tokens, for those who manage them.
	app.get("/api/users/:id/tokens", (c) =>
		c.json(accounts.listApiTokensOf(c.get("viewer").user, c.req.param("id"))),
	);
	app.delete("/api/users/:id/tokens/:token", (c) => {
		accounts.revokeApiTokenOf(
			c.get("viewer").user,
			c.req.param("id"),
			c.req.param("token"),
		);
		return c.body(null, 204);
	});
	// A link for the person to choose a new password: nobody else learns it.
	app.post("/api/users/:id/password", (c) =>
		c.json(
			accounts.createPasswordReset(c.get("viewer").user, c.req.param("id")),
			201,
		),
	);
}

function role(value: unknown): UserRole {
	if (!USER_ROLES.includes(value as UserRole)) {
		throw new ValidationError("role must be owner, admin or member");
	}
	return value as UserRole;
}

function limit(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new ValidationError("monthlyLimitUsd must be zero or more, or null");
	}
	return value;
}

function inviteTerms(body: Record<string, unknown>): InviteTerms {
	return {
		role: role(body.role ?? "member"),
		canUsePaid: body.canUsePaid === true,
		canTrain: body.canTrain === true,
		monthlyLimitUsd: limit(body.monthlyLimitUsd ?? null),
	};
}

/**
 * The address a limit counts: one IPv6 network (/64) counts as one, since
 * a single home or server gets a whole /64 to pick addresses from.
 */
export function addressGroup(address: string | null | undefined): string {
	if (!address) return "unknown";
	const bytes = parseIp(address);
	if (!bytes) return address;
	const mapped =
		bytes.slice(0, 10).every((b) => b === 0) &&
		bytes[10] === 0xff &&
		bytes[11] === 0xff;
	if (mapped) return [...bytes.slice(12)].join(".");
	const groups: string[] = [];
	for (let i = 0; i < 8; i += 2) {
		groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
	}
	return `${groups.join(":")}::/64`;
}
