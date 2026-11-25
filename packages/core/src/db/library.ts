import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { LibraryEntry, UserContext } from "../types";
import * as schema from "./schema";

type Row = typeof schema.library.$inferSelect;

/** How names are told apart: by their letters, whatever their case. */
export const nameKey = (name: string) => name.trim().toLowerCase();

const entryOf = (row: Row): LibraryEntry => ({
	...row.data,
	id: row.id,
	kind: row.kind,
	name: row.name,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const rowOf = (userId: string, entry: LibraryEntry): Row => {
	const { id, kind, name, createdAt, updatedAt, ...data } = entry;
	return {
		id,
		userId,
		kind,
		name,
		nameKey: nameKey(name),
		data,
		createdAt,
		updatedAt,
	};
};

/** Each person's characters and styles, kept in the same database. */
export class SqliteLibrary {
	private db;

	/** `sqlite` must already be migrated. */
	constructor(sqlite: Database) {
		this.db = drizzle(sqlite, { schema });
	}

	list(ctx: UserContext): LibraryEntry[] {
		return this.db
			.select()
			.from(schema.library)
			.where(eq(schema.library.userId, ctx.userId))
			.orderBy(asc(schema.library.kind), asc(schema.library.nameKey))
			.all()
			.map(entryOf);
	}

	get(ctx: UserContext, id: string): LibraryEntry | null {
		const row = this.db
			.select()
			.from(schema.library)
			.where(
				and(eq(schema.library.id, id), eq(schema.library.userId, ctx.userId)),
			)
			.get();
		return row ? entryOf(row) : null;
	}

	/** The person's entry of this kind with this name, whatever its case. */
	findByName(
		ctx: UserContext,
		kind: LibraryEntry["kind"],
		name: string,
	): LibraryEntry | null {
		const row = this.db
			.select()
			.from(schema.library)
			.where(
				and(
					eq(schema.library.userId, ctx.userId),
					eq(schema.library.kind, kind),
					eq(schema.library.nameKey, nameKey(name)),
				),
			)
			.get();
		return row ? entryOf(row) : null;
	}

	/** Adds an entry, or replaces the one with its id. */
	put(ctx: UserContext, entry: LibraryEntry): void {
		const row = rowOf(ctx.userId, entry);
		this.db
			.insert(schema.library)
			.values(row)
			.onConflictDoUpdate({
				target: schema.library.id,
				set: {
					name: row.name,
					nameKey: row.nameKey,
					data: row.data,
					updatedAt: row.updatedAt,
				},
				setWhere: eq(schema.library.userId, ctx.userId),
			})
			.run();
	}

	delete(ctx: UserContext, id: string): boolean {
		const gone = this.db
			.delete(schema.library)
			.where(
				and(eq(schema.library.id, id), eq(schema.library.userId, ctx.userId)),
			)
			.returning({ id: schema.library.id })
			.all();
		return gone.length > 0;
	}
}
