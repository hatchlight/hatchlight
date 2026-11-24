import type { Database } from "bun:sqlite";
import { and, asc, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { LOCAL_USER } from "../types";
import * as schema from "./schema";

export type UserRow = typeof schema.users.$inferSelect;
export type AuthSessionRow = typeof schema.authSessions.$inferSelect;
export type InviteRow = typeof schema.invites.$inferSelect;
export type ApiTokenRow = typeof schema.apiTokens.$inferSelect;

export type UserPatch = Partial<
	Pick<
		UserRow,
		| "displayName"
		| "passwordHash"
		| "role"
		| "canUsePaid"
		| "canTrain"
		| "monthlyLimitUsd"
		| "totpSecret"
		| "mustChangePassword"
		| "disabledAt"
	>
>;

/** The accounts of a server, in the same database as what they make. */
export class SqliteAccounts {
	private db;

	/** `sqlite` must already be migrated. */
	constructor(private sqlite: Database) {
		this.db = drizzle(sqlite, { schema });
	}

	countUsers(): number {
		return (
			this.db.select({ n: sql<number>`count(*)` }).from(schema.users).get()
				?.n ?? 0
		);
	}

	/** Owners who can still sign in. */
	countActiveOwners(): number {
		return (
			this.db
				.select({ n: sql<number>`count(*)` })
				.from(schema.users)
				.where(
					and(eq(schema.users.role, "owner"), isNull(schema.users.disabledAt)),
				)
				.get()?.n ?? 0
		);
	}

	createUser(user: UserRow): void {
		this.db.insert(schema.users).values(user).run();
	}

	getUser(id: string): UserRow | null {
		return (
			this.db
				.select()
				.from(schema.users)
				.where(eq(schema.users.id, id))
				.get() ?? null
		);
	}

	/** Usernames are compared without case: "Ana" and "ana" are one. */
	findUser(username: string): UserRow | null {
		return (
			this.db
				.select()
				.from(schema.users)
				.where(sql`lower(${schema.users.username}) = lower(${username})`)
				.get() ?? null
		);
	}

	listUsers(): UserRow[] {
		return this.db
			.select()
			.from(schema.users)
			.orderBy(asc(schema.users.createdAt))
			.all();
	}

	updateUser(id: string, patch: UserPatch): void {
		this.db
			.update(schema.users)
			.set(patch)
			.where(eq(schema.users.id, id))
			.run();
	}

	createSession(session: AuthSessionRow): void {
		this.db.insert(schema.authSessions).values(session).run();
	}

	getSession(id: string): AuthSessionRow | null {
		return (
			this.db
				.select()
				.from(schema.authSessions)
				.where(eq(schema.authSessions.id, id))
				.get() ?? null
		);
	}

	touchSession(id: string, lastSeenAt: number, expiresAt: number): void {
		this.db
			.update(schema.authSessions)
			.set({ lastSeenAt, expiresAt })
			.where(eq(schema.authSessions.id, id))
			.run();
	}

	listSessions(userId: string, now: number): AuthSessionRow[] {
		return this.db
			.select()
			.from(schema.authSessions)
			.where(
				and(
					eq(schema.authSessions.userId, userId),
					gte(schema.authSessions.expiresAt, now),
				),
			)
			.orderBy(sql`${schema.authSessions.lastSeenAt} desc`)
			.all();
	}

	deleteSession(userId: string, id: string): boolean {
		return (
			this.sqlite
				.prepare("delete from auth_sessions where id = ? and user_id = ?")
				.run(id, userId).changes > 0
		);
	}

	/** Signs a person out everywhere, or everywhere but `keep`. */
	deleteSessionsOf(userId: string, keep?: string): void {
		this.db
			.delete(schema.authSessions)
			.where(
				and(
					eq(schema.authSessions.userId, userId),
					keep ? ne(schema.authSessions.id, keep) : undefined,
				),
			)
			.run();
	}

	createInvite(invite: InviteRow): void {
		this.db.insert(schema.invites).values(invite).run();
	}

	getInvite(id: string): InviteRow | null {
		return (
			this.db
				.select()
				.from(schema.invites)
				.where(eq(schema.invites.id, id))
				.get() ?? null
		);
	}

	listInvites(): InviteRow[] {
		return this.db
			.select()
			.from(schema.invites)
			.orderBy(sql`${schema.invites.createdAt} desc`)
			.all();
	}

	deleteInvite(id: string): boolean {
		return (
			this.sqlite.prepare("delete from invites where id = ?").run(id).changes >
			0
		);
	}

	/**
	 * Makes the account an invite was for, once: false when the invite was
	 * already used, which a second person accepting at once would find.
	 */
	acceptInvite(id: string, user: UserRow): boolean {
		return this.sqlite.transaction(() => {
			const used = this.sqlite
				.prepare(
					"update invites set used_at = ? where id = ? and used_at is null",
				)
				.run(user.createdAt, id);
			if (used.changes === 0) return false;
			this.db.insert(schema.users).values(user).run();
			this.db
				.update(schema.invites)
				.set({ usedBy: user.id })
				.where(eq(schema.invites.id, id))
				.run();
			return true;
		})();
	}

	createToken(token: ApiTokenRow): void {
		this.db.insert(schema.apiTokens).values(token).run();
	}

	getToken(id: string): ApiTokenRow | null {
		return (
			this.db
				.select()
				.from(schema.apiTokens)
				.where(eq(schema.apiTokens.id, id))
				.get() ?? null
		);
	}

	touchToken(id: string, lastUsedAt: number): void {
		this.db
			.update(schema.apiTokens)
			.set({ lastUsedAt })
			.where(eq(schema.apiTokens.id, id))
			.run();
	}

	/**
	 * Makes the first owner and gives them everything made before there were
	 * accounts, in one go.
	 */
	createFirstOwner(user: UserRow): boolean {
		return this.db.transaction((tx) => {
			const existing = tx
				.select({ n: sql<number>`count(*)` })
				.from(schema.users)
				.get();
			if ((existing?.n ?? 0) > 0) return false;
			tx.insert(schema.users).values(user).run();
			for (const table of [
				schema.sessions,
				schema.turns,
				schema.jobs,
				schema.assets,
				schema.messages,
			]) {
				tx.update(table)
					.set({ userId: user.id })
					.where(eq(table.userId, LOCAL_USER.userId))
					.run();
			}
			return true;
		});
	}

	/** What a person spent on paid models since `since`, in dollars. */
	spentSince(userId: string, since: number): number {
		return (
			this.db
				.select({
					total: sql<number>`coalesce(sum(${schema.jobs.costUsd}), 0)`,
				})
				.from(schema.jobs)
				.where(
					and(
						eq(schema.jobs.userId, userId),
						gte(schema.jobs.createdAt, since),
					),
				)
				.get()?.total ?? 0
		);
	}
}
