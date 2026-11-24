import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SecretError } from "./secrets";
import type { UserContext } from "./types";

/** Whose key pays: the server's, shared, or the person's own. */
export type KeySource = "server" | "personal";

export interface FoundKey {
	key: string;
	source: KeySource;
}

export interface KeyStore {
	get(ctx: UserContext, providerId: string): Promise<string | undefined>;
	/** The key a person's calls to a provider use, and whose it is. */
	find(ctx: UserContext, providerId: string): Promise<FoundKey | undefined>;
	set(ctx: UserContext, providerId: string, key: string): Promise<void>;
	delete(ctx: UserContext, providerId: string): Promise<void>;
	/** Provider ids that have a stored key. Never returns the keys themselves. */
	list(ctx: UserContext): Promise<string[]>;
	/** On a server: providers with a key of the person's own, and with the server's. */
	sources?(ctx: UserContext): Promise<Record<KeySource, string[]>>;
}

type KeyFile = Record<string, Record<string, string>>;

/** Names that would reach an object's prototype instead of a key of its own. */
function isPrototypeName(name: string): boolean {
	return name === "__proto__" || name === "constructor" || name === "prototype";
}

/** How an encrypted value starts; anything else is from before encryption. */
const SEALED = "enc:v1:";

/**
 * API keys in a JSON file readable only by the owner, each value encrypted
 * with AES-256-GCM under `secret`, with a nonce of its own, and bound to
 * whose key it is and for which provider.
 */
export class FileKeyStore implements KeyStore {
	/** Serializes changes so concurrent ones cannot overwrite each other. */
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private path: string,
		private secret: Uint8Array,
	) {
		if (secret.byteLength !== 32)
			throw new Error("The secret must be 32 bytes");
	}

	private seal(owner: string, provider: string, value: string): string {
		const nonce = crypto.getRandomValues(new Uint8Array(12));
		const cipher = createCipheriv("aes-256-gcm", this.secret, nonce);
		cipher.setAAD(Buffer.from(`${owner}\n${provider}`));
		const sealed = Buffer.concat([
			cipher.update(value, "utf8"),
			cipher.final(),
			cipher.getAuthTag(),
		]);
		return `${SEALED}${Buffer.from(nonce).toString("base64url")}.${sealed.toString("base64url")}`;
	}

	private open(owner: string, provider: string, stored: string): string {
		if (!stored.startsWith(SEALED)) return stored;
		const [nonce = "", sealed = ""] = stored.slice(SEALED.length).split(".");
		const bytes = Buffer.from(sealed, "base64url");
		try {
			const decipher = createDecipheriv(
				"aes-256-gcm",
				this.secret,
				Buffer.from(nonce, "base64url"),
			);
			decipher.setAAD(Buffer.from(`${owner}\n${provider}`));
			decipher.setAuthTag(bytes.subarray(bytes.byteLength - 16));
			return Buffer.concat([
				decipher.update(bytes.subarray(0, bytes.byteLength - 16)),
				decipher.final(),
			]).toString("utf8");
		} catch {
			throw new SecretError(
				`The API keys in ${this.path} cannot be read with this secret: it is not the one they were saved with. Restore that secret (HATCHLIGHT_SECRET_FILE, or secret.key in the data directory); the file is left as it is`,
			);
		}
	}

	/**
	 * Checks every key opens with this secret, then encrypts those saved
	 * before encryption, in one atomic rewrite. Says if it rewrote.
	 */
	async migrate(): Promise<boolean> {
		await this.read();
		const raw = await this.readRaw();
		const plain = Object.values(raw).some((keys) =>
			Object.values(keys ?? {}).some((value) => !value.startsWith(SEALED)),
		);
		if (plain) await this.change(() => {});
		return plain;
	}

	private change(mutate: (data: KeyFile) => void): Promise<void> {
		const next = this.pending.then(async () => {
			const data = await this.read();
			mutate(data);
			await this.write(data);
		});
		this.pending = next.catch(() => {});
		return next;
	}

	private async readRaw(): Promise<KeyFile> {
		const file = Bun.file(this.path);
		if (!(await file.exists())) return {};
		return (await file.json()) as KeyFile;
	}

	/** The keys, opened. Throws, and so stops any write, when one cannot be. */
	private async read(): Promise<KeyFile> {
		const raw = await this.readRaw();
		const data: KeyFile = {};
		for (const [owner, keys] of Object.entries(raw)) {
			if (isPrototypeName(owner)) continue;
			data[owner] = {};
			for (const [provider, value] of Object.entries(keys ?? {})) {
				if (isPrototypeName(provider)) continue;
				(data[owner] as Record<string, string>)[provider] = this.open(
					owner,
					provider,
					value,
				);
			}
		}
		return data;
	}

	private async write(data: KeyFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		// Written aside and renamed, so a crash cannot leave a half-written file.
		const tmp = `${this.path}.${crypto.randomUUID()}.tmp`;
		const sealed: KeyFile = {};
		for (const [owner, keys] of Object.entries(data)) {
			sealed[owner] = {};
			for (const [provider, value] of Object.entries(keys ?? {})) {
				(sealed[owner] as Record<string, string>)[provider] = this.seal(
					owner,
					provider,
					value,
				);
			}
		}
		// Created owner-only from the start, so the keys are never readable by others.
		await writeFile(tmp, JSON.stringify(sealed, null, 2), { mode: 0o600 });
		await rename(tmp, this.path);
	}

	async get(ctx: UserContext, providerId: string) {
		const data = await this.read();
		if (!Object.hasOwn(data, ctx.userId)) return undefined;
		const keys = data[ctx.userId];
		return keys && Object.hasOwn(keys, providerId)
			? keys[providerId]
			: undefined;
	}

	/** On a personal install every key is the person's own. */
	async find(ctx: UserContext, providerId: string) {
		const key = await this.get(ctx, providerId);
		return key === undefined ? undefined : { key, source: "personal" as const };
	}

	async set(ctx: UserContext, providerId: string, key: string) {
		if (isPrototypeName(ctx.userId) || isPrototypeName(providerId)) {
			throw new Error(`Not a provider: ${providerId}`);
		}
		await this.change((data) => {
			data[ctx.userId] = { ...data[ctx.userId], [providerId]: key };
		});
	}

	async delete(ctx: UserContext, providerId: string) {
		if (isPrototypeName(ctx.userId) || isPrototypeName(providerId)) return;
		await this.change((data) => {
			if (!Object.hasOwn(data, ctx.userId)) return;
			const keys = data[ctx.userId];
			if (keys && Object.hasOwn(keys, providerId)) delete keys[providerId];
		});
	}

	async list(ctx: UserContext) {
		const data = await this.read();
		return Object.hasOwn(data, ctx.userId)
			? Object.keys(data[ctx.userId] ?? {})
			: [];
	}

	/** Gives `from`'s keys to `to`, keeping any `to` already has. */
	async moveUser(from: string, to: string): Promise<void> {
		if (isPrototypeName(from) || isPrototypeName(to)) return;
		await this.change((data) => {
			if (!Object.hasOwn(data, from)) return;
			data[to] = { ...data[from], ...data[to] };
			delete data[from];
		});
	}
}

