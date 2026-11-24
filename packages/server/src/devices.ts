import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Device cookies (OWASP): a browser that once signed in as a person gets a
 * signed cookie naming them. Signing in from it skips the limit on the name
 * from everywhere, so strangers guessing a name cannot lock its owner out;
 * the limit on the name from one address still applies.
 */
export class DeviceCookies {
	constructor(private key: Uint8Array) {}

	/** A new cookie value for `username`: the name, a random id, a signature. */
	issue(username: string): string {
		const name = Buffer.from(username.toLowerCase()).toString("base64url");
		const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
			"base64url",
		);
		return `${name}.${id}.${this.sign(name, id)}`;
	}

	/** Whether `value` is a cookie this server gave a browser that signed in as `username`. */
	vouchesFor(value: string | undefined, username: string): boolean {
		const [name, id, mac, ...rest] = value?.split(".") ?? [];
		if (!name || !id || !mac || rest.length) return false;
		const expected = Buffer.from(this.sign(name, id));
		const given = Buffer.from(mac);
		return (
			expected.length === given.length &&
			timingSafeEqual(expected, given) &&
			Buffer.from(name, "base64url").toString() ===
				username.trim().toLowerCase()
		);
	}

	private sign(name: string, id: string): string {
		return createHmac("sha256", this.key)
			.update(`${name}.${id}`)
			.digest("base64url");
	}
}

/**
 * The server's secret for device cookies, kept in the data directory and
 * readable only by its owner; made on first use.
 */
export function deviceKey(path: string): Uint8Array {
	if (existsSync(path)) {
		const key = readFileSync(path);
		if (key.byteLength >= 32) return new Uint8Array(key);
	}
	const key = crypto.getRandomValues(new Uint8Array(32));
	writeFileSync(path, key, { mode: 0o600 });
	// The mode above applies only to a new file.
	chmodSync(path, 0o600);
	return key;
}
