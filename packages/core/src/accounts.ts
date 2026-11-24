import { createHash, timingSafeEqual } from "node:crypto";
import type {
	ApiTokenRow,
	InviteRow,
	SqliteAccounts,
	UserPatch,
	UserRow,
} from "./db/accounts";
import { AccessError, NotFoundError, ValidationError } from "./errors";
import { newId } from "./ids";
import { matchTotp, newTotpSecret, totpUri } from "./totp";
import type {
	AccountView,
	AuthSessionView,
	InviteView,
	UserRole,
} from "./types";
import { USER_ROLES } from "./types";

export const MIN_PASSWORD_LENGTH = 10;
/** Longer is no safer, and hashing it would be work for nothing. */
const MAX_PASSWORD_LENGTH = 256;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A browser stays signed in this long after it was last used. */
export const SESSION_MS = 30 * DAY_MS;
/** Sessions are written to at most this often as they are used. */
const TOUCH_MS = 60 * 1000;
const INVITE_MS = 7 * DAY_MS;
const RESET_MS = DAY_MS;
/**
 * Argon2 takes memory and time on purpose; a flood of sign-ins must not
 * take all of both. At most this many run at once, the others wait.
 */
export const MAX_HASHING = 4;
let hashingNow = 0;
const hashingQueue: (() => void)[] = [];

async function hashing<T>(work: () => Promise<T>): Promise<T> {
	if (hashingNow >= MAX_HASHING) {
		await new Promise<void>((resolve) => hashingQueue.push(resolve));
	} else {
		hashingNow++;
	}
	try {
		return await work();
	} finally {
		const next = hashingQueue.shift();
		// The slot goes straight to the next in line.
		if (next) next();
		else hashingNow--;
	}
}

/** How many password checks or hashes are running now. */
export const hashingRunning = () => hashingNow;

const verifyPassword = (password: string, hash: string) =>
	hashing(() => Bun.password.verify(password, hash));

/** ASCII only: names that look alike cannot be told apart otherwise. */
const USERNAME = /^[a-z0-9._-]{3,32}$/;

/** A secret to hand out once: 32 random bytes, in base64url. */
export function newToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"base64url",
	);
}

/** What is stored of a token: its SHA-256, so a copied database opens nothing. */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Compares secrets in a time that says nothing about where they differ. */
export function sameSecret(a: string, b: string): boolean {
	return timingSafeEqual(
		createHash("sha256").update(a).digest(),
		createHash("sha256").update(b).digest(),
	);
}

/** Whether a person may train LoRAs and upload them. */
export const mayTrain = (user: Pick<UserRow, "role" | "canTrain">) =>
	user.role !== "member" || user.canTrain;

/** Whether a person may spend on paid models, with the server's keys. */
export const mayUsePaid = (user: Pick<UserRow, "role" | "canUsePaid">) =>
	user.role !== "member" || user.canUsePaid;

export function accountView(user: UserRow): AccountView {
	return {
		id: user.id,
		username: user.username,
		displayName: user.displayName,
		role: user.role,
		canUsePaid: mayUsePaid(user),
		canTrain: mayTrain(user),
		monthlyLimitUsd: user.monthlyLimitUsd,
		totp: user.totpSecret != null,
		mustChangePassword: user.mustChangePassword,
		disabled: user.disabledAt != null,
		createdAt: user.createdAt,
	};
}

export interface SignedIn {
	user: UserRow;
	/** The cookie's value: shown once, stored only as its hash. */
	token: string;
	expiresAt: number;
}

export interface Seen {
	user: UserRow;
	/** The session's id, or the token's, whichever signed the request. */
	sessionId: string | null;
	apiToken: ApiTokenRow | null;
}

export interface Where {
	userAgent?: string | null;
	ip?: string | null;
}

export interface InviteTerms {
	role: UserRole;
	canUsePaid: boolean;
	canTrain: boolean;
	monthlyLimitUsd: number | null;
}

export interface AccountServiceOptions {
	now?: () => number;
	/**
	 * Gives the first owner what was made before accounts: files outside the
	 * database, such as settings. The database rows move with the owner.
	 */
	adoptLocal?: (ownerId: string) => Promise<void>;
}

