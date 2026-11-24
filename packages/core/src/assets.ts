import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UserContext } from "./types";

export interface StoredBlob {
	hash: string;
	size: number;
}

export interface AssetStore {
	put(ctx: UserContext, data: Uint8Array): Promise<StoredBlob>;
	get(ctx: UserContext, hash: string): Promise<Blob | null>;
}

/** Content-addressed files on disk: `<root>/<userId>/<hash[0..2]>/<hash>`. */
export class FsAssetStore implements AssetStore {
	constructor(private root: string) {}

	private path(ctx: UserContext, hash: string): string {
		if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid asset hash");
		if (!/^[\w-]+$/.test(ctx.userId)) throw new Error("Invalid user id");
		return join(this.root, ctx.userId, hash.slice(0, 2), hash);
	}

	async put(ctx: UserContext, data: Uint8Array): Promise<StoredBlob> {
		const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
		const path = this.path(ctx, hash);
		if (!(await Bun.file(path).exists())) {
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.${crypto.randomUUID()}.tmp`;
			await Bun.write(tmp, data);
			await rename(tmp, path);
		}
		return { hash, size: data.byteLength };
	}

	async get(ctx: UserContext, hash: string): Promise<Blob | null> {
		const file = Bun.file(this.path(ctx, hash));
		return (await file.exists()) ? file : null;
	}

	/** Gives `from`'s files to `to`, as when a server's first owner takes over. */
	async moveUser(from: string, to: string): Promise<void> {
		const source = join(this.root, from);
		const target = join(this.root, to);
		const shards = await readdir(source).catch(() => null);
		if (!shards) return;
		await mkdir(this.root, { recursive: true });
		if (
			!(await rename(source, target).then(
				() => true,
				() => false,
			))
		) {
			// The target exists: the files are merged in, shard by shard.
			for (const shard of shards) {
				await mkdir(join(target, shard), { recursive: true });
				for (const file of await readdir(join(source, shard))) {
					await rename(join(source, shard, file), join(target, shard, file));
				}
			}
			await rm(source, { recursive: true, force: true });
		}
	}
}
