import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../types";
import { MIGRATIONS_DIR, SqliteRepository } from "./repository";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

test("what jobs cost before the ledger is carried into it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-spending-"));
	dirs.push(dir);
	// The migrations as they were before the ledger.
	const before = join(dir, "drizzle");
	await cp(MIGRATIONS_DIR, before, { recursive: true });
	const journal = Bun.file(join(before, "meta", "_journal.json"));
	const entries = await journal.json();
	entries.entries = entries.entries.filter(
		(e: { tag: string }) => e.tag < "0004",
	);
	await Bun.write(journal, JSON.stringify(entries));

	const path = join(dir, "db.sqlite");
	const old = new SqliteRepository(path, before);
	await old.createSession({
		id: "ses_1",
		userId: "usr_1",
		title: "t",
		createdAt: 1,
		updatedAt: 1,
	});
	const job = (id: string, costUsd: number | null) => ({
		id,
		turnId: "trn_1",
		position: 0,
		userId: "usr_1",
		providerId: "paid",
		modelId: "paid/alpha",
		params: { prompt: "x" } as Job["params"],
		status: "succeeded" as const,
		handle: null,
		error: null,
		errorCode: null,
		errorParams: null,
		costUsd,
		createdAt: 1000,
		startedAt: null,
		finishedAt: 2000,
	});
	await old.createTurn(
		{
			id: "trn_1",
			sessionId: "ses_1",
			userId: "usr_1",
			prompt: "x",
			referenceAssetIds: [],
			createdAt: 1,
		},
		[job("job_1", 0.25), job("job_2", null)],
	);
	old.close();

	const repo = new SqliteRepository(path);
	expect(repo.accounts().spentSince("usr_1", 0)).toBeCloseTo(0.25);
	// Deleting the session leaves what it cost.
	await repo.deleteSession({ userId: "usr_1" }, "ses_1");
	expect(repo.accounts().spentSince("usr_1", 0)).toBeCloseTo(0.25);
	repo.close();
});

test("what pictures take already is counted when usage starts being kept", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-usage-"));
	dirs.push(dir);
	const before = join(dir, "drizzle");
	await cp(MIGRATIONS_DIR, before, { recursive: true });
	const journal = Bun.file(join(before, "meta", "_journal.json"));
	const entries = await journal.json();
	entries.entries = entries.entries.filter(
		(e: { tag: string }) => e.tag < "0009",
	);
	await Bun.write(journal, JSON.stringify(entries));
	const path = join(dir, "db.sqlite");
	const old = new SqliteRepository(path, before);
	const asset = (id: string, userId: string, hash: string, size: number) =>
		old.createAsset({
			id,
			userId,
			kind: "upload",
			jobId: null,
			hash,
			mime: "image/png",
			size,
			prompt: null,
			modelId: null,
			params: null,
			createdAt: 1,
		});
	// The same file twice is on disk once.
	await asset("ast_1", "usr_1", "a".repeat(64), 100);
	await asset("ast_2", "usr_1", "a".repeat(64), 100);
	await asset("ast_3", "usr_1", "b".repeat(64), 50);
	await asset("ast_4", "usr_2", "a".repeat(64), 100);
	old.close();
	const repo = new SqliteRepository(path);
	expect(repo.accounts().assetBytes("usr_1")).toBe(150);
	expect(repo.accounts().assetBytes("usr_2")).toBe(100);
	expect(repo.accounts().assetBytes("usr_3")).toBe(0);
	repo.close();
});
