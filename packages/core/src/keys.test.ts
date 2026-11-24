import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyStore, SERVER_KEYS, SharedKeyStore } from "./keys";
import { SecretError } from "./secrets";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});

const SECRET = crypto.getRandomValues(new Uint8Array(32));

async function store() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-keys-"));
	dirs.push(dir);
	return new FileKeyStore(join(dir, "auth.json"), SECRET);
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

test("a server's keys serve only those allowed to spend, after their own", async () => {
	const inner = await store();
	const shared = new SharedKeyStore(inner, (userId) => userId !== "usr_free");
	await shared.set(SERVER_KEYS, "fal", "server-key");
	expect(await shared.find({ userId: "usr_paid" }, "fal")).toEqual({
		key: "server-key",
		source: "server",
	});
	expect(await shared.list({ userId: "usr_paid" })).toEqual(["fal"]);
	expect(await shared.get({ userId: "usr_free" }, "fal")).toBeUndefined();
	expect(await shared.list({ userId: "usr_free" })).toEqual([]);
	// One's own key comes first, and is nobody else's.
	await shared.set({ userId: "usr_paid" }, "fal", "own-key");
	expect(await shared.find({ userId: "usr_paid" }, "fal")).toEqual({
		key: "own-key",
		source: "personal",
	});
	expect(await shared.find({ userId: "usr_other" }, "fal")).toEqual({
		key: "server-key",
		source: "server",
	});
	expect(await shared.sources({ userId: "usr_paid" })).toEqual({
		personal: ["fal"],
		server: ["fal"],
	});
	await shared.delete(SERVER_KEYS, "fal");
	expect(await inner.list(SERVER_KEYS)).toEqual([]);
	expect(await shared.get({ userId: "usr_paid" }, "fal")).toBe("own-key");
});

describe("keys at rest", () => {
	const at = async () => {
		const dir = await mkdtemp(join(tmpdir(), "hatchlight-keys-"));
		dirs.push(dir);
		return join(dir, "auth.json");
	};

	test("are encrypted, each with a nonce of its own", async () => {
		const path = await at();
		const keys = new FileKeyStore(path, SECRET);
		await keys.set(me, "fal", "sk-same");
		await keys.set(me, "openai", "sk-same");
		const text = await Bun.file(path).text();
		expect(text).not.toContain("sk-same");
		const stored = JSON.parse(text).local;
		expect(stored.fal).toStartWith("enc:v1:");
		// The same key twice is two different texts.
		expect(stored.fal).not.toBe(stored.openai);
		expect(await keys.get(me, "fal")).toBe("sk-same");
	});

	test("saved before encryption are encrypted on start, and still read", async () => {
		const path = await at();
		await Bun.write(path, JSON.stringify({ local: { fal: "sk-plain" } }));
		const keys = new FileKeyStore(path, SECRET);
		expect(await keys.prepare()).toBeNull();
		expect(await Bun.file(path).text()).not.toContain("sk-plain");
		expect(await keys.get(me, "fal")).toBe("sk-plain");
		// Done once.
		expect(await Bun.file(path).text()).toContain("enc:v1:");
	});

	test("cannot be read with another secret, which leaves them as they are", async () => {
		const path = await at();
		await new FileKeyStore(path, SECRET).set(me, "fal", "sk-1");
		const before = await Bun.file(path).text();
		const other = new FileKeyStore(
			path,
			crypto.getRandomValues(new Uint8Array(32)),
		);
		await expect(other.get(me, "fal")).rejects.toThrow(path);
		await expect(other.set(me, "openai", "sk-2")).rejects.toThrow(
			"cannot be read with this secret",
		);
		// At start, the file is moved aside as it was, and the store is empty.
		const unreadable = await other.prepare();
		expect(unreadable?.owners).toEqual(["local"]);
		expect(await Bun.file(unreadable?.file as string).text()).toBe(before);
		expect(unreadable?.file).toContain("auth.unreadable-");
		expect(await Bun.file(path).exists()).toBe(false);
		expect(await other.list(me)).toEqual([]);
		await other.set(me, "openai", "sk-new");
		expect(await other.get(me, "openai")).toBe("sk-new");
	});

	test("cannot be moved to another person or provider by editing the file", async () => {
		const path = await at();
		const keys = new FileKeyStore(path, SECRET);
		await keys.set(me, "fal", "sk-mine");
		const data = JSON.parse(await Bun.file(path).text());
		data.someone = { openai: data.local.fal };
		await Bun.write(path, JSON.stringify(data));
		await expect(keys.get({ userId: "someone" }, "openai")).rejects.toThrow(
			SecretError,
		);
	});
});
