import type { Database } from "bun:sqlite";
import { and, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type VisitorRow = typeof schema.visitors.$inferSelect;

/** What a visitor's id starts with: nothing else in the database does. */
export const VISITOR_PREFIX = "vis_";

/** Escapes `%`, `_` and `\` for a LIKE pattern written with `escape '\'`. */
const literal = (text: string) => text.replace(/[%_\\]/g, "\\$&");

/**
 * The anonymous visitors of a public demo, and what of theirs is old enough
 * to go. Only ids starting with VISITOR_PREFIX are ever touched.
 */
export class SqliteVisitors {
	private db;

	/** `sqlite` must already be migrated. */
	constructor(sqlite: Database) {
		this.db = drizzle(sqlite, { schema });
	}

	create(row: VisitorRow): void {
		if (!row.userId.startsWith(VISITOR_PREFIX)) {
			throw new Error("A visitor's id must start with vis_");
		}
		this.db.insert(schema.visitors).values(row).run();
	}

	/** The visitor a token's hash names, or null. */
	find(id: string): VisitorRow | null {
		return (
			this.db
				.select()
				.from(schema.visitors)
				.where(eq(schema.visitors.id, id))
				.get() ?? null
		);
	}

	touch(id: string, at: number): void {
		this.db
			.update(schema.visitors)
			.set({ lastSeenAt: at })
			.where(eq(schema.visitors.id, id))
			.run();
	}

	/** Forgets visitors not seen since `before`; returns whose they were. */
	forgetIdle(before: number): string[] {
		return this.db
			.delete(schema.visitors)
			.where(lt(schema.visitors.lastSeenAt, before))
			.returning({ userId: schema.visitors.userId })
			.all()
			.map((row) => row.userId);
	}

	/** Whether a visitor is still known. */
	known(userId: string): boolean {
		return (
			this.db
				.select({ id: schema.visitors.id })
				.from(schema.visitors)
				.where(eq(schema.visitors.userId, userId))
				.get() !== undefined
		);
	}

	/** Visitors' sessions not changed since `before`. */
	staleSessions(before: number): { id: string; userId: string }[] {
		const { sessions } = schema;
		return this.db
			.select({ id: sessions.id, userId: sessions.userId })
			.from(sessions)
			.where(
				and(
					sql`${sessions.userId} like ${`${literal(VISITOR_PREFIX)}%`} escape '\\'`,
					lt(sessions.updatedAt, before),
				),
			)
			.all();
	}

	/** Visitors' pictures and videos made before `before`. */
	staleAssets(before: number): { id: string; userId: string }[] {
		const { assets } = schema;
		return this.db
			.select({ id: assets.id, userId: assets.userId })
			.from(assets)
			.where(
				and(
					sql`${assets.userId} like ${`${literal(VISITOR_PREFIX)}%`} escape '\\'`,
					lt(assets.createdAt, before),
				),
			)
			.all();
	}

	/** Whether a visitor has any picture or video left. */
	hasAssets(userId: string): boolean {
		return (
			this.db
				.select({ id: schema.assets.id })
				.from(schema.assets)
				.where(eq(schema.assets.userId, userId))
				.get() !== undefined
		);
	}
}
