import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keysSecret, SecretError } from "./secrets";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function dir() {
	const made = await mkdtemp(join(tmpdir(), "hatchlight-secret-"));
	dirs.push(made);
	return made;
}

test("the secret is made once in the data directory, readable by its owner only", async () => {
	const data = await dir();
	const first = keysSecret(data, {});
	expect(first.byteLength).toBe(32);
	expect((await stat(join(data, "secret.key"))).mode & 0o777).toBe(0o600);
	expect(keysSecret(data, {})).toEqual(first);
});

test("a secret file named in the environment wins, as a Docker secret", async () => {
	const data = await dir();
	const file = join(data, "docker-secret");
	await writeFile(file, "a long random passphrase from the secret store\\n");
	const fromFile = keysSecret(data, { HATCHLIGHT_SECRET_FILE: file });
	expect(fromFile.byteLength).toBe(32);
	expect(fromFile).not.toEqual(keysSecret(data, {}));
	expect(keysSecret(data, { HATCHLIGHT_SECRET_FILE: file })).toEqual(fromFile);
});

test("a missing or short secret file is refused, saying which", async () => {
	const data = await dir();
	const missing = join(data, "nope");
	expect(() => keysSecret(data, { HATCHLIGHT_SECRET_FILE: missing })).toThrow(
		missing,
	);
	const short = join(data, "short");
	await writeFile(short, "tiny");
	expect(() => keysSecret(data, { HATCHLIGHT_SECRET_FILE: short })).toThrow(
		SecretError,
	);
});
