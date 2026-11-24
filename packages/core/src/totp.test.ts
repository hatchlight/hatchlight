import { expect, test } from "bun:test";
import {
	base32Decode,
	base32Encode,
	newTotpSecret,
	totp,
	totpUri,
	verifyTotp,
} from "./totp";

// RFC 6238, appendix B: the seeds are ASCII, sized for each hash.
const SEEDS = {
	sha1: "12345678901234567890",
	sha256: "12345678901234567890123456789012",
	sha512: "1234567890123456789012345678901234567890123456789012345678901234",
} as const;
const VECTORS: [number, string, string, string][] = [
	[59, "94287082", "46119246", "90693936"],
	[1111111109, "07081804", "68084774", "25091201"],
	[1111111111, "14050471", "67062674", "99943326"],
	[1234567890, "89005924", "91819424", "93441116"],
	[2000000000, "69279037", "90698825", "38618901"],
	[20000000000, "65353130", "77737706", "47863826"],
];

test("codes match the RFC 6238 test vectors", () => {
	const encode = (text: string) => new TextEncoder().encode(text);
	for (const [time, sha1, sha256, sha512] of VECTORS) {
		expect(totp(encode(SEEDS.sha1), time, { digits: 8 })).toBe(sha1);
		expect(
			totp(encode(SEEDS.sha256), time, { digits: 8, algorithm: "sha256" }),
		).toBe(sha256);
		expect(
			totp(encode(SEEDS.sha512), time, { digits: 8, algorithm: "sha512" }),
		).toBe(sha512);
	}
});

test("base32 round-trips and matches RFC 4648", () => {
	expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
	expect(
		new TextDecoder().decode(
			base32Decode("mzxw6ytboi======") ?? new Uint8Array(),
		),
	).toBe("foobar");
	expect(base32Decode("not base32!")).toBeNull();
	const secret = newTotpSecret();
	expect(secret).toMatch(/^[A-Z2-7]{32}$/);
	expect(base32Decode(secret)).toHaveLength(20);
});

test("a code is accepted a step either side of now, and not further", () => {
	const secret = base32Encode(new TextEncoder().encode(SEEDS.sha1));
	const now = 1111111111_000;
	const at = (seconds: number) =>
		totp(new TextEncoder().encode(SEEDS.sha1), seconds);
	expect(verifyTotp(secret, at(now / 1000), now)).toBe(true);
	expect(verifyTotp(secret, at(now / 1000 - 30), now)).toBe(true);
	expect(verifyTotp(secret, at(now / 1000 + 30), now)).toBe(true);
	expect(verifyTotp(secret, at(now / 1000 - 90), now)).toBe(false);
	expect(verifyTotp(secret, "12345", now)).toBe(false);
	expect(verifyTotp(secret, "abcdef", now)).toBe(false);
	// Spaces people type between the groups are fine.
	const code = at(now / 1000);
	expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(
		true,
	);
});

test("the otpauth address names the issuer and the account", () => {
	expect(totpUri("ABC", "ana", "Hatchlight")).toBe(
		"otpauth://totp/Hatchlight%3Aana?secret=ABC&issuer=Hatchlight&algorithm=SHA1&digits=6&period=30",
	);
});
