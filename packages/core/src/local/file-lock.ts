import {
	linkSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Keeps two Hatchlights that share a models folder (the desktop app and
 * Hatchlight under WSL do) from working on the same file at once: two
 * downloads appending to one `.part` corrupt it, and one removing a model
 * would delete a file the other is still writing.
 *
 * The holder rewrites `<file>.lock` while it works, so the lock of an
 * Hatchlight that died goes stale and is taken over. Ages are read against
 * the folder's own clock: under WSL the Linux clock drifts from the Windows
 * one, which stamps the files.
 */

/** A lock not rewritten for this long belongs to a Hatchlight that died. */
export const LOCK_STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const POLL_MS = 1_000;

export interface FileLockOptions {
	/** Called each time it finds the lock held by another, while it waits. */
	onWait?: () => void | Promise<void>;
	pollMs?: number;
	staleMs?: number;
	heartbeatMs?: number;
}

/** The time on the folder's clock, read from a file written there now. */
function folderNow(dir: string): number {
	const probe = join(dir, `.clock-${crypto.randomUUID()}`);
	try {
		writeFileSync(probe, "");
		return statSync(probe).mtimeMs;
	} finally {
		rmSync(probe, { force: true });
	}
}

/** Whether `path` was written within `staleMs`, on the folder's clock. */
function fresh(path: string, staleMs: number): boolean {
	try {
		const { mtimeMs } = statSync(path);
		return folderNow(dirname(path)) - mtimeMs <= staleMs;
	} catch {
		return false;
	}
}

/** Whether another Hatchlight, alive, holds `lock`. */
export function isLocked(lock: string, staleMs = LOCK_STALE_MS): boolean {
	return fresh(lock, staleMs);
}

/**
 * Takes `lock` if it is free, or left by a Hatchlight that died. A stale
 * lock is first renamed to a name of its own: of two taking it over at once,
 * only one renames it, so neither removes a lock the other just took.
 */
function take(lock: string, owner: string, staleMs: number): boolean {
	try {
		writeFileSync(lock, owner, { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (fresh(lock, staleMs)) return false;
	const aside = `${lock}.${crypto.randomUUID()}.stale`;
	try {
		renameSync(lock, aside);
	} catch {
		return false; // Another took it over first.
	}
	// Renewed between the look and the rename: put it back, unless another has
	// taken the name meanwhile (a link, unlike a rename, never replaces).
	if (fresh(aside, staleMs)) {
		try {
			linkSync(aside, lock);
		} catch {
			// Taken by another: theirs stands.
		}
		rmSync(aside, { force: true });
		return false;
	}
	rmSync(aside, { force: true });
	try {
		writeFileSync(lock, owner, { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

/** Keeps `lock` alive while held; stops once another holds it. */
function keepAlive(lock: string, owner: string, everyMs: number): () => void {
	const heartbeat = setInterval(() => {
		try {
			if (readFileSync(lock, "utf8") === owner) writeFileSync(lock, owner);
		} catch {
			// Unreachable for now; the next beat tries again.
		}
	}, everyMs);
	heartbeat.unref?.();
	return () => {
		clearInterval(heartbeat);
		try {
			// Only our own: a lock taken for dead may have been taken over.
			if (readFileSync(lock, "utf8") === owner) rmSync(lock);
		} catch {
			// Already gone.
		}
	};
}

/**
 * Takes `lock` now, or returns null when another Hatchlight holds it. The
 * returned function lets it go.
 */
export function tryFileLock(
	lock: string,
	options: Pick<FileLockOptions, "staleMs" | "heartbeatMs"> & {
		/** What the lock says, to tell who holds it; unique to this taking. */
		owner?: string;
	} = {},
): (() => void) | null {
	const owner = options.owner ?? crypto.randomUUID();
	if (!take(lock, owner, options.staleMs ?? LOCK_STALE_MS)) return null;
	return keepAlive(lock, owner, options.heartbeatMs ?? HEARTBEAT_MS);
}

/**
 * Runs `fn` holding `lock`, waiting while another Hatchlight holds it.
 * Rejects as soon as `signal` aborts, waiting or not.
 */
export async function withFileLock<T>(
	lock: string,
	signal: AbortSignal,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const owner = crypto.randomUUID();
	const staleMs = options.staleMs ?? LOCK_STALE_MS;
	for (;;) {
		signal.throwIfAborted();
		if (take(lock, owner, staleMs)) break;
		await options.onWait?.();
		await Bun.sleep(options.pollMs ?? POLL_MS);
	}
	const release = keepAlive(lock, owner, options.heartbeatMs ?? HEARTBEAT_MS);
	try {
		return await fn();
	} finally {
		release();
	}
}
