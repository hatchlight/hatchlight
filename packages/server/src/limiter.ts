/**
 * Slows down guessing: after a few failed tries for the same key (an
 * address, a username), each further try must wait, twice as long each time.
 * Kept in memory: a restart forgives, which is fine for a home server.
 */
export class Limiter {
	private entries = new Map<
		string,
		{ failures: number; nextAt: number; lastAt: number }
	>();
	private now: () => number;
	private freeTries: number;
	private maxDelayMs: number;
	private forgetMs: number;

	constructor(
		options: {
			now?: () => number;
			/** Failures allowed before any wait. */
			freeTries?: number;
			maxDelayMs?: number;
			/** A key with no failure for this long starts over. */
			forgetMs?: number;
		} = {},
	) {
		this.now = options.now ?? Date.now;
		this.freeTries = options.freeTries ?? 5;
		this.maxDelayMs = options.maxDelayMs ?? 15 * 60 * 1000;
		this.forgetMs = options.forgetMs ?? 60 * 60 * 1000;
	}

	/** How long to wait before trying again, in milliseconds; 0 for now. */
	wait(key: string): number {
		const entry = this.entries.get(key);
		if (!entry) return 0;
		const now = this.now();
		if (now - entry.lastAt > this.forgetMs) {
			this.entries.delete(key);
			return 0;
		}
		return Math.max(0, entry.nextAt - now);
	}

	fail(key: string): void {
		const now = this.now();
		const entry = this.entries.get(key);
		const failures =
			entry && now - entry.lastAt <= this.forgetMs ? entry.failures + 1 : 1;
		const over = failures - this.freeTries;
		const delay =
			over > 0 ? Math.min(1000 * 2 ** (over - 1), this.maxDelayMs) : 0;
		this.entries.set(key, { failures, nextAt: now + delay, lastAt: now });
		if (this.entries.size > 10_000) this.forget(now);
	}

	succeed(key: string): void {
		this.entries.delete(key);
	}

	private forget(now: number): void {
		for (const [key, entry] of this.entries) {
			if (now - entry.lastAt > this.forgetMs) this.entries.delete(key);
		}
	}
}
