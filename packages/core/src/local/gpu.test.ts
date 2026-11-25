import { afterEach, describe, expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent } from "../provider";
import { type GpuHold, GpuLock } from "./gpu";

const GB = 2 ** 30;
const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function folder(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-gpu-"));
	dirs.push(dir);
	return dir;
}

/** A lock as another Hatchlight sharing `root` would have, polling fast. */
function lock(root: string, capacity: number | null = 12 * GB) {
	return new GpuLock({ root, capacity: async () => capacity, pollMs: 5 });
}

/** Acquires `bytes`, collecting what it says while it waits. */
async function acquire(
	gpu: GpuLock,
	bytes: number,
	options: { signal?: AbortSignal; onWanted?: () => void } = {},
): Promise<{ hold: GpuHold; events: ProviderEvent[] }> {
	const events: ProviderEvent[] = [];
	const it = gpu.acquire(
		bytes,
		options.signal ?? new AbortController().signal,
		{
			onWanted: options.onWanted,
		},
	);
	for (;;) {
		const next = await it.next();
		if (next.done) return { hold: next.value, events };
		events.push(next.value);
	}
}

/** Whether `promise` is still pending after a few polls. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await Bun.sleep(30);
	return !settled;
}

describe("GpuLock", () => {
	test("jobs that fit together run together", async () => {
		const root = await folder();
		const a = await acquire(lock(root), 7 * GB);
		const b = await acquire(lock(root), 4 * GB);
		expect(a.events).toEqual([]);
		expect(b.events).toEqual([]);
	});

	test("a job that does not fit waits for the memory, and says so", async () => {
		const root = await folder();
		const video = await acquire(lock(root), 7 * GB);
		const picture = acquire(lock(root), 8 * GB);
		expect(await pending(picture)).toBe(true);
		video.hold.release();
		const { events } = await picture;
		expect(events.map((e) => e.type === "progress" && e.stage)).toEqual([
			"waitingGpu",
		]);
	});

	test("in one process, reservations add up", async () => {
		const gpu = lock(await folder());
		await acquire(gpu, 8 * GB);
		const second = acquire(gpu, 8 * GB);
		expect(await pending(second)).toBe(true);
		expect(gpu.reserved).toBe(8 * GB);
	});

	test("a job alone runs even when larger than the GPU", async () => {
		const { events } = await acquire(lock(await folder()), 15 * GB);
		expect(events).toEqual([]);
	});

	test("without a known GPU, jobs run one at a time", async () => {
		const root = await folder();
		await acquire(lock(root, null), 1 * GB);
		expect(await pending(acquire(lock(root, null), 1 * GB))).toBe(true);
	});

	test("a holder that only keeps a model loaded is asked to let go", async () => {
		const root = await folder();
		const other = lock(root);
		let idle: GpuHold | null = null;
		idle = (
			await acquire(other, 8 * GB, {
				onWanted: () => idle?.release(),
			})
		).hold;
		// In this process, the waiter asks directly.
		const mine = await acquire(other, 8 * GB);
		expect(mine.events.length).toBe(1);
		expect(other.reserved).toBe(8 * GB);
	});

	test("another Hatchlight's holder hears the request through the folder", async () => {
		const root = await folder();
		const other = new GpuLock({
			root,
			capacity: async () => 12 * GB,
			heartbeatMs: 5,
		});
		let idle: GpuHold | null = null;
		idle = (
			await acquire(other, 8 * GB, {
				onWanted: () => idle?.release(),
			})
		).hold;
		const { events } = await acquire(lock(root), 8 * GB);
		expect(events.length).toBe(1);
		// The request is withdrawn once served.
		expect(
			(await readdir(join(root, "gpu"))).filter((f) => f.startsWith("wait-")),
		).toEqual([]);
	});

	test("the reservation of a Hatchlight that died stops counting", async () => {
		const root = await folder();
		await acquire(lock(root), 1 * GB);
		const dead = join(root, "gpu", "dead");
		await writeFile(dead, String(10 * GB));
		const old = new Date(Date.now() - 60_000);
		utimesSync(dead, old, old);
		const { events } = await acquire(lock(root), 8 * GB);
		expect(events).toEqual([]);
		expect(await readdir(join(root, "gpu"))).not.toContain("dead");
	});

	test("canceling stops the wait", async () => {
		const root = await folder();
		await acquire(lock(root), 8 * GB);
		const controller = new AbortController();
		const waiting = acquire(lock(root), 8 * GB, { signal: controller.signal });
		await Bun.sleep(20);
		controller.abort(new Error("canceled"));
		await expect(waiting).rejects.toThrow("canceled");
	});

	test("a job that comes later does not pass one that can run now", async () => {
		const root = await folder();
		const busy = await acquire(lock(root), 8 * GB);
		// Slow to look again, so the memory is free before it does.
		const slow = new GpuLock({
			root,
			capacity: async () => 12 * GB,
			pollMs: 200,
		});
		const video = acquire(slow, 7 * GB);
		await Bun.sleep(20);
		busy.hold.release();
		const picture = acquire(lock(root), 8 * GB);
		expect(await pending(picture)).toBe(true);
		const first = await video;
		first.hold.release();
		await picture;
	});

	test("a job may go ahead of one that could not run now anyway", async () => {
		const root = await folder();
		await acquire(lock(root), 8 * GB);
		const video = acquire(lock(root), 7 * GB);
		await Bun.sleep(20);
		// The video waits for the busy job; a small picture fits beside it.
		const { events } = await acquire(lock(root), 2 * GB);
		expect(events).toEqual([]);
		expect(await pending(video)).toBe(true);
	});

	test("a loaded model is not dropped for a job that still would not fit", async () => {
		const root = await folder();
		const busy = lock(root);
		await acquire(busy, 8 * GB);
		const idle = new GpuLock({
			root,
			capacity: async () => 12 * GB,
			heartbeatMs: 5,
		});
		let dropped = false;
		await acquire(idle, 2 * GB, { onWanted: () => (dropped = true) });
		// 8 + 7 does not fit even without the 2 GB model.
		const video = acquire(lock(root), 7 * GB);
		await Bun.sleep(40);
		expect(dropped).toBe(false);
		expect(idle.wanted(2 * GB)).toBe(false);
		expect(await pending(video)).toBe(true);
		idle.close();
	});

	test("a reservation another process removed comes back with the next beat", async () => {
		const root = await folder();
		const gpu = new GpuLock({
			root,
			capacity: async () => 12 * GB,
			heartbeatMs: 5,
		});
		await acquire(gpu, 8 * GB);
		const others = () => readdir(join(root, "gpu"));
		const mine = (await others()).find((f) => !f.startsWith("clock-")) ?? "";
		await rm(join(root, "gpu", mine));
		await Bun.sleep(30);
		expect(await others()).toContain(mine);
		expect(await pending(acquire(lock(root), 8 * GB))).toBe(true);
		gpu.close();
	});

	test("a reservation caught while being rewritten counts as the whole GPU", async () => {
		const root = await folder();
		await acquire(lock(root), 1 * GB);
		await writeFile(join(root, "gpu", "rewriting"), "");
		expect(await pending(acquire(lock(root), 1 * GB))).toBe(true);
	});

	test("a reservation caught while being rewritten is read again for what others reserve", async () => {
		const root = await folder();
		const file = join(root, "gpu", "rewriting");
		await mkdir(join(root, "gpu"), { recursive: true });
		await writeFile(file, "");
		setTimeout(() => writeFileSync(file, String(2 * GB)), 10);
		expect(await lock(root).othersReserved()).toBe(2 * GB);
	});

	test("a reservation that stays unreadable counts as the whole GPU for what others reserve", async () => {
		const root = await folder();
		await mkdir(join(root, "gpu"), { recursive: true });
		await writeFile(join(root, "gpu", "rewriting"), "");
		expect(await lock(root).othersReserved()).toBe(Infinity);
	});

	test("a canceled wait withdraws its request", async () => {
		const root = await folder();
		const holder = lock(root);
		await acquire(holder, 8 * GB);
		const controller = new AbortController();
		const waiting = acquire(lock(root), 8 * GB, { signal: controller.signal });
		await Bun.sleep(20);
		expect(holder.wanted(8 * GB)).toBe(true);
		controller.abort(new Error("canceled"));
		await expect(waiting).rejects.toThrow("canceled");
		expect(holder.wanted(8 * GB)).toBe(false);
	});

	test("a GPU that cannot be detected runs jobs one at a time", async () => {
		const root = await folder();
		const broken = () =>
			new GpuLock({
				root,
				capacity: () => Promise.reject(new Error("no driver")),
				pollMs: 5,
			});
		await acquire(broken(), 1 * GB);
		expect(await pending(acquire(broken(), 1 * GB))).toBe(true);
	});

	test("releasing twice gives back once, and close gives back all", async () => {
		const gpu = lock(await folder());
		const a = await acquire(gpu, 2 * GB);
		await acquire(gpu, 3 * GB);
		a.hold.release();
		a.hold.release();
		expect(gpu.reserved).toBe(3 * GB);
		gpu.close();
		expect(gpu.reserved).toBe(0);
	});
});
