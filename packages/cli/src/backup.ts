import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	appEnv,
	createTarGz,
	defaultDataDir,
	extractTarGz,
	formatBytes,
	listTarGz,
	plainPath,
	type TarEntry,
	type TarSource,
} from "@hatchlight/core";
import {
	DataDirInUseError,
	databaseFile,
	lockDataDir,
} from "@hatchlight/server";

/** Written first in every backup: what it is, and when it was made. */
const MANIFEST = "hatchlight-backup.json";
/** The database, under its current name whatever it was called before. */
const DATABASE = "hatchlight.sqlite";
/** Files of the data directory a backup holds, besides the database. */
const FILES = ["settings.json", "auth.json", "secret.key", "device.key"];
const ASSETS = "assets";
/** What a restore replaces, the old database names included. */
const REPLACED = [
	DATABASE,
	`${DATABASE}-wal`,
	`${DATABASE}-shm`,
	"open-reel.sqlite",
	"open-reel.sqlite-wal",
	"open-reel.sqlite-shm",
	ASSETS,
	...FILES,
];

const BACKUP_HELP = `hatchlight backup — save a server's data in one file

Usage: hatchlight backup <file.tar.gz> [options]

Saves a consistent copy of the database, the pictures and videos (assets),
settings.json, auth.json (saved API keys), and secret.key and device.key
when they are there. It works while the server runs. Models are not saved:
they download again. The file holds API keys and the secret that opens
them: keep it as safe as the server.

Options:
  --data-dir <p>   The data directory (default ${defaultDataDir()})
  -h, --help       Show this help
`;

const RESTORE_HELP = `hatchlight restore — put a backup back

Usage: hatchlight restore <file.tar.gz> [options]

Replaces the database, assets and settings of the data directory with the
backup's. What was there is moved to before-restore-<time>/ in the data
directory, not deleted. The server must be stopped first.

Options:
  --data-dir <p>   The data directory (default ${defaultDataDir()})
  --dry-run        Only say what the backup holds and what would change
  -h, --help       Show this help
`;

/** Every file under `dir`, as paths relative to it with `/`. */
async function filesUnder(dir: string, prefix: string): Promise<TarSource[]> {
	const found: TarSource[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(
		() => [],
	)) {
		const source = join(dir, entry.name);
		const name = `${prefix}/${entry.name}`;
		if (entry.isDirectory()) found.push(...(await filesUnder(source, name)));
		else if (entry.isFile()) found.push({ name, source });
	}
	return found;
}

