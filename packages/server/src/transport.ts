import { appEnv } from "@hatchlight/core";

/**
 * How Hatchlight is reached. `personal` is one person on this computer, over
 * loopback. `server` is several people reaching a shared machine over the
 * network, through its public address.
 */
export type ServerMode = "personal" | "server";

/** A block of addresses, as 16 bytes: IPv4 is kept as IPv4-mapped IPv6. */
export interface Cidr {
	bytes: Uint8Array;
	prefix: number;
}

/** What server mode needs to tell its own requests from forged ones. */
export interface ServerTransport {
	/** The origin people open, e.g. `https://hatchlight.example.com`. */
	publicOrigin: string;
	/** Host names, lowercase and without a port, that requests may name. */
	allowedHosts: string[];
	/** Peers whose X-Forwarded-* headers are believed. */
	trustedProxies: Cidr[];
}

/** How much a person who is not an admin may add, so one cannot fill the disk. */
export interface LoraQuota {
	files: number;
	bytes: number;
}

export const DEFAULT_LORA_QUOTA: LoraQuota = {
	files: 20,
	bytes: 10 * 1024 ** 3,
};

export interface ServerConfig {
	mode: ServerMode;
	/** The address to listen on. */
	host: string;
	/** Present in server mode only. */
	transport: ServerTransport | null;
	/** LoRAs each member may add; server mode only. */
	loraQuota: LoraQuota | null;
}

/** A setting that cannot be used; the message says which and why. */
export class ConfigError extends Error {}

/**
 * Reads the server settings from the command line and the environment
 * (HATCHLIGHT_MODE, HATCHLIGHT_HOST, HATCHLIGHT_PUBLIC_URL,
 * HATCHLIGHT_ALLOWED_HOSTS, HATCHLIGHT_TRUSTED_PROXIES). Flags win.
 * Personal mode ignores the network settings, so it stays as it always was.
 */
export function serverConfig(
	flags: { mode?: string; host?: string },
	env: Record<string, string | undefined>,
): ServerConfig {
	const mode = flags.mode ?? appEnv(env, "MODE") ?? "personal";
	if (mode !== "personal" && mode !== "server") {
		throw new ConfigError(`Unknown mode: ${mode}. Use "personal" or "server"`);
	}
	const host =
		flags.host ??
		appEnv(env, "HOST") ??
		(mode === "server" ? "0.0.0.0" : "127.0.0.1");
	if (mode === "personal") {
		// Personal mode has no login: only this computer may reach it.
		if (!isLoopback(host)) {
			throw new ConfigError(
				`Personal mode listens only on this computer (127.0.0.1, ::1 or localhost), not on ${host}. To reach Hatchlight from other machines, run it with --mode server, which has accounts`,
			);
		}
		return { mode, host, transport: null, loraQuota: null };
	}

	const publicUrl = appEnv(env, "PUBLIC_URL");
	if (!publicUrl) {
		throw new ConfigError(
			"Server mode needs HATCHLIGHT_PUBLIC_URL, the address people open, such as https://hatchlight.example.com",
		);
	}
	const publicOrigin = parsePublicUrl(publicUrl);
	const allowedHosts = [
		new URL(publicOrigin).hostname,
		...list(appEnv(env, "ALLOWED_HOSTS")).map(parseHost),
	];
	const trustedProxies = list(appEnv(env, "TRUSTED_PROXIES")).map(parseCidr);
	const count = (name: string, fallback: number) => {
		const value = appEnv(env, name);
		if (value === undefined) return fallback;
		const number = Number(value);
		if (!(Number.isFinite(number) && number >= 0)) {
			throw new ConfigError(`HATCHLIGHT_${name} must be a number, 0 or more`);
		}
		return number;
	};
	const loraQuota = {
		files: Math.floor(count("LORA_FILES_PER_PERSON", DEFAULT_LORA_QUOTA.files)),
		bytes: Math.floor(
			count("LORA_GB_PER_PERSON", DEFAULT_LORA_QUOTA.bytes / 1024 ** 3) *
				1024 ** 3,
		),
	};
	return {
		mode,
		host,
		transport: { publicOrigin, allowedHosts, trustedProxies },
		loraQuota,
	};
}

const list = (value: string | undefined): string[] =>
	(value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

/** The origin of an http(s) address with nothing after the host. */
export function parsePublicUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(`HATCHLIGHT_PUBLIC_URL is not an address: ${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ConfigError(
			`HATCHLIGHT_PUBLIC_URL must start with https:// or http://: ${value}`,
		);
	}
	if (
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new ConfigError(
			`HATCHLIGHT_PUBLIC_URL must be only a scheme and a host, such as https://hatchlight.example.com: ${value}`,
		);
	}
	return url.origin;
}

/** A host name as requests carry it, without a port, lowercase. */
function parseHost(value: string): string {
	let url: URL;
	try {
		url = new URL(`http://${value}`);
	} catch {
		throw new ConfigError(
			`Not a host name in HATCHLIGHT_ALLOWED_HOSTS: ${value}`,
		);
	}
	if (url.username || url.password || url.pathname !== "/" || url.search) {
		throw new ConfigError(
			`Not a host name in HATCHLIGHT_ALLOWED_HOSTS: ${value}`,
		);
	}
	return url.hostname;
}

/** A host from a Host header without its port, as `URL` writes it. */
export function hostName(host: string): string | null {
	// Only what a host and port are made of: no path, user or query to hide behind.
	if (!/^[\w.\-[\]:]+$/.test(host)) return null;
	try {
		return new URL(`http://${host}`).hostname;
	} catch {
		return null;
	}
}