const badCredentials = () =>
	new AccessError(
		"The username or password is not right",
		"badCredentials",
		401,
	);

/**
 * People, their sign-ins and invites, for a server. Nothing here runs on a
 * personal install, which has no accounts.
 */
export class AccountService {
	private now: () => number;
	private code: string | null = null;
	private dummy: Promise<string> | null = null;

	constructor(
		private repo: SqliteAccounts,
		private options: AccountServiceOptions = {},
	) {
		this.now = options.now ?? Date.now;
	}

	needsSetup(): boolean {
		return this.repo.countUsers() === 0;
	}

	/**
	 * The code that proves whoever sets up the server can read its logs. Kept
	 * only in memory: a new one each start until the owner exists.
	 */
	setupCode(): string | null {
		if (!this.needsSetup()) return null;
		if (!this.code) {
			const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
			const bytes = crypto.getRandomValues(new Uint8Array(12));
			const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
			this.code = [0, 4, 8]
				.map((i) => chars.slice(i, i + 4).join(""))
				.join("-");
		}
		return this.code;
	}

	async setup(
		input: { code: string; username: string; password: string },
		where: Where = {},
	): Promise<SignedIn> {
		const expected = this.setupCode();
		const typed = input.code.trim().toUpperCase();
		if (!expected || !sameSecret(expected, typed)) {
			throw new AccessError("The setup code is not right", "badSetupCode", 403);
		}
		const user = await this.newUser(input.username, input.password, {
			role: "owner",
			canUsePaid: true,
			canTrain: true,
			monthlyLimitUsd: null,
		});
		if (!this.repo.createFirstOwner(user)) {
			throw new AccessError("The server is already set up", "forbidden", 403);
		}
		this.code = null;
		await this.options.adoptLocal?.(user.id);
		return this.startSession(user, where);
	}

	/**
	 * Finishes giving the first owner what the install had, when a crash cut
	 * setup short after the database moved but before the files did. Safe to
	 * run at every start: it moves only what is still there.
	 */
	async resumeAdoption(): Promise<void> {
		// The first account is the one setup made; its role may have changed.
		const first = this.repo.listUsers()[0];
		if (first) await this.options.adoptLocal?.(first.id);
	}

	/**
	 * Signs a person in. A wrong username and a wrong password look the same,
	 * and take as long.
	 */
	async login(
		input: { username: string; password: string; totp?: string },
		where: Where = {},
	): Promise<SignedIn> {
		const user = this.repo.findUser(input.username.trim());
		const password = input.password.slice(0, MAX_PASSWORD_LENGTH);
		if (!user) {
			await verifyPassword(password, await this.dummyHash());
			throw badCredentials();
		}
		const right = await verifyPassword(password, user.passwordHash);
		if (!right || user.disabledAt != null) throw badCredentials();
		if (user.totpSecret) {
			if (!input.totp) {
				throw new AccessError(
					"Enter the code from your authenticator app",
					"totpRequired",
					401,
				);
			}
			this.useTotpCode(user, input.totp, 401);
		}
		return this.startSession(user, where);
	}

	/** A hash to check unknown usernames against, so they take as long. */
	private dummyHash(): Promise<string> {
		this.dummy ??= Bun.password.hash(newToken(), { algorithm: "argon2id" });
		return this.dummy;
	}

	private startSession(user: UserRow, where: Where): SignedIn {
		const token = newToken();
		const now = this.now();
		const expiresAt = now + SESSION_MS;
		this.repo.createSession({
			id: hashToken(token),
			userId: user.id,
			createdAt: now,
			lastSeenAt: now,
			expiresAt,
			userAgent: where.userAgent?.slice(0, 300) ?? null,
			ip: where.ip ?? null,
		});
		return { user, token, expiresAt };
	}

