import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAssetStore } from "./assets";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

test("a server's first owner takes the files of the install", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-assets-"));
	dirs.push(dir);
	const store = new FsAssetStore(dir);
	const local = { userId: "local" };
	const owner = { userId: "usr_1" };
	const one = await store.put(local, new Uint8Array([1]));
	await store.moveUser("local", owner.userId);
	expect(await store.get(owner, one.hash)).not.toBeNull();
	expect(await store.get(local, one.hash)).toBeNull();

	// Into a folder that already has files, they are merged.
	const two = await store.put(local, new Uint8Array([2]));
	await store.moveUser("local", owner.userId);
	expect(await store.get(owner, one.hash)).not.toBeNull();
	expect(await store.get(owner, two.hash)).not.toBeNull();
	// Nothing to move is fine.
	await store.moveUser("local", owner.userId);
});