/** Where a server keeps its keys: they are the server's, not one person's. */
export const SERVER_KEYS: UserContext = { userId: "server" };

/**
 * A server's keys: the server's own, set by its owners, and each person's
 * own. A person's key is used before the server's. Only people allowed to
 * spend on paid models use either.
 */
export class SharedKeyStore implements KeyStore {
	constructor(
		private inner: KeyStore,
		private mayUse: (userId: string) => boolean,
	) {}

	async get(ctx: UserContext, providerId: string) {
		return (await this.find(ctx, providerId))?.key;
	}

	async find(ctx: UserContext, providerId: string) {
		if (!this.mayUse(ctx.userId)) return undefined;
		const own =
			ctx.userId === SERVER_KEYS.userId
				? undefined
				: await this.inner.get(ctx, providerId);
		if (own !== undefined) return { key: own, source: "personal" as const };
		const shared = await this.inner.get(SERVER_KEYS, providerId);
		return shared === undefined
			? undefined
			: { key: shared, source: "server" as const };
	}

	/** Sets the person's own key; the server's are set as SERVER_KEYS. */
	set(ctx: UserContext, providerId: string, key: string) {
		return this.inner.set(ctx, providerId, key);
	}

	delete(ctx: UserContext, providerId: string) {
		return this.inner.delete(ctx, providerId);
	}

	/** Providers the person has a key for to use, theirs or the server's. */
	async list(ctx: UserContext) {
		if (!this.mayUse(ctx.userId)) return [];
		const { personal, server } = await this.sources(ctx);
		return [...new Set([...personal, ...server])];
	}

	/** Which providers have a key of the person's own, and which the server's. */
	async sources(ctx: UserContext): Promise<Record<KeySource, string[]>> {
		return {
			personal:
				ctx.userId === SERVER_KEYS.userId ? [] : await this.inner.list(ctx),
			server: await this.inner.list(SERVER_KEYS),
		};
	}
}
