import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ErrorParams } from "../errors";
import type {
	AssetKind,
	AssistantEntryBody,
	GenerationParams,
	JobStatus,
	SpendingKind,
	UserRole,
} from "../types";

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		title: text("title").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => [index("sessions_user_updated").on(t.userId, t.updatedAt)],
);

export const turns = sqliteTable(
	"turns",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		prompt: text("prompt").notNull(),
		referenceAssetIds: text("reference_asset_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [index("turns_session_created").on(t.sessionId, t.createdAt)],
);

export const jobs = sqliteTable(
	"jobs",
	{
		id: text("id").primaryKey(),
		turnId: text("turn_id")
			.notNull()
			.references(() => turns.id, { onDelete: "cascade" }),
		position: integer("position").notNull(),
		userId: text("user_id").notNull(),
		providerId: text("provider_id").notNull(),
		modelId: text("model_id").notNull(),
		params: text("params", { mode: "json" })
			.$type<GenerationParams>()
			.notNull(),
		status: text("status").$type<JobStatus>().notNull(),
		handle: text("handle", { mode: "json" }).$type<unknown>(),
		error: text("error"),
		errorCode: text("error_code"),
		errorParams: text("error_params", { mode: "json" }).$type<ErrorParams>(),
		costUsd: real("cost_usd"),
		createdAt: integer("created_at").notNull(),
		startedAt: integer("started_at"),
		finishedAt: integer("finished_at"),
	},
	(t) => [index("jobs_turn").on(t.turnId), index("jobs_status").on(t.status)],
);

export const assets = sqliteTable(
	"assets",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		// Kept when the job is deleted so the gallery outlives its session.
		jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
		kind: text("kind").$type<AssetKind>().notNull(),
		hash: text("hash").notNull(),
		mime: text("mime").notNull(),
		size: integer("size").notNull(),
		prompt: text("prompt"),
		modelId: text("model_id"),
		params: text("params", { mode: "json" }).$type<GenerationParams>(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [
		index("assets_user_kind_created").on(t.userId, t.kind, t.createdAt),
		index("assets_job").on(t.jobId),
	],
);

/** What a person and the assistant said in a session, in order. */
export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		body: text("body", { mode: "json" }).$type<AssistantEntryBody>().notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [index("messages_session_created").on(t.sessionId, t.createdAt)],
);

/** People who may use a server. A personal install has none. */
export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(),
		username: text("username").notNull(),
		displayName: text("display_name").notNull(),
		passwordHash: text("password_hash").notNull(),
		role: text("role").$type<UserRole>().notNull(),
		canUsePaid: integer("can_use_paid", { mode: "boolean" }).notNull(),
		canTrain: integer("can_train", { mode: "boolean" }).notNull(),
		monthlyLimitUsd: real("monthly_limit_usd"),
		totpSecret: text("totp_secret"),
		/** The last two-step code's time step, which cannot be used again. */
		totpLastCounter: integer("totp_last_counter"),
		/** Set by a reset: the next sign-in must choose a new password. */
		mustChangePassword: integer("must_change_password", { mode: "boolean" })
			.notNull()
			.default(false),
		disabledAt: integer("disabled_at"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [uniqueIndex("users_username").on(sql`lower(${t.username})`)],
);

/** Signed-in browsers. The id is the SHA-256 of the cookie's token. */
export const authSessions = sqliteTable(
	"auth_sessions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: integer("created_at").notNull(),
		lastSeenAt: integer("last_seen_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
		userAgent: text("user_agent"),
		ip: text("ip"),
	},
	(t) => [index("auth_sessions_user").on(t.userId)],
);

/** Links that let someone make an account. The id is the token's SHA-256. */
export const invites = sqliteTable("invites", {
	id: text("id").primaryKey(),
	role: text("role").$type<UserRole>().notNull(),
	canUsePaid: integer("can_use_paid", { mode: "boolean" }).notNull(),
	canTrain: integer("can_train", { mode: "boolean" }).notNull(),
	monthlyLimitUsd: real("monthly_limit_usd"),
	expiresAt: integer("expires_at").notNull(),
	createdBy: text("created_by")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	createdAt: integer("created_at").notNull(),
	usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
	usedAt: integer("used_at"),
});

/** Tokens programs use instead of a browser session. The id is the SHA-256. */
export const apiTokens = sqliteTable(
	"api_tokens",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
		spendLimitUsd: real("spend_limit_usd"),
		createdAt: integer("created_at").notNull(),
		lastUsedAt: integer("last_used_at"),
		expiresAt: integer("expires_at"),
	},
	(t) => [index("api_tokens_user").on(t.userId)],
);

/**
 * What each person spent on paid services, one row per charge. Only added
 * to: deleting a session or a job leaves what it cost, so monthly limits
 * count everything.
 */
export const spending = sqliteTable(
	"spending",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		/** `generation` for pictures and videos; `language` for text models. */
		kind: text("kind").$type<SpendingKind>().notNull(),
		/** The job it paid for, if any; no foreign key, so it outlives the job. */
		jobId: text("job_id"),
		costUsd: real("cost_usd").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [index("spending_user_created").on(t.userId, t.createdAt)],
);

/**
 * Links that let someone choose a new password, given by an admin or owner.
 * The id is the token's SHA-256.
 */
export const passwordResets = sqliteTable("password_resets", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	createdBy: text("created_by")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	createdAt: integer("created_at").notNull(),
	expiresAt: integer("expires_at").notNull(),
	usedAt: integer("used_at"),
});

/** Who added which LoRA on a server, to hold each person to a quota. */
export const loraUploads = sqliteTable(
	"lora_uploads",
	{
		loraId: text("lora_id").primaryKey(),
		userId: text("user_id").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [index("lora_uploads_user").on(t.userId)],
);
