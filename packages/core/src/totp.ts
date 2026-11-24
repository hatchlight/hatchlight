import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238), as authenticator apps make them:
 * HMAC-SHA1, 6 digits, a new code every 30 seconds.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 (RFC 4648) without padding, as otpauth URIs carry secrets. */
export function base32Encode(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(buffer >> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
	return out;
}

/** Reads base32, ignoring case, spaces and padding. Null when it is not. */
export function base32Decode(text: string): Uint8Array | null {
	const clean = text.replace(/[\s=]/g, "").toUpperCase();
	const out: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const char of clean) {
		const value = ALPHABET.indexOf(char);
		if (value < 0) return null;
		buffer = (buffer << 5) | value;
		bits += 5;
		if (bits >= 8) {
			out.push((buffer >> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

export interface TotpOptions {
	algorithm?: "sha1" | "sha256" | "sha512";
	digits?: number;
	period?: number;
}

/** The code for the time `seconds` (Unix time). */
export function totp(
	secret: Uint8Array,
	seconds: number,
	{ algorithm = "sha1", digits = 6, period = 30 }: TotpOptions = {},
): string {
	const counter = Math.floor(seconds / period);
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const mac = createHmac(algorithm, secret).update(message).digest();
	// Dynamic truncation, RFC 4226 section 5.3.
	const offset = (mac[mac.length - 1] ?? 0) & 0xf;
	const value =
		(((mac[offset] ?? 0) & 0x7f) << 24) |
		((mac[offset + 1] ?? 0) << 16) |
		((mac[offset + 2] ?? 0) << 8) |
		(mac[offset + 3] ?? 0);
	return String(value % 10 ** digits).padStart(digits, "0");
}

/**
 * Whether `code` is right for now, a step before or a step after: clocks
 * drift, and people type slowly.
 */
export function verifyTotp(
	secretBase32: string,
	code: string,
	nowMs = Date.now(),
): boolean {
	const secret = base32Decode(secretBase32);
	const typed = code.replace(/\s/g, "");
	if (!secret || !/^\d{6}$/.test(typed)) return false;
	const seconds = Math.floor(nowMs / 1000);
	let ok = false;
	for (const drift of [-30, 0, 30]) {
		const expected = Buffer.from(totp(secret, seconds + drift));
		// Every window is checked, so the time taken says nothing.
		if (timingSafeEqual(expected, Buffer.from(typed))) ok = true;
	}
	return ok;
}

/** A new secret: 20 random bytes, as RFC 4226 recommends. */
export function newTotpSecret(): string {
	return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** What authenticator apps scan or open to add an account. */
export function totpUri(
	secret: string,
	account: string,
	issuer: string,
): string {
	const label = encodeURIComponent(`${issuer}:${account}`);
	const params = new URLSearchParams({
		secret,
		issuer,
		algorithm: "SHA1",
		digits: "6",
		period: "30",
	});
	return `otpauth://totp/${label}?${params}`;
}
