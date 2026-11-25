import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProviderEvent } from "../provider";

/**
 * Shares the GPU's memory between jobs, in this process and in every other
 * Hatchlight that uses the same models folder (the desktop app and Hatchlight
 * under WSL do). Jobs whose models fit together run together; one that does
 * not fit waits. Waiting jobs go in the order they started waiting, except
 * that a job may go ahead of those that could not run now anyway. Without
 * this, two engines fill the GPU's memory, spill into the computer's, and
 * both crawl.
 *
 * In the folder's `gpu/`:
 *   <owner>        the bytes a process has reserved, rewritten while it holds
 *   wait-<id>      a job waiting: since when, and the bytes it needs
 *   mutex          held while a process checks and reserves
 *   clock-<owner>  written to read the time
 *
 * A file not rewritten for a while belongs to a process that died. Ages are
 * read against the folder's own clock, never the process's: under WSL the
 * Linux clock drifts from the Windows one, which stamps the files.
 */

/** A reservation not rewritten for this long belongs to a process that died. */
export const STALE_MS = 30_000;
/** Waiters rewrite their file every poll, so theirs goes stale sooner. */
const WAIT_STALE_MS = 5_000;
/** A mutex older than this was left by a process that died holding it. */
const MUTEX_STALE_MS = 5_000;
const HEARTBEAT_MS = 5_000;
const POLL_MS = 1_000;
/** Retry a busy mutex this soon: another process holds it for an instant. */
const MUTEX_RETRY_MS = 20;
/** Reads of a reservation caught while being rewritten before giving up. */
const REREAD_ATTEMPTS = 3;
/** The folder failing this many times in a row fails the job. */
const MAX_ERRORS = 10;

export interface GpuLockOptions {
	root: string;
	/** The GPU memory jobs may use; null runs one job at a time. */
	capacity: () => Promise<number | null>;
	staleMs?: number;
	heartbeatMs?: number;
	pollMs?: number;
}

export interface GpuHoldOptions {
	/**
	 * Called when a waiting job would fit without this hold. A holder that is
	 * only keeping a model loaded gives it back by releasing.
	 */
	onWanted?: () => void;
}

export interface GpuHold {
	release(): void;
}

interface Hold {
	bytes: number;
	onWanted?: () => void;
}

interface Waiter {
	id: string;
	since: number;
	bytes: number;
}

/** What the folder says: memory others reserve, and who waits. */
interface View {
	others: number;
	waiters: Waiter[];
}

export class GpuLock {
	private dir: string;
	private owner = crypto.randomUUID();
	private holds = new Set<Hold>();
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private capacity: () => Promise<number | null>;
	private known: number | null = null;
	private staleMs: number;
	private heartbeatMs: number;
	private pollMs: number;

	constructor(options: GpuLockOptions) {
		this.dir = join(options.root, "gpu");
		this.capacity = options.capacity;
		this.staleMs = options.staleMs ?? STALE_MS;
		this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
		this.pollMs = options.pollMs ?? POLL_MS;
	}

	/**
	 * Follows the models folder elsewhere. What this process holds is written
	 * there from the next beat; its file in the old folder goes stale.
	 */
	moveTo(root: string): void {
		this.dir = join(root, "gpu");
		if (this.holds.size > 0) {
			try {
				this.publish();
			} catch {
				// The next beat tries again.
			}
		}
	}

