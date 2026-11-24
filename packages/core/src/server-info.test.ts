import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_NAME } from "./legacy";
import {
	clearServerInfo,
	legacyServerInfoFile,
	readServerInfo,
	serverInfoFile,
	writeServerInfo,
} from "./server-info";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function dataDir() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-info-"));
	dirs.push(dir);
	return dir;
}

test("a running server is found where it said it listens", async () => {
	const dir = await dataDir();
	expect(await readServerInfo(dir)).toBeNull();
	const info = { pid: process.pid, url: "http://127.0.0.1:4100" };
	await writeServerInfo(dir, info);
	expect(await readServerInfo(dir)).toEqual(info);
	await clearServerInfo(dir);
	expect(await readServerInfo(dir)).toBeNull();
});

test("a server that is gone, or a file that says too much, is not found", async () => {
	const dir = await dataDir();
	await writeServerInfo(dir, { pid: 123, url: "http://127.0.0.1:4100" });
	expect(await readServerInfo(dir, () => false)).toBeNull();
	// Only this machine's loopback: the file is not trusted to point elsewhere.
	await writeServerInfo(dir, { pid: process.pid, url: "http://[::1]:4096" });
	expect((await readServerInfo(dir))?.url).toBe("http://[::1]:4096");
	// A server listening on a network address is not found on its own.
	await writeServerInfo(dir, { pid: process.pid, url: "http://10.0.0.2:4096" });
	expect(await readServerInfo(dir)).toBeNull();
	await writeServerInfo(dir, { pid: process.pid, url: "http://evil.example" });
	expect(await readServerInfo(dir)).toBeNull();
	await writeFile(serverInfoFile(dir), "not json");
	expect(await readServerInfo(dir)).toBeNull();
});

test("a server from before the rename is found under the old name", async () => {
	const dir = await dataDir();
	const old = { pid: process.pid + 1, url: "http://127.0.0.1:4096" };
	await writeFile(join(dir, `${LEGACY_NAME}.server.json`), JSON.stringify(old));
	expect(await readServerInfo(dir, () => true)).toEqual(old);
	// Not this process's to remove.
	await clearServerInfo(dir);
	expect(await readServerInfo(dir, () => true)).toEqual(old);
});

test("a server says where it listens under the old name too, for older agents", async () => {
	const dir = await dataDir();
	const legacy = join(dir, `${LEGACY_NAME}.server.json`);
	expect(legacyServerInfoFile(dir)).toBe(legacy);
	const info = { pid: process.pid, url: "http://127.0.0.1:4100" };
	await writeServerInfo(dir, info);
	expect(JSON.parse(await readFile(legacy, "utf8"))).toEqual(info);
	expect(JSON.parse(await readFile(serverInfoFile(dir), "utf8"))).toEqual(info);
	await clearServerInfo(dir);
	expect(await Bun.file(legacy).exists()).toBe(false);
	expect(await Bun.file(serverInfoFile(dir)).exists()).toBe(false);
});

test("only the process that wrote it removes it", async () => {
	const dir = await dataDir();
	const other = { pid: process.pid + 1, url: "http://127.0.0.1:4100" };
	await writeServerInfo(dir, other);
	await clearServerInfo(dir);
	expect(await readServerInfo(dir, () => true)).toEqual(other);
});