/** Runs `hatchlight backup` with its arguments. */
export async function backup(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			"data-dir": { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	const [file] = positionals;
	if (values.help || !file) {
		console.log(BACKUP_HELP);
		return values.help ? 0 : 1;
	}
	const dataDir = resolve(values["data-dir"] ?? defaultDataDir());
	const database = databaseFile(dataDir);
	if (!existsSync(database)) {
		console.error(`No Hatchlight database in ${dataDir}.`);
		return 1;
	}
	const archive = resolve(plainPath(file));
	await mkdir(dirname(archive), { recursive: true });
	// Next to the backup, so the snapshot is on a disk known to have room.
	const staging = await mkdtemp(join(dirname(archive), ".hatchlight-backup-"));
	try {
		const snapshot = join(staging, DATABASE);
		// A running server keeps writing: VACUUM INTO copies one consistent
		// moment, which copying the file and its journal would not.
		const db = new Database(database, { readonly: true });
		try {
			db.run("VACUUM INTO ?", [snapshot]);
		} finally {
			db.close();
		}
		const manifest = join(staging, MANIFEST);
		await writeFile(
			manifest,
			`${JSON.stringify({ format: 1, createdAt: new Date().toISOString() }, null, 2)}\n`,
		);
		const files: TarSource[] = [
			{ name: MANIFEST, source: manifest },
			{ name: DATABASE, source: snapshot },
			...FILES.filter((name) => existsSync(join(dataDir, name))).map(
				(name) => ({ name, source: join(dataDir, name) }),
			),
			...(await filesUnder(join(dataDir, ASSETS), ASSETS)),
		];
		// It holds keys and the secret to them: for its owner's eyes only.
		await createTarGz(archive, files, { mode: 0o600 });
		console.log(`Saved ${files.length - 1} files to ${archive}.`);
		if (appEnv(process.env, "SECRET_FILE")) {
			console.log(
				"The secret for API keys is in HATCHLIGHT_SECRET_FILE, outside the data directory: back it up too.",
			);
		}
		return 0;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** Why a backup cannot be restored, or null when it can. */
function problem(entries: TarEntry[]): string | null {
	const names = new Set(entries.map((entry) => entry.name));
	if (!names.has(MANIFEST)) return "it is not a Hatchlight backup";
	if (!names.has(DATABASE)) return "it holds no database";
	const allowed = new Set([MANIFEST, DATABASE, ASSETS, ...FILES]);
	const stray = entries.find(
		(entry) =>
			entry.type === "link" ||
			!(allowed.has(entry.name) || entry.name.startsWith(`${ASSETS}/`)),
	);
	return stray ? `it holds something unexpected: ${stray.name}` : null;
}

/** Runs `hatchlight restore` with its arguments. */
export async function restore(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			"data-dir": { type: "string" },
			"dry-run": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	const [file] = positionals;
	if (values.help || !file) {
		console.log(RESTORE_HELP);
		return values.help ? 0 : 1;
	}
	const dataDir = resolve(values["data-dir"] ?? defaultDataDir());
	const archive = resolve(plainPath(file));
	let entries: TarEntry[];
	try {
		entries = await listTarGz(archive);
	} catch (error) {
		console.error(
			`Cannot read ${archive}: ${error instanceof Error ? error.message : error}.`,
		);
		return 1;
	}
	const refused = problem(entries);
	if (refused) {
		console.error(`Cannot restore ${archive}: ${refused}.`);
		return 1;
	}

	const assets = entries.filter((entry) => entry.name.startsWith(`${ASSETS}/`));
	const replaced = REPLACED.filter((name) => existsSync(join(dataDir, name)));
	if (values["dry-run"]) {
		console.log(`${archive} holds:`);
		for (const entry of entries) {
			if (entry.name === MANIFEST || entry.name.startsWith(`${ASSETS}/`)) {
				continue;
			}
			console.log(`  ${entry.name}  ${formatBytes(entry.size)}`);
		}
		const assetBytes = assets.reduce((sum, entry) => sum + entry.size, 0);
		console.log(
			`  ${ASSETS}/  ${assets.length} files, ${formatBytes(assetBytes)}`,
		);
		console.log(
			replaced.length > 0
				? `Restoring would move aside, in ${dataDir}: ${replaced.join(", ")}.`
				: `Restoring would fill ${dataDir}, which holds no data yet.`,
		);
		console.log("Nothing was changed.");
		return 0;
	}

	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	let unlock: () => void;
	try {
		// Held while restoring, so no server starts on a half-restored folder.
		unlock = lockDataDir(dataDir);
	} catch (error) {
		if (!(error instanceof DataDirInUseError)) throw error;
		console.error(
			`${error.message}. Stop the server before restoring a backup.`,
		);
		return 1;
	}
	const staging = join(dataDir, `.restore-${crypto.randomUUID()}`);
	try {
		await extractTarGz(archive, staging);
		const aside = join(
			dataDir,
			`before-restore-${new Date().toISOString().replaceAll(":", "-")}`,
		);
		if (replaced.length > 0) await mkdir(aside, { mode: 0o700 });
		for (const name of replaced) {
			await rename(join(dataDir, name), join(aside, name));
		}
		for (const name of await readdir(staging)) {
			if (name === MANIFEST) continue;
			await rename(join(staging, name), join(dataDir, name));
		}
		console.log(`Restored ${entries.length - 1} files into ${dataDir}.`);
		if (replaced.length > 0) console.log(`What was there is in ${aside}.`);
		return 0;
	} finally {
		await rm(staging, { recursive: true, force: true });
		unlock();
	}
}