function parseCidr(value: string): Cidr {
	const [address = "", prefixText, ...rest] = value.split("/");
	const bytes = parseIp(address);
	const fail = () =>
		new ConfigError(
			`Not an address or block in HATCHLIGHT_TRUSTED_PROXIES: ${value}`,
		);
	if (!bytes || rest.length) throw fail();
	const v4 = !address.includes(":");
	const width = v4 ? 32 : 128;
	const prefix = prefixText === undefined ? width : Number(prefixText);
	if (
		prefixText === "" ||
		!Number.isInteger(prefix) ||
		prefix < 0 ||
		prefix > width
	) {
		throw fail();
	}
	return { bytes, prefix: v4 ? prefix + 96 : prefix };
}

/** Parses an IPv4 or IPv6 address into 16 bytes, or null. */
export function parseIp(text: string): Uint8Array | null {
	const address = text.replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
	const bytes = new Uint8Array(16);
	if (!address.includes(":")) {
		const v4 = parseIpv4(address);
		if (!v4) return null;
		bytes[10] = 0xff;
		bytes[11] = 0xff;
		bytes.set(v4, 12);
		return bytes;
	}
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const groups = (part: string | undefined): number[] | null => {
		if (!part) return [];
		const out: number[] = [];
		const items = part.split(":");
		for (const [index, item] of items.entries()) {
			// The last group may be an IPv4 address, as in ::ffff:10.0.0.1.
			if (index === items.length - 1 && item.includes(".")) {
				const v4 = parseIpv4(item);
				if (!v4) return null;
				out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0));
				out.push(((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
			} else if (/^[0-9a-f]{1,4}$/i.test(item)) {
				out.push(Number.parseInt(item, 16));
			} else {
				return null;
			}
		}
		return out;
	};
	const head = groups(halves[0]);
	const tail = groups(halves[1]);
	if (!head || !tail) return null;
	const missing = 8 - head.length - tail.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const all = [...head, ...new Array<number>(missing).fill(0), ...tail];
	for (const [index, group] of all.entries()) {
		bytes[index * 2] = group >> 8;
		bytes[index * 2 + 1] = group & 0xff;
	}
	return bytes;
}

function parseIpv4(text: string): number[] | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	const out: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const value = Number(part);
		if (value > 255) return null;
		out.push(value);
	}
	return out;
}

/** Whether `address` falls in one of `blocks`. */
export function inBlocks(address: string, blocks: Cidr[]): boolean {
	const bytes = parseIp(address);
	if (!bytes) return false;
	return blocks.some((block) => {
		for (let bit = 0; bit < block.prefix; bit++) {
			const byte = bit >> 3;
			const mask = 0x80 >> (bit & 7);
			if (((bytes[byte] ?? 0) & mask) !== ((block.bytes[byte] ?? 0) & mask)) {
				return false;
			}
		}
		return true;
	});
}

/** The first value of a comma-separated header, as the client's side sent it. */
const first = (header: string | undefined): string | undefined =>
	header?.split(",")[0]?.trim() || undefined;

/** Where a request came from and where it was sent, past trusted proxies. */
export interface RequestOrigin {
	/** `http` or `https`, as the browser used it. */
	scheme: string;
	/** The host and port the browser asked for. */
	host: string;
	/** The browser's address, when known. */
	client: string | null;
}

/**
 * Works out the scheme, host and client of a request. Forwarded headers are
 * read only when the connection comes from a trusted proxy: anyone else could
 * write them.
 */
export function requestOrigin(
	url: URL,
	headers: { get(name: string): string | null },
	peer: string | null,
	trustedProxies: Cidr[],
): RequestOrigin {
	const direct = {
		scheme: url.protocol.slice(0, -1),
		host: url.host,
		client: peer,
	};
	if (!peer || !inBlocks(peer, trustedProxies)) return direct;
	const proto = first(headers.get("x-forwarded-proto") ?? undefined);
	const host = first(headers.get("x-forwarded-host") ?? undefined);
	// The client is the last address a trusted proxy did not add.
	const hops = (headers.get("x-forwarded-for") ?? "")
		.split(",")
		.map((hop) => hop.trim())
		.filter(Boolean);
	let client = peer;
	while (hops.length && inBlocks(client, trustedProxies)) {
		client = hops.pop() as string;
	}
	return {
		scheme: proto === "https" || proto === "http" ? proto : direct.scheme,
		host: host ?? direct.host,
		client,
	};
}

/**
 * Where processes on this machine reach a server listening on `host`: over
 * loopback when it listens everywhere, else at the address it listens on.
 */
export function localUrl(host: string, port: number): string {
	const bare = host.replace(/^\[(.*)\]$/, "$1");
	if (bare === "0.0.0.0" || bare === "") return `http://127.0.0.1:${port}`;
	if (bare === "::") return `http://[::1]:${port}`;
	return bare.includes(":")
		? `http://[${bare}]:${port}`
		: `http://${bare}:${port}`;
}

const LOOPBACK = ["127.0.0.0/8", "::1/128"].map((block) => parseCidr(block));

/** Whether an address or host name is this computer's own. */
export function isLoopback(address: string): boolean {
	const bare = address.replace(/^\[(.*)\]$/, "$1").toLowerCase();
	return bare === "localhost" || inBlocks(bare, LOOPBACK);
}