	/** Whether any Hatchlight, this one included, holds or waits for the GPU. */
	inUse(): boolean {
		if (this.holds.size > 0) return true;
		try {
			mkdirSync(this.dir, { recursive: true });
			const view = this.look(this.now(), false);
			return view.others > 0 || view.waiters.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Bytes other Hatchlights sharing the folder have reserved, as far as
	 * known. A reservation caught while being rewritten is read again a
	 * moment later; still unreadable, it counts as the whole GPU (Infinity).
	 */
	async othersReserved(): Promise<number> {
		for (let attempt = 1; ; attempt++) {
			let others: number;
			try {
				mkdirSync(this.dir, { recursive: true });
				others = this.look(this.now(), false).others;
			} catch {
				return 0;
			}
			if (Number.isFinite(others) || attempt >= REREAD_ATTEMPTS) return others;
			await Bun.sleep(MUTEX_RETRY_MS);
		}
	}

	/** Bytes this process has reserved. */
	get reserved(): number {
		let bytes = 0;
		for (const hold of this.holds) bytes += hold.bytes;
		return bytes;
	}

	private file(name: string): string {
		return join(this.dir, name);
	}

	/** The time on the folder's clock, which stamps every file in it. */
	private now(): number {
		const probe = this.file(`clock-${this.owner}`);
		writeFileSync(probe, "");
		return statSync(probe).mtimeMs;
	}

	/** Whether `need` more bytes fit beside `used`. A job alone always fits. */
	private fits(used: number, need: number): boolean {
		return used <= 0 || used + need <= (this.known ?? 0);
	}

	/**
	 * Runs `fn` while no other process is reading or changing reservations;
	 * null when another holds the mutex.
	 */
	private exclusive<T>(fn: (now: number) => T): T | null {
		const mutex = this.file("mutex");
		try {
			writeFileSync(mutex, "", { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (this.now() - statSync(mutex).mtimeMs > MUTEX_STALE_MS) {
					rmSync(mutex, { force: true });
				}
			} catch {
				// Released meanwhile.
			}
			return null;
		}
		try {
			return fn(this.now());
		} finally {
			rmSync(mutex, { force: true });
		}
	}

	/**
	 * Reads the folder. With `clean`, which only the mutex's holder may ask,
	 * the files of processes that died are removed.
	 */
	private look(now: number, clean: boolean): View {
		let others = 0;
		const waiters: Waiter[] = [];
		for (const name of readdirSync(this.dir)) {
			if (name === "mutex") continue;
			const path = this.file(name);
			try {
				const age = now - statSync(path).mtimeMs;
				const waiting = name.startsWith("wait-");
				if (age > (waiting ? WAIT_STALE_MS : this.staleMs)) {
					if (clean) rmSync(path, { force: true });
					continue;
				}
				if (name.startsWith("clock-")) continue;
				const content = readFileSync(path, "utf8");
				if (waiting) {
					const [since, bytes] = content.split(":").map(Number);
					// Caught while being rewritten: it is still there next poll.
					if (since && Number.isFinite(bytes)) {
						waiters.push({ id: name.slice(5), since, bytes: bytes ?? 0 });
					}
				} else if (name !== this.owner) {
					// Caught while being rewritten: count it as the whole GPU.
					const bytes = Number(content);
					others += content && Number.isFinite(bytes) ? bytes : Infinity;
				}
			} catch {
				// Removed meanwhile.
			}
		}
		return { others, waiters };
	}

	/** Writes what this process holds, or removes its file when nothing. */
	private publish(): void {
		if (this.holds.size === 0) {
			rmSync(this.file(this.owner), { force: true });
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
			return;
		}
		// Written, not only touched: the folder's clock stamps it, and a file
		// another process wrongly took for dead comes back.
		writeFileSync(this.file(this.owner), String(this.reserved));
		if (!this.heartbeat) {
			this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs);
			// A reservation alone does not keep Hatchlight running.
			this.heartbeat.unref?.();
		}
	}

	private beat(): void {
		try {
			this.publish();
			this.letGoFor(this.look(this.now(), false));
		} catch {
			// The folder is unreachable for now; the next beat tries again.
		}
	}

	/**
	 * Asks each hold that could let go whether a waiting job would fit
	 * without it, and lets go only then: a model dropped for a job that still
	 * could not run is a reload for nothing.
	 */
	private letGoFor(view: View): void {
		const used = this.reserved + view.others;
		for (const hold of [...this.holds]) {
			if (!hold.onWanted) continue;
			if (view.waiters.some((w) => this.fits(used - hold.bytes, w.bytes))) {
				hold.onWanted();
			}
		}
	}

	/**
	 * Whether a waiting job, here or in another Hatchlight, would fit if
	 * `bytes` of this process's were given back.
	 */
	wanted(bytes: number): boolean {
		try {
			const view = this.look(this.now(), false);
			const used = this.reserved + view.others - bytes;
			return view.waiters.some((w) => this.fits(used, w.bytes));
		} catch {
			return false;
		}
	}

	/**
	 * Waits until `bytes` of the GPU's memory are this job's, saying once that
	 * it waits so the job does not look stuck. A job alone always runs, even
	 * one larger than the GPU: the engine then spills, slowly but surely.
	 */
	async *acquire(
		bytes: number,
		signal: AbortSignal,
		options: GpuHoldOptions = {},
	): AsyncGenerator<ProviderEvent, GpuHold> {
		mkdirSync(this.dir, { recursive: true });
		this.known = await this.capacity().catch(() => null);
		const hold: Hold = { bytes, onWanted: options.onWanted };
		const id = crypto.randomUUID();
		const waitFile = this.file(`wait-${id}`);
		let since: number | null = null;
		let errors = 0;
		try {
			for (;;) {
				signal.throwIfAborted();
				let taken: boolean | null;
				let view: View = { others: 0, waiters: [] };
				try {
					taken = this.exclusive((now) => {
						view = this.look(now, true);
						const used = this.reserved + view.others;
						if (!this.fits(used, bytes)) return false;
						// Those waiting longer go first if they can run now; one
						// that could not anyway is not kept waiting for.
						const first = view.waiters.some(
							(w) =>
								w.id !== id &&
								(since == null || w.since < since) &&
								this.fits(used, w.bytes),
						);
						if (first) return false;
						this.holds.add(hold);
						try {
							this.publish();
						} catch (error) {
							this.holds.delete(hold);
							throw error;
						}
						return true;
					});
					errors = 0;
				} catch (error) {
					// A file locked for a moment (an antivirus, a busy disk).
					if (++errors >= MAX_ERRORS) throw error;
					taken = null;
				}
				if (taken) break;
				if (taken === null) {
					await Bun.sleep(MUTEX_RETRY_MS);
					continue;
				}
				try {
					if (since == null) {
						since = this.now();
						yield {
							type: "progress",
							message: "Waiting for the GPU",
							stage: "waitingGpu",
						};
					}
					// Rewritten each time, so it stays alive while the job waits.
					writeFileSync(waitFile, `${since}:${bytes}`);
					this.letGoFor({
						others: view.others,
						waiters: [{ id, since, bytes }],
					});
				} catch (error) {
					if (++errors >= MAX_ERRORS) throw error;
				}
				await Bun.sleep(this.pollMs);
			}
		} finally {
			try {
				rmSync(waitFile, { force: true });
			} catch {
				// Left behind, it goes stale and stops counting.
			}
		}
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.holds.delete(hold);
				try {
					this.publish();
				} catch {
					// Unreachable for now: the file goes stale and stops counting.
				}
			},
		};
	}

	/** Gives back everything, as the process ends. */
	close(): void {
		this.holds.clear();
		try {
			this.publish();
			rmSync(this.file(`clock-${this.owner}`), { force: true });
		} catch {
			// Already gone.
		}
	}
}
