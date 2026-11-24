import { describe, expect, test } from "bun:test";
import {
	busyGpuMemory,
	type GpuMemory,
	parseGpuMemory,
	type RunCommand,
	readGpuMemory,
} from "../index";

const MIB = 1024 * 1024;
const GB = 2 ** 30;

/** Answers nvidia-smi with `out`; any other program is not installed. */
const smi =
	(out: string | null): RunCommand =>
	async ([name]) =>
		name === "nvidia-smi" ? out : null;

describe("free graphics memory", () => {
	test("reads free and total from nvidia-smi", async () => {
		expect(await readGpuMemory(smi("10240, 12282\n"))).toEqual({
			freeBytes: 10240 * MIB,
			totalBytes: 12282 * MIB,
		});
	});

	test("asks for the free and total memory only", async () => {
		const calls: string[][] = [];
		await readGpuMemory(async (argv) => {
			calls.push(argv);
			return "1, 2";
		});
		expect(calls).toEqual([
			[
				"nvidia-smi",
				"--query-gpu=memory.free,memory.total",
				"--format=csv,noheader,nounits",
			],
		]);
	});

	test("with several cards, the first is the one read", () => {
		expect(parseGpuMemory("100, 49140\n49000, 49140\n")).toEqual({
			freeBytes: 100 * MIB,
			totalBytes: 49140 * MIB,
		});
	});

	test("garbage, an empty answer, or no nvidia-smi is null", async () => {
		for (const out of [
			"",
			"\n",
			"No devices were found",
			"abc, def",
			"1, 2, 3",
			"12, ",
			"20000, 12000",
			"-5, 12000",
			"1.5, 12000",
			"[N/A], [N/A]",
			null,
		]) {
			expect(await readGpuMemory(smi(out))).toBeNull();
		}
	});

	test("a command that throws is null, not an error", async () => {
		expect(
			await readGpuMemory(async () => {
				throw new Error("spawn failed");
			}),
		).toBeNull();
	});
});

describe("busyGpuMemory", () => {
	const memory: GpuMemory = { freeBytes: 8 * GB, totalBytes: 12 * GB };

	test("is what the card holds when free memory is below what the model needs", () => {
		expect(busyGpuMemory(memory, 9 * GB)).toBe(4 * GB);
	});

	test("is null when the model fits, exactly or with room", () => {
		expect(busyGpuMemory(memory, 8 * GB)).toBeNull();
		expect(busyGpuMemory(memory, 2 * GB)).toBeNull();
	});

	test("counts memory this process already holds as free", () => {
		expect(busyGpuMemory(memory, 9 * GB, 2 * GB)).toBeNull();
		expect(busyGpuMemory(memory, 11 * GB, 2 * GB)).toBe(2 * GB);
	});

	test("is null when the free memory is unknown", () => {
		expect(busyGpuMemory(null, 9 * GB)).toBeNull();
	});
});
