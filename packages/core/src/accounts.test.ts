import { expect, test } from "bun:test";
import {
	AccountService,
	hashingRunning,
	hashToken,
	MAX_HASHING,
	MIN_PASSWORD_LENGTH,
	SESSION_MS,
} from "./accounts";
import { SqliteRepository } from "./db/repository";
import { AccessError, ValidationError } from "./errors";
import { base32Decode, totp } from "./totp";
import { LOCAL_USER } from "./types";

const PASSWORD = "correct horse battery";

function setup() {
	const repo = new SqliteRepository(":memory:");
	let now = Date.UTC(2026, 10, 24, 12);
	const adopted: string[] = [];
	const accounts = new AccountService(repo.accounts(), {
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

async function withOwner() {
	const t = setup();
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
	expect(signed.user.username).toBe("Owner");
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

test("two-step sign-in asks for the app's code", async () => {
	const { accounts, owner, now } = await withOwner();
	const { secret, uri } = accounts.startTotp(owner.user.id);
	expect(uri).toContain(`secret=${secret}`);
	const at = () =>
		totp(base32Decode(secret) as Uint8Array, Math.floor(now() / 1000));
	expect(() => accounts.enableTotp(owner.user.id, secret, "000000")).toThrow();
	accounts.enableTotp(owner.user.id, secret, at());

	expect(
		await code(accounts.login({ username: "owner", password: PASSWORD })),
	).toBe("totpRequired");
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
	await accounts.login({ username: "owner", password: PASSWORD, totp: at() });

	await accounts.disableTotp(owner.user.id, PASSWORD);
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

test("a reset password works once and must then be changed", async () => {
	const { accounts, owner } = await withOwner();
	const temporary = await accounts.resetPassword(null, owner.user.id);
	expect(accounts.resolveSession(owner.token)).toBeNull();
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

test("API tokens act for their person until they expire", async () => {
	const { accounts, owner, tick } = await withOwner();
	const token = accounts.createApiToken(owner.user.id, {
		name: "agent",
		expiresAt: Date.UTC(2026, 10, 25),
	});
	expect(accounts.resolveApiToken(token)?.user.id).toBe(owner.user.id);
	expect(accounts.resolveApiToken(`${token}x`)).toBeNull();
	tick(2 * 24 * 60 * 60 * 1000);
	expect(accounts.resolveApiToken(token)).toBeNull();
});

test("only a few password checks run at once, the others wait", async () => {
	const { accounts } = await withOwner();
	let most = 0;
	const watch = setInterval(() => {
		most = Math.max(most, hashingRunning());
	}, 1);
	await Promise.all(
		Array.from({ length: 12 }, () =>
			accounts
				.login({ username: "owner", password: "not it at all" })
				.catch(() => {}),
		),
	);
	clearInterval(watch);
	expect(most).toBeGreaterThan(0);
	expect(most).toBeLessThanOrEqual(MAX_HASHING);
	expect(hashingRunning()).toBe(0);
});
