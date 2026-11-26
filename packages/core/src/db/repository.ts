import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	lt,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { PickedTurn } from "../ranking";
import {
	type Asset,
	type AssistantEntry,
	type AssistantEntryBody,
	type GalleryItem,
	type Job,
	type JobView,
	type Session,
	TERMINAL_STATUSES,
	type Turn,
	type TurnView,
	type UserContext,
} from "../types";
import { SqliteAccounts } from "./accounts";
import { SqliteLibrary } from "./library";
import * as schema from "./schema";
import { SqliteVisitors } from "./visitors";

export type JobPatch = Partial<
	Pick<
		Job,
		| "status"
		| "handle"
		| "error"
		| "errorCode"
		| "errorParams"
		| "costUsd"
		| "startedAt"
		| "finishedAt"
		| "params"
		| "tokenId"
	>
>;

export type SpendingEntry = typeof schema.spending.$inferInsert;

export interface GalleryQuery {
	query?: string;
	limit: number;
	/** The last item of the previous page; only older items are returned. */
	before?: { createdAt: number; id: string };
}

export interface Repository {
	createSession(session: Session): Promise<void>;
	listSessions(ctx: UserContext): Promise<Session[]>;
	getSession(ctx: UserContext, id: string): Promise<Session | null>;
	deleteSession(ctx: UserContext, id: string): Promise<void>;
	/** Stores a turn with its jobs and bumps the session's `updatedAt`. */
	createTurn(turn: Turn, jobs: Job[]): Promise<void>;
	listTurns(ctx: UserContext, sessionId: string): Promise<TurnView[]>;
	getTurn(ctx: UserContext, id: string): Promise<TurnView | null>;
	/** Keeps the person's best result of a turn; null forgets it. */
	setPick(
		ctx: UserContext,
		turnId: string,
		pick: { assetId: string; modelId: string } | null,
	): Promise<void>;
	/** The person's turns with a pick, made since `since` when given. */
	listPickedTurns(ctx: UserContext, since?: number): Promise<PickedTurn[]>;
	createAsset(asset: Asset): Promise<void>;
	getAssets(ctx: UserContext, ids: string[]): Promise<Asset[]>;
	/** Deletes a person's asset; says how many of theirs still share its file. */
	deleteAsset(ctx: UserContext, id: string): Promise<{ sharing: number }>;
	listGallery(ctx: UserContext, query: GalleryQuery): Promise<GalleryItem[]>;

	addEntry(entry: AssistantEntry, userId: string): Promise<void>;
	updateEntry(
		ctx: UserContext,
		id: string,
		body: AssistantEntryBody,
	): Promise<void>;
	listEntries(ctx: UserContext, sessionId: string): Promise<AssistantEntry[]>;

	/** Writes down a charge, which nothing removes. */
	addSpending(entry: SpendingEntry): Promise<void>;
	/** A held charge becomes what it cost; nothing cost, it goes. */
	settleSpending(id: string, costUsd: number): Promise<void>;
	/** A held charge for what did not happen goes. */
	releaseSpending(id: string): Promise<void>;
	/** Every held charge goes: at start, nothing is under way. */
	releasePendingSpending(): Promise<void>;

	// Used by the job engine, which acts across users.
	findJob(id: string): Promise<JobView | null>;
	updateJob(id: string, patch: JobPatch): Promise<void>;
	listUnfinishedJobs(): Promise<Job[]>;
}

/** Where the migrations are in the source tree. A packaged app passes its own. */
export const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "drizzle");

export class SqliteRepository implements Repository {
	private sqlite: Database;
	private db;

	/** `path` may be ":memory:". */
	constructor(path: string, migrationsDir = MIGRATIONS_DIR) {
		this.sqlite = new Database(path, { create: true });
		this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		this.db = drizzle(this.sqlite, { schema });
		migrate(this.db, { migrationsFolder: migrationsDir });
	}

	close(): void {
		this.sqlite.close();
	}

	/** The accounts of a server, kept in the same database. */
	accounts(): SqliteAccounts {
		return new SqliteAccounts(this.sqlite);
	}

	/** Each person's characters and styles, kept in the same database. */
	library(): SqliteLibrary {
		return new SqliteLibrary(this.sqlite);
	}

	/** The visitors of a public demo, kept in the same database. */
	visitors(): SqliteVisitors {
		return new SqliteVisitors(this.sqlite);
	}

	async createSession(session: Session) {
		this.db.insert(schema.sessions).values(session).run();
	}

	async listSessions(ctx: UserContext) {
		return this.db
			.select()
			.from(schema.sessions)
			.where(eq(schema.sessions.userId, ctx.userId))
			.orderBy(desc(schema.sessions.updatedAt))
			.all();
	}

