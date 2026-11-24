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
