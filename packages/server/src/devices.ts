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

	/**
	 * A new cookie value for a person: their id, a random device id, and a
	 * signature over both and their username, all as the server stores them.
	 */
	issue(user: { id: string; username: string }): string {
		const device = Buffer.from(
			crypto.getRandomValues(new Uint8Array(16)),
		).toString("base64url");
		return `${user.id}.${device}.${this.sign(user, device)}`;
	}

	/** Whether `value` is a cookie this server gave a browser that signed in as `user`. */
	vouchesFor(
		value: string | undefined,
		user: { id: string; username: string } | null,
	): boolean {
		if (!user) return false;
		const [id, device, mac, ...rest] = value?.split(".") ?? [];
		if (!id || !device || !mac || rest.length || id !== user.id) return false;
		const expected = Buffer.from(this.sign(user, device));
		const given = Buffer.from(mac);
		return expected.length === given.length && timingSafeEqual(expected, given);
	}

	private sign(user: { id: string; username: string }, device: string): string {
		return createHmac("sha256", this.key)
			.update(`${user.id}\n${user.username}\n${device}`)
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