	/** Who a session cookie belongs to; it lasts 30 days from its last use. */
	resolveSession(token: string): (Seen & { expiresAt: number }) | null {
		const session = this.repo.getSession(hashToken(token));
		const now = this.now();
		if (!session || session.expiresAt < now) return null;
		const user = this.repo.getUser(session.userId);
		if (!user || user.disabledAt != null) return null;
		let expiresAt = session.expiresAt;
		if (now - session.lastSeenAt >= TOUCH_MS) {
			expiresAt = now + SESSION_MS;
			this.repo.touchSession(session.id, now, expiresAt);
		}
		return { user, sessionId: session.id, apiToken: null, expiresAt };
	}

	/** Who an API token belongs to. */
	resolveApiToken(token: string): Seen | null {
		const row = this.repo.getToken(hashToken(token));
		const now = this.now();
		if (!row || (row.expiresAt != null && row.expiresAt < now)) return null;
		const user = this.repo.getUser(row.userId);
		if (!user || user.disabledAt != null) return null;
		if (row.lastUsedAt == null || now - row.lastUsedAt >= TOUCH_MS) {
			this.repo.touchToken(row.id, now);
		}
		return { user, sessionId: null, apiToken: row };
	}

	logout(userId: string, sessionId: string): void {
		this.repo.deleteSession(userId, sessionId);
	}

	sessions(userId: string, current: string | null): AuthSessionView[] {
		return this.repo.listSessions(userId, this.now()).map((s) => ({
			id: s.id,
			createdAt: s.createdAt,
			lastSeenAt: s.lastSeenAt,
			userAgent: s.userAgent,
			ip: s.ip,
			current: s.id === current,
		}));
	}

	revokeSession(userId: string, id: string): void {
		if (!this.repo.deleteSession(userId, id)) {
			throw new NotFoundError("Session not found");
		}
	}

	revokeOtherSessions(userId: string, keep: string | null): void {
		this.repo.deleteSessionsOf(userId, keep ?? undefined);
	}

	/** Changes one's own password; other browsers are signed out. */
	async changePassword(
		userId: string,
		input: { current: string; next: string },
		keep: string | null,
	): Promise<void> {
		const user = this.mustGet(userId);
		if (
			!(await verifyPassword(
				input.current.slice(0, MAX_PASSWORD_LENGTH),
				user.passwordHash,
			))
		) {
			throw new AccessError(
				"The current password is not right",
				"badPassword",
				403,
			);
		}
		this.repo.updateUser(userId, {
			passwordHash: await hashPassword(input.next),
			mustChangePassword: false,
		});
		this.repo.deleteSessionsOf(userId, keep ?? undefined);
		this.repo.deleteTokensOf(userId);
	}

	/** A new secret for an authenticator app, not yet turned on. */
	startTotp(userId: string): { secret: string; uri: string } {
		const user = this.mustGet(userId);
		const secret = newTotpSecret();
		return { secret, uri: totpUri(secret, user.username, "Hatchlight") };
	}

	/**
	 * Accepts a two-step code once: a code already used, or an older one,
	 * is refused, so a code seen over a shoulder cannot be replayed.
	 */
	private useTotpCode(user: UserRow, code: string, status: 401 | 403): void {
		const step = user.totpSecret
			? matchTotp(user.totpSecret, code, this.now())
			: null;
		// Checked and spent in one statement: two sign-ins at once with the
		// same code cannot both pass.
		if (step === null || !this.repo.advanceTotpCounter(user.id, step)) {
			throw new AccessError("The code is not right", "badTotp", status);
		}
		user.totpLastCounter = step;
	}

	/** Who changes two-step sign-in proves it with the password and the code. */
	private async assertOwnsAccount(
		user: UserRow,
		password: string,
		code: string | undefined,
	): Promise<void> {
		if (
			!(await verifyPassword(
				password.slice(0, MAX_PASSWORD_LENGTH),
				user.passwordHash,
			))
		) {
			throw new AccessError(
				"The current password is not right",
				"badPassword",
				403,
			);
		}
		if (user.totpSecret) {
			if (!code) {
				throw new AccessError(
					"Enter the code from your authenticator app",
					"totpRequired",
					403,
				);
			}
			this.useTotpCode(user, code, 403);
		}
	}

