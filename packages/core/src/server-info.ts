import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { legacyName } from "./legacy";

/** Where a running Hatchlight can be reached, for other processes to find. */
export interface ServerInfo {
	pid: number;
	url: string;
}

/** The file a running server writes in its data directory. */
export const serverInfoFile = (dataDir: string) =>
	join(dataDir, "hatchlight.server.json");

/** The same file under the old name, where versions before the rename look. */
export const legacyServerInfoFile = (dataDir: string) =>
	join(dataDir, legacyName(basename(serverInfoFile(dataDir))));

/**
 * Says where this server listens, once it owns the data directory: under
 * both names, so an agent set up before the rename uses this server rather
 * than starting another.
 */
export async function writeServerInfo(
	dataDir: string,
	info: ServerInfo,
): Promise<void> {
	for (const file of [serverInfoFile(dataDir), legacyServerInfoFile(dataDir)]) {
		// Whole or not at all: a reader never sees half of it.
		const tmp = `${file}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(info));
		await rename(tmp, file);
	}
}

/** Removes what `writeServerInfo` wrote, if it is still this process's. */
export async function clearServerInfo(dataDir: string): Promise<void> {
	for (const file of [serverInfoFile(dataDir), legacyServerInfoFile(dataDir)]) {
		const info = await readInfo(file, () => true);
		if (info?.pid === process.pid) await rm(file, { force: true });
	}
}

const running = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// The process is there, only not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/**
 * The server running on a data directory, or null when none is. A server
 * from before the rename says so under the old name, and is found too.
 */
export async function readServerInfo(
	dataDir: string,
	alive: (pid: number) => boolean = running,
): Promise<ServerInfo | null> {
	return (
		(await readInfo(serverInfoFile(dataDir), alive)) ??
		(await readInfo(legacyServerInfoFile(dataDir), alive))
	);
}

async function readInfo(
	file: string,
	alive: (pid: number) => boolean,
): Promise<ServerInfo | null> {
	try {
		const info = JSON.parse(
			await readFile(file, "utf8"),
		) as Partial<ServerInfo>;
		if (
			typeof info.pid !== "number" ||
			typeof info.url !== "string" ||
			// Only loopback: a server reached over the network is not
			// found on its own, nor would it let an agent in without a token.
			!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(info.url)
		) {
			return null;
		}
		return alive(info.pid) ? { pid: info.pid, url: info.url } : null;
	} catch {
		return null;
	}
}
