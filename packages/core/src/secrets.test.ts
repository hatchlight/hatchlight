import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
	await writeFile(file, "a long random passphrase from the secret store\n", {
		mode: 0o600,
	});
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
	await writeFile(short, "tiny", { mode: 0o600 });
	expect(() => keysSecret(data, { HATCHLIGHT_SECRET_FILE: short })).toThrow(
		SecretError,
	);
});

test("a secret others can read is refused, with the command that fixes it", async () => {
	const data = await dir();
	const file = join(data, "secret");
	await writeFile(file, "a long random passphrase from the secret store", {
		mode: 0o644,
	});
	await chmod(file, 0o644);
	const env = { HATCHLIGHT_SECRET_FILE: file };
	expect(() => keysSecret(data, env, "linux")).toThrow(`chmod 600 ${file}`);
	// The one made in the data directory too.
	keysSecret(data, {}, "linux");
	const made = join(data, "secret.key");
	await chmod(made, 0o640);
	expect(() => keysSecret(data, {}, "linux")).toThrow(SecretError);
	// Windows has no such modes: not checked there.
	expect(keysSecret(data, env, "win32").byteLength).toBe(32);
	await chmod(file, 0o600);
	expect(keysSecret(data, env, "linux").byteLength).toBe(32);
});