	/**
	 * Turns two-step sign-in on, or moves it to a new app, once the new app
	 * shows the right code. Needs the password, and the current code when it
	 * is already on.
	 */
	async enableTotp(
		userId: string,
		input: { secret: string; code: string; password: string; current?: string },
	): Promise<void> {
		const user = this.mustGet(userId);
		await this.assertOwnsAccount(user, input.password, input.current);
		const step = /^[A-Z2-7]{32}$/.test(input.secret)
			? matchTotp(input.secret, input.code, this.now())
			: null;
		if (step === null) {
			throw new AccessError("The code is not right", "badTotp", 403);
		}
		this.repo.updateUser(userId, {
			totpSecret: input.secret,
			totpLastCounter: step,
		});
	}

	/** Turns two-step sign-in off, with the password and a current code. */
	async disableTotp(
		userId: string,
		input: { password: string; code?: string },
	): Promise<void> {
		const user = this.mustGet(userId);
		await this.assertOwnsAccount(user, input.password, input.code);
		this.repo.updateUser(userId, { totpSecret: null, totpLastCounter: null });
	}

	createInvite(
		actor: UserRow,
		terms: InviteTerms,
	): { token: string; invite: InviteView } {
		this.assertMayGrant(actor, terms.role);
		const token = newToken();
		const now = this.now();
		const row: InviteRow = {
			id: hashToken(token),
			role: terms.role,
			canUsePaid: terms.canUsePaid,
			canTrain: terms.canTrain,
			monthlyLimitUsd: terms.monthlyLimitUsd,
			expiresAt: now + INVITE_MS,
			createdBy: actor.id,
			createdAt: now,
			usedBy: null,
			usedAt: null,
		};
		this.repo.createInvite(row);
		return { token, invite: inviteView(row) };
	}

	invites(): InviteView[] {
		return this.repo.listInvites().map(inviteView);
	}

	deleteInvite(id: string): void {
		if (!this.repo.deleteInvite(id))
			throw new NotFoundError("Invite not found");
	}

	/** What an invite link offers, or null when it cannot be used. */
	inviteFor(token: string): InviteView | null {
		const row = this.repo.getInvite(hashToken(token));
		if (!row || row.usedAt != null || row.expiresAt < this.now()) return null;
		return inviteView(row);
	}

	async acceptInvite(
		token: string,
		input: { username: string; password: string },
		where: Where = {},
	): Promise<SignedIn> {
		const invalid = () =>
			new AccessError(
				"This invite has expired or was already used",
				"inviteInvalid",
				403,
			);
		const row = this.repo.getInvite(hashToken(token));
		if (!row || row.usedAt != null || row.expiresAt < this.now()) {
			throw invalid();
		}
		const user = await this.newUser(input.username, input.password, row);
		if (!this.repo.acceptInvite(row.id, user)) throw invalid();
		return this.startSession(user, where);
	}

	users(): AccountView[] {
		return this.repo.listUsers().map(accountView);
	}

	/** Changes another person's account, as an owner or admin may. */
	updateUser(
		actor: UserRow,
		id: string,
		change: Partial<InviteTerms> & { disabled?: boolean; displayName?: string },
	): AccountView {
		const user = this.mustGet(id);
		this.assertMayManage(actor, user);
		if (change.role !== undefined) this.assertMayGrant(actor, change.role);
		const patch: UserPatch = {};
		if (change.role !== undefined) patch.role = change.role;
		if (change.canUsePaid !== undefined) patch.canUsePaid = change.canUsePaid;
		if (change.canTrain !== undefined) patch.canTrain = change.canTrain;
		if (change.monthlyLimitUsd !== undefined) {
			patch.monthlyLimitUsd = change.monthlyLimitUsd;
		}
		if (change.displayName !== undefined) {
			patch.displayName = displayName(change.displayName, user.username);
		}
		if (change.disabled !== undefined) {
			patch.disabledAt = change.disabled
				? (user.disabledAt ?? this.now())
				: null;
		}
		const losesOwner =
			user.role === "owner" &&
			user.disabledAt == null &&
			((patch.role !== undefined && patch.role !== "owner") ||
				patch.disabledAt != null);
		if (losesOwner && this.repo.countActiveOwners() <= 1) {
			throw new AccessError(
				"The server needs at least one owner who can sign in",
				"lastOwner",
				403,
			);
		}
		this.repo.updateUser(id, patch);
		// Signed out at once: what they may do just changed.
		if (patch.disabledAt != null) this.repo.deleteSessionsOf(id);
		// Tokens were made for what the person could do then.
		if (
			patch.disabledAt != null ||
			(patch.role !== undefined && patch.role !== user.role)
		) {
			this.repo.deleteTokensOf(id);
		}
		return accountView(this.mustGet(id));
	}