	async getSession(ctx: UserContext, id: string) {
		return (
			this.db
				.select()
				.from(schema.sessions)
				.where(
					and(
						eq(schema.sessions.id, id),
						eq(schema.sessions.userId, ctx.userId),
					),
				)
				.get() ?? null
		);
	}

	async deleteSession(ctx: UserContext, id: string) {
		this.db
			.delete(schema.sessions)
			.where(
				and(eq(schema.sessions.id, id), eq(schema.sessions.userId, ctx.userId)),
			)
			.run();
	}

	async createTurn(turn: Turn, jobs: Job[]) {
		this.db.transaction((tx) => {
			tx.insert(schema.turns).values(turn).run();
			if (jobs.length > 0) tx.insert(schema.jobs).values(jobs).run();
			tx.update(schema.sessions)
				.set({ updatedAt: turn.createdAt })
				.where(eq(schema.sessions.id, turn.sessionId))
				.run();
		});
	}

	async addEntry(entry: AssistantEntry, userId: string) {
		const { id, sessionId, createdAt, ...body } = entry;
		this.db.transaction((tx) => {
			tx.insert(schema.messages)
				.values({ id, sessionId, userId, body, createdAt })
				.run();
			tx.update(schema.sessions)
				.set({ updatedAt: createdAt })
				.where(eq(schema.sessions.id, sessionId))
				.run();
		});
	}

	async updateEntry(ctx: UserContext, id: string, body: AssistantEntryBody) {
		this.db
			.update(schema.messages)
			.set({ body })
			.where(
				and(eq(schema.messages.id, id), eq(schema.messages.userId, ctx.userId)),
			)
			.run();
	}

	async listEntries(ctx: UserContext, sessionId: string) {
		return (
			this.db
				.select()
				.from(schema.messages)
				.where(
					and(
						eq(schema.messages.sessionId, sessionId),
						eq(schema.messages.userId, ctx.userId),
					),
				)
				// In the order written: several can share a millisecond.
				.orderBy(sql`rowid`)
				.all()
				.map(({ id, sessionId, createdAt, body }) => ({
					...body,
					id,
					sessionId,
					createdAt,
				}))
		);
	}

	async listTurns(ctx: UserContext, sessionId: string) {
		const turns = this.db
			.select()
			.from(schema.turns)
			.where(
				and(
					eq(schema.turns.sessionId, sessionId),
					eq(schema.turns.userId, ctx.userId),
				),
			)
			.orderBy(schema.turns.createdAt)
			.all();
		return this.withJobs(turns);
	}

	async getTurn(ctx: UserContext, id: string) {
		const turn = this.db
			.select()
			.from(schema.turns)
			.where(and(eq(schema.turns.id, id), eq(schema.turns.userId, ctx.userId)))
			.get();
		return turn ? (this.withJobs([turn])[0] ?? null) : null;
	}

	async setPick(
		ctx: UserContext,
		turnId: string,
		pick: { assetId: string; modelId: string } | null,
	) {
		const mine = and(
			eq(schema.picks.turnId, turnId),
			eq(schema.picks.userId, ctx.userId),
		);
		if (!pick) {
			this.db.delete(schema.picks).where(mine).run();
			return;
		}
		this.db
			.insert(schema.picks)
			.values({ turnId, userId: ctx.userId, ...pick, createdAt: Date.now() })
			.onConflictDoUpdate({
				target: schema.picks.turnId,
				set: { ...pick, createdAt: Date.now() },
				setWhere: eq(schema.picks.userId, ctx.userId),
			})
			.run();
	}

	async listPickedTurns(ctx: UserContext, since?: number) {
		const rows = this.db
			.select({ turn: schema.turns, pick: schema.picks })
			.from(schema.picks)
			.innerJoin(schema.turns, eq(schema.turns.id, schema.picks.turnId))
			.where(
				and(
					eq(schema.picks.userId, ctx.userId),
					eq(schema.turns.userId, ctx.userId),
					since != null ? gte(schema.turns.createdAt, since) : undefined,
				),
			)
			.orderBy(schema.turns.createdAt)
			.all();
		const views = this.withJobs(rows.map((row) => row.turn));
		return rows.map((row, index) => ({
			turn: views[index] as TurnView,
			assetId: row.pick.assetId,
			modelId: row.pick.modelId,
		}));
	}

	/** Turns with their jobs, their jobs' pictures, and the person's pick. */
	private withJobs(turns: Turn[]): TurnView[] {
		if (turns.length === 0) return [];
		const ids = turns.map((t) => t.id);
		const jobs = this.db
			.select()
			.from(schema.jobs)
			.where(inArray(schema.jobs.turnId, ids))
			.orderBy(schema.jobs.position)
			.all();
		const picks = new Map(
			this.db
				.select()
				.from(schema.picks)
				.where(inArray(schema.picks.turnId, ids))
				.all()
				.map((pick) => [pick.turnId, pick.assetId]),
		);
		const views = this.withAssets(jobs);
		return turns.map((turn) => ({
			...turn,
			jobs: views.filter((job) => job.turnId === turn.id),
			pickedAssetId: picks.get(turn.id) ?? null,
		}));
	}

