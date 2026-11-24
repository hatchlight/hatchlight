import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTarGz, SqliteRepository } from "@hatchlight/core";
import { lockDataDir } from "@hatchlight/server";
import { backup, restore } from "./backup";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-backup-test-"));
	dirs.push(dir);
	return dir;
}

/** Runs a command, keeping what it printed. */
async function run(
	command: (args: string[]) => Promise<number>,
	args: string[],
) {
	const out: string[] = [];
	const log = spyOn(console, "log").mockImplementation((...line) => {
		out.push(line.join(" "));
	});
	const error = spyOn(console, "error").mockImplementation((...line) => {
		out.push(line.join(" "));
	});
	try {
		return { code: await command(args), out: out.join("\n") };
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
}

/** A data directory with a database in use, keys, settings and pictures. */
async function dataDir() {
	const dir = join(await tempDir(), "data");
	await mkdir(join(dir, "assets", "user-1"), { recursive: true });
	const repo = new SqliteRepository(join(dir, "hatchlight.sqlite"));
	await writeFile(join(dir, "settings.json"), '{"theme":"dark"}');
	await writeFile(join(dir, "auth.json"), '{"fal":"secret"}');
	await writeFile(join(dir, "secret.key"), "a secret");
	await writeFile(join(dir, "assets", "user-1", "picture.png"), "png bytes");
	await writeFile(join(dir, "hatchlight.lock"), "{}");
	return { dir, repo };
}

const tables = (file: string) => {
	const db = new Database(file, { readonly: true });
	try {
		return db
			.query("select name from sqlite_master where type = 'table'")
			.all()
			.map((row) => (row as { name: string }).name)
			.sort();
	} finally {
		db.close();
	}
};

test("a backup taken while the database is open restores into an empty folder", async () => {
	const { dir, repo } = await dataDir();
	const archive = join(await tempDir(), "backups", "hatchlight.tar.gz");
	try {
		const saved = await run(backup, [archive, "--data-dir", dir]);
		expect(saved.code).toBe(0);
	} finally {
		repo.close();
	}
	// It holds keys: only its owner reads it.
	expect((await stat(archive)).mode & 0o777).toBe(0o600);
	expect(await readdir(join(archive, ".."))).toEqual(["hatchlight.tar.gz"]);

	const target = join(await tempDir(), "restored");
	const dry = await run(restore, [archive, "--data-dir", target, "--dry-run"]);
	expect(dry.code).toBe(0);
	expect(dry.out).toContain("hatchlight.sqlite");
	expect(dry.out).toContain("assets/  1 files");
	expect(dry.out).toContain("Nothing was changed.");
	expect(existsSync(target)).toBe(false);

	const restored = await run(restore, [archive, "--data-dir", target]);
	expect(restored.code).toBe(0);
	expect((await readdir(target)).sort()).toEqual([
		"assets",
		"auth.json",
		"hatchlight.sqlite",
		"secret.key",
		"settings.json",
	]);
	expect(tables(join(target, "hatchlight.sqlite"))).toEqual(
		tables(join(dir, "hatchlight.sqlite")),
	);
	expect(
		await Bun.file(join(target, "assets", "user-1", "picture.png")).text(),
	).toBe("png bytes");
	expect(await Bun.file(join(target, "auth.json")).text()).toBe(
		'{"fal":"secret"}',
	);
});

test("restoring moves what was there aside, the old database name included", async () => {
	const { dir, repo } = await dataDir();
	const archive = join(await tempDir(), "backup.tar.gz");
	await run(backup, [archive, "--data-dir", dir]);
	repo.close();

	const target = join(await tempDir(), "data");
	await mkdir(join(target, "assets"), { recursive: true });
	await writeFile(join(target, "open-reel.sqlite"), "older database");
	await writeFile(join(target, "settings.json"), '{"theme":"light"}');
	const restored = await run(restore, [archive, "--data-dir", target]);
	expect(restored.code).toBe(0);
	expect(await Bun.file(join(target, "settings.json")).text()).toBe(
		'{"theme":"dark"}',
	);
	expect(existsSync(join(target, "open-reel.sqlite"))).toBe(false);
	const [aside] = (await readdir(target)).filter((name) =>
		name.startsWith("before-restore-"),
	);
	if (!aside) throw new Error("Nothing was moved aside");
	expect((await readdir(join(target, aside))).sort()).toEqual([
		"assets",
		"open-reel.sqlite",
		"settings.json",
	]);
	// No lock or staging folder is left behind.
	expect(
		(await readdir(target)).filter(
			(name) => name.startsWith(".restore-") || name.endsWith(".lock"),
		),
	).toEqual([]);
});

test("restoring is refused while a server holds the data directory", async () => {
	const { dir, repo } = await dataDir();
	const archive = join(await tempDir(), "backup.tar.gz");
	await run(backup, [archive, "--data-dir", dir]);
	repo.close();

	const target = join(await tempDir(), "data");
	await mkdir(target);
	const unlock = lockDataDir(target);
	try {
		const refused = await run(restore, [archive, "--data-dir", target]);
		expect(refused.code).toBe(1);
		expect(refused.out).toContain("Stop the server before restoring");
		expect(existsSync(join(target, "hatchlight.sqlite"))).toBe(false);
	} finally {
		unlock();
	}
});

test("what is not a Hatchlight backup is refused", async () => {
	const dir = await tempDir();
	const stray = join(dir, "stray.txt");
	await writeFile(stray, "x");
	const target = join(dir, "data");

	const other = join(dir, "other.tar.gz");
	await createTarGz(other, [{ name: "notes.txt", source: stray }]);
	const notBackup = await run(restore, [other, "--data-dir", target]);
	expect(notBackup.code).toBe(1);
	expect(notBackup.out).toContain("not a Hatchlight backup");

	const extra = join(dir, "extra.tar.gz");
	await createTarGz(extra, [
		{ name: "hatchlight-backup.json", source: stray },
		{ name: "hatchlight.sqlite", source: stray },
		{ name: "models/huge.gguf", source: stray },
	]);
	const unexpected = await run(restore, [extra, "--data-dir", target]);
	expect(unexpected.code).toBe(1);
	expect(unexpected.out).toContain("unexpected: models/huge.gguf");

	const broken = join(dir, "broken.tar.gz");
	await writeFile(broken, "not an archive");
	expect((await run(restore, [broken, "--data-dir", target])).code).toBe(1);
	expect(existsSync(target)).toBe(false);
});

test("a folder without a database has nothing to back up", async () => {
	const dir = await tempDir();
	const result = await run(backup, [join(dir, "b.tar.gz"), "--data-dir", dir]);
	expect(result.code).toBe(1);
	expect(result.out).toContain("No Hatchlight database");
});