	/**
	 * For an owner locked out, from the server's command line: a one-time
	 * password that must be changed at the next sign-in. Two-step sign-in is
	 * turned off, since a lost phone is why one ends up here. Every sign-in
	 * and API token of the person ends.
	 */
	async resetPasswordFromConsole(id: string): Promise<string> {
		this.mustGet(id);
		const temporary = newToken().slice(0, 16);
		this.repo.updateUser(id, {
			passwordHash: await hashPassword(temporary),
			mustChangePassword: true,
			totpSecret: null,
			totpLastCounter: null,
		});
		this.repo.deleteSessionsOf(id);
		this.repo.deleteTokensOf(id);
		return temporary;
	}

	/**
	 * A link, valid for a day and once, for the person to choose a new
	 * password: nobody else learns it.
	 */
	createPasswordReset(
		actor: UserRow,
		id: string,
	): { token: string; expiresAt: number } {
		const user = this.mustGet(id);
		this.assertMayManage(actor, user);
		const token = newToken();
		const now = this.now();
		const expiresAt = now + RESET_MS;
		this.repo.createPasswordReset({
			id: hashToken(token),
			userId: id,
			createdBy: actor.id,
			createdAt: now,
			expiresAt,
			usedAt: null,
		});
		return { token, expiresAt };
	}

	/** Whose password a reset link sets, or null when it cannot be used. */
	passwordResetFor(token: string): { username: string } | null {
		const reset = this.repo.getPasswordReset(hashToken(token));
		if (!reset || reset.usedAt != null || reset.expiresAt < this.now()) {
			return null;
		}
		const user = this.repo.getUser(reset.userId);
		return user && user.disabledAt == null ? { username: user.username } : null;
	}

	/**
	 * Sets the new password a reset link was for. Every sign-in and token of
	 * the person ends; they then sign in as usual, two-step code included.
	 */
	async usePasswordReset(token: string, password: string): Promise<void> {
		const invalid = () =>
			new AccessError(
				"This link has expired or was already used",
				"resetInvalid",
				403,
			);
		const reset = this.repo.getPasswordReset(hashToken(token));
		if (!reset || reset.usedAt != null || reset.expiresAt < this.now()) {
			throw invalid();
		}
		const user = this.repo.getUser(reset.userId);
		if (!user || user.disabledAt != null) throw invalid();
		const passwordHash = await hashPassword(password);
		if (!this.repo.usePasswordReset(reset.id, this.now())) throw invalid();
		this.repo.updateUser(user.id, { passwordHash, mustChangePassword: false });
		this.repo.deleteSessionsOf(user.id);
		this.repo.deleteTokensOf(user.id);
	}

	/** Finds a person by name, for the command line. */
	findUser(username: string): UserRow | null {
		return this.repo.findUser(username);
	}

	getUser(id: string): UserRow | null {
		return this.repo.getUser(id);
	}

	/** A token for programs, shown once. */
	createApiToken(
		userId: string,
		input: {
			name: string;
			scopes?: string[];
			spendLimitUsd?: number | null;
			expiresAt?: number | null;
		},
	): string {
		this.mustGet(userId);
		const token = newToken();
		this.repo.createToken({
			id: hashToken(token),
			userId,
			name: input.name,
			scopes: input.scopes ?? [],
			spendLimitUsd: input.spendLimitUsd ?? null,
			createdAt: this.now(),
			lastUsedAt: null,
			expiresAt: input.expiresAt ?? null,
		});
		return token;
	}

