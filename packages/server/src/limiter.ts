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
	private maxKeys: number;

	constructor(
		options: {
			now?: () => number;
			/** Failures allowed before tries must wait. */
			freeTries?: number;
			maxDelayMs?: number;
			/** A key with no failure for this long starts over. */
			forgetMs?: number;
			/** Keys kept at most; the least recently failed go first. */
			maxKeys?: number;
		} = {},
	) {
		this.now = options.now ?? Date.now;
		this.freeTries = options.freeTries ?? 5;
		this.maxDelayMs = options.maxDelayMs ?? 15 * 60 * 1000;
		this.forgetMs = options.forgetMs ?? 60 * 60 * 1000;
		this.maxKeys = options.maxKeys ?? 10_000;
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
		this.set(key, failures, now);
	}

	/** Takes back a failure counted before the try, which did not fail. */
	refund(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		if (entry.failures <= 1) {
			this.entries.delete(key);
			return;
		}
		this.set(key, entry.failures - 1, entry.lastAt);
	}

	private set(key: string, failures: number, at: number): void {
		// Once the free tries are used up, each further try waits.
		const over = failures - this.freeTries + 1;
		const delay =
			over > 0 ? Math.min(1000 * 2 ** (over - 1), this.maxDelayMs) : 0;
		// Moved to the end: the map's order is the order of last use.
		this.entries.delete(key);
		this.entries.set(key, { failures, nextAt: at + delay, lastAt: at });
		while (this.entries.size > this.maxKeys) {
			const oldest = this.entries.keys().next().value as string;
			this.entries.delete(oldest);
		}
	}

	succeed(key: string): void {
		this.entries.delete(key);
	}
}
