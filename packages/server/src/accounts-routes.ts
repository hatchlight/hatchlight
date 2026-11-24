import {
	AccessError,
	type AccountService,
	accountView,
	type InviteTerms,
	NotFoundError,
	USER_ROLES,
	type UserRole,
	ValidationError,
} from "@hatchlight/core";
import type { Context, Hono } from "hono";
import { clearSessionCookie, setSessionCookie } from "./auth";
import { Limiter } from "./limiter";

/**
 * Sign-in, one's own account, invites and people: the routes a server has
 * and a personal install does not.
 */
export function mountAccounts(
	app: Hono,
	accounts: AccountService,
	json: (c: Context) => Promise<Record<string, unknown>>,
	limits = {
		byAddress: new Limiter({ freeTries: 20 }),
		byName: new Limiter({ freeTries: 5 }),
	},
): void {
	const where = (c: Context) => ({
		userAgent: c.req.header("user-agent") ?? null,
		ip: c.get("client") ?? null,
	});
	const text = (value: unknown, name: string): string => {
		if (typeof value !== "string") {
			throw new ValidationError(`${name} must be text`);
		}
		return value;
	};

	/**
	 * Runs a guess (a password, a code) unless the address or name guessed too
	 * often lately; counts it when it fails.
	 */
	const guarded = async <T>(
		c: Context,
		name: string | null,
		attempt: () => Promise<T>,
	): Promise<T> => {
		const keys = [`ip:${c.get("client") ?? "unknown"}`];
		const nameKey = name ? `user:${name.trim().toLowerCase()}` : null;
		const wait = Math.max(
			limits.byAddress.wait(keys[0] as string),
			nameKey ? limits.byName.wait(nameKey) : 0,
		);
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
		try {
			const result = await attempt();
			if (nameKey) limits.byName.succeed(nameKey);
			return result;
		} catch (error) {
			// Asking for the second step is not a failed guess.
			if (error instanceof AccessError && error.code !== "totpRequired") {
				limits.byAddress.fail(keys[0] as string);
				if (nameKey) limits.byName.fail(nameKey);
			}
			throw error;
		}
	};

	app.get("/api/setup", (c) => c.json({ needed: accounts.needsSetup() }));
	app.post("/api/setup", async (c) => {
		const body = await json(c);
		const signed = await guarded(c, null, () =>
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
		return c.json(accountView(signed.user), 201);
	});

	app.post("/api/login", async (c) => {
		const body = await json(c);
		const username = text(body.username, "username");
		const signed = await guarded(c, username, () =>
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
		return c.json(accountView(signed.user));
	});

	app.post("/api/logout", (c) => {
		const { user, sessionId } = c.get("viewer");
		if (sessionId) accounts.logout(user.id, sessionId);
		clearSessionCookie(c);
		return c.body(null, 204);
	});

	app.get("/api/account", (c) => c.json(accountView(c.get("viewer").user)));
	app.put("/api/account/password", async (c) => {
		const body = await json(c);
		const { user, sessionId } = c.get("viewer");
		await guarded(c, user.username, () =>
			accounts.changePassword(
				user.id,
				{
					current: text(body.current, "current"),
					next: text(body.next, "next"),
				},
				sessionId,
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
		accounts.revokeOtherSessions(user.id, sessionId);
		return c.body(null, 204);
	});
	app.delete("/api/account/sessions/:id", (c) => {
		const { user } = c.get("viewer");
		accounts.revokeSession(user.id, c.req.param("id"));
		return c.body(null, 204);
	});
	app.post("/api/account/totp", (c) =>
		c.json(accounts.startTotp(c.get("viewer").user.id)),
	);
	app.put("/api/account/totp", async (c) => {
		const body = await json(c);
		const { user } = c.get("viewer");
		await guarded(c, user.username, async () =>
			accounts.enableTotp(
				user.id,
				text(body.secret, "secret"),
				text(body.code, "code"),
			),
		);
		return c.body(null, 204);
	});
	app.delete("/api/account/totp", async (c) => {
		const body = await json(c);
		const { user } = c.get("viewer");
		await guarded(c, user.username, () =>
			accounts.disableTotp(user.id, text(body.password, "password")),
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
		const signed = await guarded(c, null, () =>
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
		return c.json(accountView(signed.user), 201);
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
	app.post("/api/users/:id/password", async (c) => {
		const password = await accounts.resetPassword(
			c.get("viewer").user,
			c.req.param("id"),
		);
		return c.json({ password });
	});
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