	/** Writes down who added a LoRA, for their quota. */
	recordLoraUpload(userId: string, loraId: string, sizeBytes: number): void {
		this.repo.recordLoraUpload({
			loraId,
			userId,
			sizeBytes,
			createdAt: this.now(),
		});
	}

	/**
	 * The LoRAs a person added that are still there (`existing`), and their
	 * size in all.
	 */
	loraUsage(
		userId: string,
		existing: Set<string>,
	): { files: number; bytes: number } {
		const mine = this.repo
			.loraUploadsOf(userId)
			.filter((upload) => existing.has(upload.loraId));
		return {
			files: mine.length,
			bytes: mine.reduce((sum, upload) => sum + upload.sizeBytes, 0),
		};
	}

	forgetLoraUpload(loraId: string): void {
		this.repo.forgetLoraUpload(loraId);
	}

	/** What a person spent on paid models this calendar month (UTC). */
	spentThisMonth(userId: string): number {
		const now = new Date(this.now());
		return this.repo.spentSince(
			userId,
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		);
	}

	private mustGet(id: string): UserRow {
		const user = this.repo.getUser(id);
		if (!user) throw new NotFoundError("User not found");
		return user;
	}

	/** Admins run the server for its owners: they cannot change an owner. */
	/**
	 * Owners manage anyone. Admins manage members only: not themselves, not
	 * other admins, not owners. Members manage nobody.
	 */
	private assertMayManage(actor: UserRow, user: UserRow): void {
		if (actor.role === "owner") return;
		if (
			actor.role === "admin" &&
			user.role === "member" &&
			user.id !== actor.id
		) {
			return;
		}
		throw new AccessError(
			"Only an owner can change this account",
			"forbidden",
			403,
		);
	}

	/** Owners make anyone; admins make members only. */
	private assertMayGrant(actor: UserRow, role: UserRole): void {
		if (!USER_ROLES.includes(role)) {
			throw new ValidationError(`Unknown role: ${role}`);
		}
		if (actor.role === "owner") return;
		if (actor.role === "admin" && role === "member") return;
		throw new AccessError(
			"Only an owner can make admins and owners",
			"forbidden",
			403,
		);
	}

	private async newUser(
		username: string,
		password: string,
		terms: InviteTerms,
	): Promise<UserRow> {
		const name = username.trim().toLowerCase();
		if (!USERNAME.test(name)) {
			throw new ValidationError(
				"A username is 3 to 32 letters a to z, digits, dots, dashes or underscores",
				"usernameInvalid",
			);
		}
		if (this.repo.findUser(name)) {
			throw new ValidationError("That username is taken", "usernameTaken");
		}
		return {
			id: newId("usr"),
			username: name,
			displayName: name,
			passwordHash: await hashPassword(password),
			role: terms.role,
			canUsePaid: terms.canUsePaid,
			canTrain: terms.canTrain,
			monthlyLimitUsd: terms.monthlyLimitUsd,
			totpSecret: null,
			totpLastCounter: null,
			mustChangePassword: false,
			disabledAt: null,
			createdAt: this.now(),
		};
	}
}

function displayName(value: string, fallback: string): string {
	return value.trim().slice(0, 64) || fallback;
}

/** Argon2id, after checking the password is long enough. */
export async function hashPassword(password: string): Promise<string> {
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new ValidationError(
			`A password needs at least ${MIN_PASSWORD_LENGTH} characters`,
			"passwordTooShort",
			{ min: MIN_PASSWORD_LENGTH },
		);
	}
	if (password.length > MAX_PASSWORD_LENGTH) {
		throw new ValidationError("That password is too long");
	}
	return hashing(() => Bun.password.hash(password, { algorithm: "argon2id" }));
}

function inviteView(row: InviteRow): InviteView {
	return {
		id: row.id,
		role: row.role,
		canUsePaid: row.canUsePaid,
		canTrain: row.canTrain,
		monthlyLimitUsd: row.monthlyLimitUsd,
		expiresAt: row.expiresAt,
		createdAt: row.createdAt,
		usedAt: row.usedAt,
	};
}
