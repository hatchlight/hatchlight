import { expect, test } from "bun:test";
import {
	AccountService,
	hashingRunning,
	hashingWaiting,
	hashToken,
	MAX_HASHING,
	MAX_HASHING_QUEUE,
	MIN_PASSWORD_LENGTH,
	type PasswordHasher,
	SESSION_MS,
} from "./accounts";
import { SqliteRepository } from "./db/repository";
import { AccessError, ValidationError } from "./errors";
import { FAST_HASHER } from "./local/testing";
import { base32Decode, totp } from "./totp";
import { LOCAL_USER } from "./types";

const PASSWORD = "correct horse battery";

function setup(hasher: PasswordHasher = FAST_HASHER) {
	const repo = new SqliteRepository(":memory:");
	let now = Date.UTC(2026, 10, 24, 12);
	const adopted: string[] = [];
	const accounts = new AccountService(repo.accounts(), {
		hasher,
		now: () => now,
		adoptLocal: async (id) => {
			adopted.push(id);
		},
	});
	const tick = (ms: number) => {
		now += ms;
	};
	return { repo, accounts, adopted, tick, now: () => now };
}

async function withOwner(hasher?: PasswordHasher) {
	const t = setup(hasher);
	const code = t.accounts.setupCode() as string;
	const owner = await t.accounts.setup({
		code,
		username: "Owner",
		password: PASSWORD,
	});
	return { ...t, owner };
}

const code = async (promise: Promise<unknown>) =>
	(
		(await promise.then(
			() => null,
			(error) => error,
		)) as AccessError | null
	)?.code;

