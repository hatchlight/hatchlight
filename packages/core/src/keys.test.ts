import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyStore, SERVER_KEYS, SharedKeyStore } from "./keys";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});

async function store() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-keys-"));
	dirs.push(dir);
	return new FileKeyStore(join(dir, "auth.json"));
}

const me = { userId: "local" };

describe("API keys on disk", () => {
	test("are kept, listed and deleted per provider", async () => {
		const keys = await store();
		await keys.set(me, "fal", "k1");
		await keys.set(me, "openai", "k2");
		expect(await keys.get(me, "fal")).toBe("k1");
		expect((await keys.list(me)).sort()).toEqual(["fal", "openai"]);
		await keys.delete(me, "fal");
		expect(await keys.get(me, "fal")).toBeUndefined();
		expect(await keys.list(me)).toEqual(["openai"]);
	});

	test("names that reach an object's prototype never touch it", async () => {
		const keys = await store();
		await keys.set(me, "fal", "k1");
		await expect(keys.set(me, "__proto__", "x")).rejects.toThrow();
		await expect(
			keys.set({ userId: "__proto__" }, "fal", "x"),
		).rejects.toThrow();
		await keys.delete(me, "__proto__");
		await keys.delete({ userId: "__proto__" }, "toString");
		expect(await keys.get(me, "constructor")).toBeUndefined();
		expect(await keys.get({ userId: "__proto__" }, "fal")).toBeUndefined();
		expect(await keys.list({ userId: "constructor" })).toEqual([]);
		expect(typeof Object.prototype.toString).toBe("function");
		expect(await keys.get(me, "fal")).toBe("k1");
	});
});

test("the first owner of a server takes the keys of the install", async () => {
	const keys = await store();
	await keys.set(me, "fal", "fal-key");
	await keys.moveUser("local", SERVER_KEYS.userId);
	expect(await keys.list(me)).toEqual([]);
	expect(await keys.get(SERVER_KEYS, "fal")).toBe("fal-key");
	// Nothing to move is fine.
	await keys.moveUser("local", SERVER_KEYS.userId);
});

test("a server's keys serve only those allowed to spend", async () => {
	const inner = await store();
	const shared = new SharedKeyStore(inner, (userId) => userId === "usr_paid");
	await shared.set({ userId: "usr_owner" }, "fal", "fal-key");
	expect(await shared.get({ userId: "usr_paid" }, "fal")).toBe("fal-key");
	expect(await shared.list({ userId: "usr_paid" })).toEqual(["fal"]);
	expect(await shared.get({ userId: "usr_free" }, "fal")).toBeUndefined();
	expect(await shared.list({ userId: "usr_free" })).toEqual([]);
	await shared.delete({ userId: "usr_owner" }, "fal");
	expect(await inner.list(SERVER_KEYS)).toEqual([]);
});
