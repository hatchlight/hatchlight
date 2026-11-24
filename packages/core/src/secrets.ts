import { hkdfSync } from "node:crypto";
import {
	chmodSync,
	existsSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appEnv } from "./legacy";

/** A secret the keys cannot be read or written without; the message says why. */
export class SecretError extends Error {}

/**
 * The key API keys are encrypted with: derived from HATCHLIGHT_SECRET_FILE
 * when set (a Docker secret, say), else from `secret.key` in the data
 * directory, made on first use and readable only by its owner.
 */
export function keysSecret(
	dataDir: string,
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
): Uint8Array {
	const named = appEnv(env, "SECRET_FILE");
	const path = named ?? join(dataDir, "secret.key");
	let raw: Uint8Array;
	if (named) {
		if (!existsSync(named)) {
			throw new SecretError(
				`HATCHLIGHT_SECRET_FILE names ${named}, which does not exist`,
			);
		}
		raw = readFileSync(named);
	} else if (existsSync(path)) {
		raw = readFileSync(path);
	} else {
		raw = crypto.getRandomValues(new Uint8Array(32));
		writeFileSync(path, raw, { mode: 0o600, flag: "wx" });
		chmodSync(path, 0o600);
	}
	// Readable by others, it opens every key: refused, with how to fix it.
	// Windows has no such mode bits.
	if (platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
		throw new SecretError(
			`${path} can be read by other users of this machine. Make it private with: chmod 600 ${path}`,
		);
	}
	if (raw.byteLength < 16) {
		throw new SecretError(
			`${path} is too short to be a secret: it needs at least 16 bytes, better 32 random ones`,
		);
	}
	// Any secret, text or bytes, becomes a uniform 256-bit key.
	return new Uint8Array(
		hkdfSync("sha256", raw, new Uint8Array(0), "hatchlight api keys", 32),
	);
}