test("the first owner needs the setup code and takes over what was there", async () => {
	const { repo, accounts, adopted } = setup();
	expect(accounts.needsSetup()).toBe(true);
	const setupCode = accounts.setupCode() as string;
	expect(setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
	// The same code until it is used.
	expect(accounts.setupCode()).toBe(setupCode);

	// Made before there were accounts.
	await repo.createSession({
		id: "ses_1",
		userId: LOCAL_USER.userId,
		title: "before",
		createdAt: 1,
		updatedAt: 1,
	});

	expect(
		await code(
			accounts.setup({
				code: "WRNG-WRNG-WRNG",
				username: "a",
				password: PASSWORD,
			}),
		),
	).toBe("badSetupCode");
	const signed = await accounts.setup({
		code: setupCode.toLowerCase(),
		username: "Ana",
		password: PASSWORD,
	});
	expect(signed.user.role).toBe("owner");
	expect(adopted).toEqual([signed.user.id]);
	expect(await repo.listSessions({ userId: signed.user.id })).toHaveLength(1);
	expect(await repo.listSessions(LOCAL_USER)).toHaveLength(0);

	// Once only.
	expect(accounts.needsSetup()).toBe(false);
	expect(accounts.setupCode()).toBeNull();
	expect(
		await code(
			accounts.setup({ code: setupCode, username: "b", password: PASSWORD }),
		),
	).toBe("badSetupCode");
	// Stored as a hash.
	expect(repo.accounts().getSession(hashToken(signed.token))).not.toBeNull();
	expect(repo.accounts().getSession(signed.token)).toBeNull();
});

test("passwords must be long enough and usernames plain", async () => {
	const { accounts } = setup();
	const setupCode = accounts.setupCode() as string;
	const short = accounts.setup({
		code: setupCode,
		username: "ana",
		password: "x".repeat(MIN_PASSWORD_LENGTH - 1),
	});
	await expect(short).rejects.toBeInstanceOf(ValidationError);
	expect(await code(short)).toBe("passwordTooShort");
	expect(
		await code(
			accounts.setup({ code: setupCode, username: "a b", password: PASSWORD }),
		),
	).toBe("usernameInvalid");
});

test("a wrong username and a wrong password get the same answer", async () => {
	const { accounts } = await withOwner();
	const wrongUser = accounts.login({ username: "nobody", password: PASSWORD });
	const wrongPassword = accounts.login({
		username: "owner",
		password: "nope nope nope",
	});
	const [a, b] = (await Promise.all([
		wrongUser.catch((e) => e),
		wrongPassword.catch((e) => e),
	])) as AccessError[];
	expect(a?.code).toBe("badCredentials");
	expect(b?.code).toBe("badCredentials");
	expect(a?.message).toBe(b?.message as string);
	expect(a?.status).toBe(401);
	// Usernames are found whatever their case.
	const signed = await accounts.login({
		username: "OWNER",
		password: PASSWORD,
	});
	// Kept in lower case, and found whatever the case.
	expect(signed.user.username).toBe("owner");
});

test("sessions slide for 30 days, touched at most once a minute", async () => {
	const { accounts, owner, tick, repo } = await withOwner();
	const seen = accounts.resolveSession(owner.token);
	expect(seen?.user.id).toBe(owner.user.id);
	const row = () => repo.accounts().getSession(hashToken(owner.token));
	const first = row()?.lastSeenAt;
	tick(30_000);
	accounts.resolveSession(owner.token);
	expect(row()?.lastSeenAt).toBe(first as number);
	tick(31_000);
	accounts.resolveSession(owner.token);
	expect(row()?.lastSeenAt).toBe((first as number) + 61_000);

	tick(SESSION_MS - 1);
	expect(accounts.resolveSession(owner.token)).not.toBeNull();
	tick(SESSION_MS + 1);
	expect(accounts.resolveSession(owner.token)).toBeNull();
	expect(accounts.resolveSession("made up")).toBeNull();
});

test("people see and end their own sessions", async () => {
	const { accounts, owner } = await withOwner();
	const other = await accounts.login({ username: "owner", password: PASSWORD });
	const id = (token: string) =>
		accounts.resolveSession(token)?.sessionId as string;
	const list = accounts.sessions(owner.user.id, id(owner.token));
	expect(list).toHaveLength(2);
	expect(list.filter((s) => s.current)).toHaveLength(1);

	accounts.revokeSession(owner.user.id, id(other.token));
	expect(accounts.resolveSession(other.token)).toBeNull();
	expect(() => accounts.revokeSession(owner.user.id, "nope")).toThrow();

	const third = await accounts.login({ username: "owner", password: PASSWORD });
	accounts.revokeOtherSessions(owner.user.id, id(owner.token));
	expect(accounts.resolveSession(third.token)).toBeNull();
	expect(accounts.resolveSession(owner.token)).not.toBeNull();
	accounts.logout(owner.user.id, id(owner.token));
	expect(accounts.resolveSession(owner.token)).toBeNull();
});

test("a new password signs out the other browsers", async () => {
	const { accounts, owner } = await withOwner();
	const other = await accounts.login({ username: "owner", password: PASSWORD });
	const keep = accounts.resolveSession(owner.token)?.sessionId ?? null;
	expect(
		await code(
			accounts.changePassword(
				owner.user.id,
				{ current: "wrong one!", next: "another password" },
				keep,
			),
		),
	).toBe("badPassword");
	await accounts.changePassword(
		owner.user.id,
		{ current: PASSWORD, next: "another password" },
		keep,
	);
	expect(accounts.resolveSession(other.token)).toBeNull();
	expect(accounts.resolveSession(owner.token)).not.toBeNull();
	await accounts.login({ username: "owner", password: "another password" });
});

test("two-step sign-in asks for the app's code, each code once", async () => {
	const { accounts, owner, now, tick } = await withOwner();
	const { secret, uri } = accounts.startTotp(owner.user.id);
	expect(uri).toContain(`secret=${secret}`);
	const at = () =>
		totp(base32Decode(secret) as Uint8Array, Math.floor(now() / 1000));
	expect(
		await code(
			accounts.enableTotp(owner.user.id, {
				secret,
				code: "000000",
				password: PASSWORD,
			}),
		),
	).toBe("badTotp");
	// Turning it on takes the password.
	expect(
		await code(
			accounts.enableTotp(owner.user.id, {
				secret,
				code: at(),
				password: "not the password",
			}),
		),
	).toBe("badPassword");
	await accounts.enableTotp(owner.user.id, {
		secret,
		code: at(),
		password: PASSWORD,
	});

	expect(
		await code(accounts.login({ username: "owner", password: PASSWORD })),
	).toBe("totpRequired");
	// The code that turned it on is spent.
	expect(
		await code(
			accounts.login({ username: "owner", password: PASSWORD, totp: at() }),
		),
	).toBe("badTotp");
	tick(30_000);
	expect(
		await code(
			accounts.login({ username: "owner", password: PASSWORD, totp: "123456" }),
		),
	).toBe("badTotp");
	// A wrong password never reveals that a code would be asked.
	expect(
		await code(
			accounts.login({
				username: "owner",
				password: "wrong wrong",
				totp: at(),
			}),
		),
	).toBe("badCredentials");
	const fresh = at();
	await accounts.login({ username: "owner", password: PASSWORD, totp: fresh });
	// Seen once, a code cannot be used again.
	expect(
		await code(
			accounts.login({ username: "owner", password: PASSWORD, totp: fresh }),
		),
	).toBe("badTotp");

	// Moving it to another app takes the password and a current code.
	const next = accounts.startTotp(owner.user.id);
	const nextAt = () =>
		totp(base32Decode(next.secret) as Uint8Array, Math.floor(now() / 1000));
	tick(30_000);
	expect(
		await code(
			accounts.enableTotp(owner.user.id, {
				secret: next.secret,
				code: nextAt(),
				password: PASSWORD,
			}),
		),
	).toBe("totpRequired");
	await accounts.enableTotp(owner.user.id, {
		secret: next.secret,
		code: nextAt(),
		password: PASSWORD,
		current: at(),
	});

	// Turning it off too.
	tick(30_000);
	expect(
		await code(accounts.disableTotp(owner.user.id, { password: PASSWORD })),
	).toBe("totpRequired");
	await accounts.disableTotp(owner.user.id, {
		password: PASSWORD,
		code: nextAt(),
	});
	await accounts.login({ username: "owner", password: PASSWORD });
});

test("invites make accounts once, before they expire", async () => {
	const { accounts, owner, tick } = await withOwner();
	const { token, invite } = accounts.createInvite(owner.user, {
		role: "member",
		canUsePaid: false,
		canTrain: true,
		monthlyLimitUsd: 5,
	});
	expect(accounts.inviteFor(token)?.role).toBe("member");
	expect(accounts.invites().map((i) => i.id)).toEqual([invite.id]);
	const bia = await accounts.acceptInvite(token, {
		username: "bia",
		password: PASSWORD,
	});
	expect(bia.user).toMatchObject({
		role: "member",
		canTrain: true,
		monthlyLimitUsd: 5,
	});
	expect(accounts.inviteFor(token)).toBeNull();
	expect(
		await code(
			accounts.acceptInvite(token, { username: "cai", password: PASSWORD }),
		),
	).toBe("inviteInvalid");

	const late = accounts.createInvite(owner.user, {
		role: "member",
		canUsePaid: false,
		canTrain: false,
		monthlyLimitUsd: null,
	});
	tick(8 * 24 * 60 * 60 * 1000);
	expect(
		await code(
			accounts.acceptInvite(late.token, {
				username: "dan",
				password: PASSWORD,
			}),
		),
	).toBe("inviteInvalid");
	// Taken names stay taken, whatever the case.
	const again = accounts.createInvite(owner.user, {
		role: "member",
		canUsePaid: false,
		canTrain: false,
		monthlyLimitUsd: null,
	});
	expect(
		await code(
			accounts.acceptInvite(again.token, {
				username: "BIA",
				password: PASSWORD,
			}),
		),
	).toBe("usernameTaken");
});

test("admins manage members but not owners, and the last owner stays", async () => {
	const { accounts, owner } = await withOwner();
	const invite = (role: "admin" | "member") =>
		accounts.createInvite(owner.user, {
			role,
			canUsePaid: false,
			canTrain: false,
			monthlyLimitUsd: null,
		}).token;
	const admin = await accounts.acceptInvite(invite("admin"), {
		username: "adm",
		password: PASSWORD,
	});
	const member = await accounts.acceptInvite(invite("member"), {
		username: "mem",
		password: PASSWORD,
	});

	expect(() =>
		accounts.createInvite(admin.user, {
			role: "owner",
			canUsePaid: true,
			canTrain: true,
			monthlyLimitUsd: null,
		}),
	).toThrow(AccessError);
	expect(() =>
		accounts.updateUser(admin.user, member.user.id, { role: "owner" }),
	).toThrow(AccessError);
	expect(() =>
		accounts.updateUser(admin.user, owner.user.id, { disabled: true }),
	).toThrow(AccessError);
	expect(() =>
		accounts.updateUser(member.user, admin.user.id, { canTrain: true }),
	).toThrow(AccessError);
	expect(
		accounts.updateUser(admin.user, member.user.id, { canUsePaid: true })
			.canUsePaid,
	).toBe(true);

	// Disabling ends their sessions.
	accounts.updateUser(admin.user, member.user.id, { disabled: true });
	expect(accounts.resolveSession(member.token)).toBeNull();
	expect(
		await code(accounts.login({ username: "mem", password: PASSWORD })),
	).toBe("badCredentials");

	expect(() =>
		accounts.updateUser(owner.user, owner.user.id, { role: "admin" }),
	).toThrow("at least one owner");
	expect(() =>
		accounts.updateUser(owner.user, owner.user.id, { disabled: true }),
	).toThrow("at least one owner");
	// With a second owner, the first may step down.
	accounts.updateUser(owner.user, admin.user.id, { role: "owner" });
	accounts.updateUser(owner.user, owner.user.id, { role: "admin" });
});

test("the console reset gives a one-time password, ends sign-ins, tokens and two-step", async () => {
	const { accounts, owner, now } = await withOwner();
	const { secret } = accounts.startTotp(owner.user.id);
	await accounts.enableTotp(owner.user.id, {
		secret,
		code: totp(base32Decode(secret) as Uint8Array, Math.floor(now() / 1000)),
		password: PASSWORD,
	});
	const token = accounts.createApiToken(owner.user.id, {
		name: "agent",
		scopes: ["read"],
	}).token;
	const temporary = await accounts.resetPasswordFromConsole(owner.user.id);
	expect(accounts.resolveSession(owner.token)).toBeNull();
	expect(accounts.resolveApiToken(token)).toBeNull();
	// Two-step is off: a lost phone is why one ends up here.
	const signed = await accounts.login({
		username: "owner",
		password: temporary,
	});
	expect(signed.user.mustChangePassword).toBe(true);
	await accounts.changePassword(
		owner.user.id,
		{ current: temporary, next: "a brand new password" },
		null,
	);
	expect(accounts.getUser(owner.user.id)?.mustChangePassword).toBe(false);
});

test("a reset link sets a new password once, within a day", async () => {
	const { accounts, owner, tick } = await withOwner();
	const member = await accounts.acceptInvite(
		accounts.createInvite(owner.user, {
			role: "member",
			canUsePaid: false,
			canTrain: false,
			monthlyLimitUsd: null,
		}).token,
		{ username: "mem", password: PASSWORD },
	);
	const token = accounts.createApiToken(member.user.id, {
		name: "agent",
		scopes: ["read"],
	}).token;
	const link = accounts.createPasswordReset(owner.user, member.user.id);
	expect(accounts.passwordResetFor(link.token)).toEqual({ username: "mem" });
	await accounts.usePasswordReset(link.token, "the member's own choice");
	expect(accounts.resolveSession(member.token)).toBeNull();
	expect(accounts.resolveApiToken(token)).toBeNull();
	await accounts.login({
		username: "mem",
		password: "the member's own choice",
	});
	expect(
		await code(accounts.usePasswordReset(link.token, "another one, later")),
	).toBe("resetInvalid");

	const late = accounts.createPasswordReset(owner.user, member.user.id);
	tick(25 * 60 * 60 * 1000);
	expect(accounts.passwordResetFor(late.token)).toBeNull();
	expect(
		await code(accounts.usePasswordReset(late.token, "too late for this")),
	).toBe("resetInvalid");
});

test("API tokens act for their person until they expire", async () => {
	const { accounts, owner, tick } = await withOwner();
	const { token, view } = accounts.createApiToken(owner.user.id, {
		name: "agent",
		scopes: ["read"],
		expiresInDays: 30,
	});
	// Recognisable by secret scanners.
	expect(token).toMatch(/^hl_[\w-]{43}$/);
	expect(accounts.resolveApiToken(token)?.user.id).toBe(owner.user.id);
	expect(accounts.resolveApiToken(`${token}x`)).toBeNull();
	// The secret without its prefix is not a token.
	expect(accounts.resolveApiToken(token.slice(3))).toBeNull();
	expect(view.expiresAt).toBe(view.createdAt + 30 * 24 * 60 * 60 * 1000);
	tick(31 * 24 * 60 * 60 * 1000);
	expect(accounts.resolveApiToken(token)).toBeNull();
});

test("tokens are listed without their secret, and revoked one by one", async () => {
	const { accounts, owner } = await withOwner();
	const first = accounts.createApiToken(owner.user.id, {
		name: " laptop ",
		scopes: ["read", "generate", "read"],
		spendLimitUsd: 5,
	});
	const second = accounts.createApiToken(owner.user.id, {
		name: "ci",
		scopes: ["read"],
	});
	const listed = accounts.listApiTokens(owner.user.id);
	expect(listed.map((t) => t.name)).toEqual(["ci", "laptop"]);
	expect(listed[1]).toMatchObject({
		scopes: ["read", "generate"],
		spendLimitUsd: 5,
		spentUsd: 0,
		expiresAt: null,
	});
	expect(JSON.stringify(listed)).not.toContain(first.token);
	expect(JSON.stringify(listed)).not.toContain(first.token.slice(3));
	accounts.revokeApiToken(owner.user.id, first.view.id);
	expect(accounts.resolveApiToken(first.token)).toBeNull();
	expect(accounts.resolveApiToken(second.token)).not.toBeNull();
	expect(
		await code(
			Promise.resolve().then(() =>
				accounts.revokeApiToken(owner.user.id, first.view.id),
			),
		),
	).toBe("tokenNotFound");
});

test("a token never gets more than its person may do", async () => {
	const { accounts, owner } = await withOwner();
	const member = await accounts.acceptInvite(
		accounts.createInvite(owner.user, {
			role: "member",
			canUsePaid: false,
			canTrain: false,
			monthlyLimitUsd: null,
		}).token,
		{ username: "mem", password: PASSWORD },
	);
	/** The error's code, or its kind for one without. */
	const make = async (
		input: Partial<Parameters<typeof accounts.createApiToken>[1]>,
	) => {
		try {
			accounts.createApiToken(member.user.id, {
				name: "t",
				scopes: ["read"],
				...input,
			});
			return null;
		} catch (error) {
			return error instanceof ValidationError
				? "validation"
				: (error as AccessError).code;
		}
	};
	expect(await make({ scopes: ["paid"] })).toBe("paidNotAllowed");
	expect(await make({ scopes: ["train"] })).toBe("forbidden");
	expect(await make({ scopes: [] })).toBe("validation");
	expect(await make({ scopes: ["admin"] })).toBe("validation");
	expect(await make({ name: "  " })).toBe("validation");
	expect(await make({ spendLimitUsd: -1 })).toBe("validation");
	expect(await make({ expiresInDays: 7 })).toBe("validation");
	// Others' tokens: an admin or owner who manages the person.
	const { view } = accounts.createApiToken(member.user.id, {
		name: "t",
		scopes: ["read"],
	});
	expect(
		accounts.listApiTokensOf(owner.user, member.user.id).map((t) => t.id),
	).toEqual([view.id]);
	expect(
		await code(
			Promise.resolve().then(() =>
				accounts.listApiTokensOf(member.user, owner.user.id),
			),
		),
	).toBe("forbidden");
	accounts.revokeApiTokenOf(owner.user, member.user.id, view.id);
	expect(accounts.listApiTokens(member.user.id)).toEqual([]);
});

/**
 * A hasher that counts the checks running at once, each taking a little
 * while so that those let through together overlap.
 */
function countingHasher() {
	const seen = { now: 0, most: 0, calls: 0 };
	const hasher: PasswordHasher = {
		hash: FAST_HASHER.hash,
		verify: async (password, hash) => {
			seen.calls++;
			seen.now++;
			seen.most = Math.max(seen.most, seen.now);
			try {
				await Bun.sleep(5);
				return await FAST_HASHER.verify(password, hash);
			} finally {
				seen.now--;
			}
		},
	};
	return { hasher, seen };
}

test("only a few password checks run at once, the others wait", async () => {
	const { hasher, seen } = countingHasher();
	const { accounts } = await withOwner(hasher);
	await Promise.all(
		Array.from({ length: 12 }, () =>
			accounts
				.login({ username: "owner", password: "not it at all" })
				.catch(() => {}),
		),
	);
	expect(seen.calls).toBe(12);
	expect(seen.most).toBe(MAX_HASHING);
	expect(hashingRunning()).toBe(0);
});

test("admins manage members only: not themselves, not other admins", async () => {
	const { accounts, owner } = await withOwner();
	const join = async (role: "admin" | "member", username: string) =>
		(
			await accounts.acceptInvite(
				accounts.createInvite(owner.user, {
					role,
					canUsePaid: false,
					canTrain: false,
					monthlyLimitUsd: 1,
				}).token,
				{ username, password: PASSWORD },
			)
		).user;
	const admin = await join("admin", "adm");
	const other = await join("admin", "adm2");
	const member = await join("member", "mem");
	const refused = (fn: () => unknown) => expect(fn).toThrow(AccessError);
	// Not their own limit, nor another admin's account.
	refused(() =>
		accounts.updateUser(admin, admin.id, { monthlyLimitUsd: null }),
	);
	refused(() => accounts.updateUser(admin, other.id, { disabled: true }));
	refused(() => accounts.createPasswordReset(admin, other.id));
	refused(() => accounts.createPasswordReset(admin, admin.id));
	// Nor make admins.
	refused(() => accounts.updateUser(admin, member.id, { role: "admin" }));
	refused(() =>
		accounts.createInvite(admin, {
			role: "admin",
			canUsePaid: false,
			canTrain: false,
			monthlyLimitUsd: null,
		}),
	);
	// Members are theirs to manage.
	expect(
		accounts.updateUser(admin, member.id, { canTrain: true }).canTrain,
	).toBe(true);
	accounts.createPasswordReset(admin, member.id);
	// Nobody but an owner changes their own account.
	refused(() =>
		accounts.updateUser(member, member.id, { monthlyLimitUsd: null }),
	);
	expect(
		accounts.updateUser(owner.user, owner.user.id, { monthlyLimitUsd: 3 })
			.monthlyLimitUsd,
	).toBe(3);
	// Owners manage admins.
	accounts.updateUser(owner.user, admin.id, { monthlyLimitUsd: null });
});

test("a person's API tokens end when what they may do changes", async () => {
	const { accounts, owner } = await withOwner();
	const member = await accounts.acceptInvite(
		accounts.createInvite(owner.user, {
			role: "member",
			canUsePaid: false,
			canTrain: false,
			monthlyLimitUsd: null,
		}).token,
		{ username: "mem", password: PASSWORD },
	);
	const token = () =>
		accounts.createApiToken(member.user.id, { name: "t", scopes: ["read"] })
			.token;
	const promoted = token();
	accounts.updateUser(owner.user, member.user.id, { role: "admin" });
	expect(accounts.resolveApiToken(promoted)).toBeNull();
	const disabled = token();
	accounts.updateUser(owner.user, member.user.id, { disabled: true });
	expect(accounts.resolveApiToken(disabled)).toBeNull();
	accounts.updateUser(owner.user, member.user.id, { disabled: false });
	const changed = token();
	await accounts.changePassword(
		member.user.id,
		{ current: PASSWORD, next: "a newer password" },
		null,
	);
	expect(accounts.resolveApiToken(changed)).toBeNull();
});

test("usernames are plain ASCII, 3 to 32 characters, in lower case", async () => {
	const { accounts, owner } = await withOwner();
	const join = (username: string) =>
		accounts.acceptInvite(
			accounts.createInvite(owner.user, {
				role: "member",
				canUsePaid: false,
				canTrain: false,
				monthlyLimitUsd: null,
			}).token,
			{ username, password: PASSWORD },
		);
	for (const bad of ["ab", "ãna", "аdmin", "a b", "x".repeat(33)]) {
		expect(await code(join(bad))).toBe("usernameInvalid");
	}
	expect((await join("Ana.Silva")).user.username).toBe("ana.silva");
});

test("the same two-step code sent twice at once lets only one in", async () => {
	const { accounts, owner, now, tick } = await withOwner();
	const { secret } = accounts.startTotp(owner.user.id);
	const at = () =>
		totp(base32Decode(secret) as Uint8Array, Math.floor(now() / 1000));
	await accounts.enableTotp(owner.user.id, {
		secret,
		code: at(),
		password: PASSWORD,
	});
	tick(30_000);
	const code = at();
	const results = await Promise.allSettled(
		Array.from({ length: 5 }, () =>
			accounts.login({ username: "owner", password: PASSWORD, totp: code }),
		),
	);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});

test("a full line of password checks is refused as busy, not queued for ever", async () => {
	const { accounts } = await withOwner();
	const tries = Array.from(
		{ length: MAX_HASHING + MAX_HASHING_QUEUE + 6 },
		() =>
			accounts.login({ username: "owner", password: "not it at all" }).then(
				() => null,
				(error: AccessError) => error,
			),
	);
	const errors = await Promise.all(tries);
	const busy = errors.filter((e) => e?.code === "serverBusy");
	expect(busy.length).toBe(6);
	expect(busy[0]?.status).toBe(503);
	expect(hashingWaiting()).toBe(0);
});

test("a check whose request went away leaves the line", async () => {
	const { accounts } = await withOwner();
	// Takes every slot.
	const running = Array.from({ length: MAX_HASHING }, () =>
		accounts
			.login({ username: "owner", password: "not it at all" })
			.catch(() => {}),
	);
	const gone = new AbortController();
	const waiting = accounts
		.login(
			{ username: "owner", password: "not it at all" },
			{ signal: gone.signal },
		)
		.then(
			() => "signed in",
			(error: unknown) => error,
		);
	expect(hashingWaiting()).toBe(1);
	gone.abort(new Error("the browser left"));
	expect(hashingWaiting()).toBe(0);
	expect(((await waiting) as Error).message).toBe("the browser left");
	await Promise.all(running);
});

test("a password that cannot be right is refused without checking", async () => {
	const { accounts } = await withOwner();
	let most = 0;
	const watch = setInterval(() => {
		most = Math.max(most, hashingRunning());
	}, 0);
	for (const password of ["short", "x".repeat(300)]) {
		expect(await code(accounts.login({ username: "owner", password }))).toBe(
			"badCredentials",
		);
		expect(await code(accounts.login({ username: "nobody", password }))).toBe(
			"badCredentials",
		);
	}
	clearInterval(watch);
	expect(most).toBe(0);
});

test("a new reset link ends older ones, and the person is told who reset", async () => {
	const { accounts, owner, tick } = await withOwner();
	// Nothing to change is not an error.
	accounts.updateUser(owner.user, owner.user.id, {});
	const member = await accounts.acceptInvite(
		accounts.createInvite(owner.user, {
			role: "member",
			canUsePaid: false,
			canTrain: false,
			monthlyLimitUsd: null,
		}).token,
		{ username: "mem", password: PASSWORD },
	);
	const first = accounts.createPasswordReset(owner.user, member.user.id);
	tick(1000);
	const second = accounts.createPasswordReset(owner.user, member.user.id);
	expect(accounts.passwordResetFor(first.token)).toBeNull();
	expect(
		await code(accounts.usePasswordReset(first.token, "first link password")),
	).toBe("resetInvalid");
	expect(accounts.view(member.user, true).resetNotice).toBeNull();

	tick(1000);
	await accounts.usePasswordReset(second.token, "second link password");
	const user = accounts.getUser(member.user.id);
	if (!user) throw new Error("gone");
	const seen = accounts.view(user, true);
	expect(seen.resetNotice?.by).toBe("owner");
	expect(seen.lastReset).toEqual(seen.resetNotice);
	// Admins see the last reset; only the person sees the notice.
	const listed = accounts.users().find((u) => u.id === member.user.id);
	expect(listed?.lastReset?.by).toBe("owner");
	expect(listed?.resetNotice).toBeNull();
	// Shown until seen, then not again.
	accounts.dismissResetNotice(member.user.id);
	expect(accounts.view(user, true).resetNotice).toBeNull();
	expect(accounts.view(user, true).lastReset?.by).toBe("owner");
});

test("a sign-in whose request is gone does not touch the database", async () => {
	const { repo, accounts } = await withOwner();
	repo.close();
	const gone = new AbortController();
	gone.abort(new Error("the browser left"));
	const result = await accounts
		.login({ username: "owner", password: PASSWORD }, { signal: gone.signal })
		.catch((error: Error) => error.message);
	expect(result).toBe("the browser left");
});