	private withAssets(jobs: Job[]): JobView[] {
		if (jobs.length === 0) return [];
		const assets = this.db
			.select()
			.from(schema.assets)
			.where(
				inArray(
					schema.assets.jobId,
					jobs.map((j) => j.id),
				),
			)
			.orderBy(schema.assets.createdAt, schema.assets.id)
			.all();
		return jobs.map((job) => ({
			...job,
			assets: assets.filter((a) => a.jobId === job.id),
		}));
	}

	async addSpending(entry: SpendingEntry) {
		this.db.insert(schema.spending).values(entry).run();
	}

	async settleSpending(id: string, costUsd: number) {
		if (costUsd > 0) {
			this.db
				.update(schema.spending)
				.set({ pending: false, costUsd })
				.where(eq(schema.spending.id, id))
				.run();
		} else {
			await this.releaseSpending(id);
		}
	}

	async releaseSpending(id: string) {
		this.db
			.delete(schema.spending)
			.where(and(eq(schema.spending.id, id), eq(schema.spending.pending, true)))
			.run();
	}

	async releasePendingSpending() {
		this.db
			.delete(schema.spending)
			.where(eq(schema.spending.pending, true))
			.run();
	}

	async createAsset(asset: Asset) {
		this.db.insert(schema.assets).values(asset).run();
	}

	async getAssets(ctx: UserContext, ids: string[]) {
		if (ids.length === 0) return [];
		return this.db
			.select()
			.from(schema.assets)
			.where(
				and(
					inArray(schema.assets.id, ids),
					eq(schema.assets.userId, ctx.userId),
				),
			)
			.all();
	}

	async deleteAsset(ctx: UserContext, id: string) {
		return this.db.transaction((tx) => {
			const asset = tx
				.select()
				.from(schema.assets)
				.where(
					and(eq(schema.assets.id, id), eq(schema.assets.userId, ctx.userId)),
				)
				.get();
			if (!asset) return { sharing: 0 };
			tx.delete(schema.assets).where(eq(schema.assets.id, id)).run();
			const left = tx
				.select({ n: sql<number>`count(*)` })
				.from(schema.assets)
				.where(
					and(
						eq(schema.assets.userId, ctx.userId),
						eq(schema.assets.hash, asset.hash),
					),
				)
				.get();
			return { sharing: left?.n ?? 0 };
		});
	}

	async listGallery(ctx: UserContext, q: GalleryQuery) {
		const { assets } = schema;
		const rows = this.db
			.select({
				asset: assets,
				unpicked: sql<number>`exists (
					select 1 from ${schema.jobs} j
					where j.id = ${assets.jobId}
						and (select count(*) from ${schema.jobs} k where k.turn_id = j.turn_id) > 1
						and not exists (select 1 from ${schema.picks} p where p.turn_id = j.turn_id)
				)`,
				sessionId: sql<string | null>`(
					select t.session_id from ${schema.jobs} j
					join ${schema.turns} t on t.id = j.turn_id
					where j.id = ${assets.jobId}
				)`,
			})
			.from(assets)
			.where(
				and(
					eq(assets.userId, ctx.userId),
					eq(assets.kind, "output"),
					q.before
						? or(
								lt(assets.createdAt, q.before.createdAt),
								and(
									eq(assets.createdAt, q.before.createdAt),
									lt(assets.id, q.before.id),
								),
							)
						: undefined,
					q.query
						? sql`${assets.prompt} like ${`%${q.query.replace(/[%_\\]/g, "\\$&")}%`} escape '\\'`
						: undefined,
				),
			)
			.orderBy(desc(assets.createdAt), desc(assets.id))
			.limit(q.limit)
			.all();
		return rows.map((row) => ({
			...row.asset,
			unpicked: row.unpicked === 1,
			sessionId: row.sessionId,
		}));
	}

	async findJob(id: string) {
		const job = this.db
			.select()
			.from(schema.jobs)
			.where(eq(schema.jobs.id, id))
			.get();
		return job ? (this.withAssets([job])[0] ?? null) : null;
	}

	async updateJob(id: string, patch: JobPatch) {
		this.db.update(schema.jobs).set(patch).where(eq(schema.jobs.id, id)).run();
	}

	async listUnfinishedJobs() {
		return this.db
			.select()
			.from(schema.jobs)
			.where(notInArray(schema.jobs.status, [...TERMINAL_STATUSES]))
			.orderBy(schema.jobs.createdAt, schema.jobs.position)
			.all();
	}
}
