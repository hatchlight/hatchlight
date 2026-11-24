import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import type { Gpu, Hardware } from "../types";

export type { Gpu, GpuVendor, Hardware } from "../types";

/** Runs a program and returns what it printed, or null if it could not run. */
export type RunCommand = (argv: string[]) => Promise<string | null>;

const runCommand: RunCommand = async (argv) => {
	try {
		const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => child.kill(), 5000);
		const [text, code] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		clearTimeout(timer);
		return code === 0 ? text : null;
	} catch {
		return null; // not installed
	}
};

const MIB = 1024 * 1024;

async function nvidia(run: RunCommand): Promise<Gpu[]> {
	const out = await run([
		"nvidia-smi",
		"--query-gpu=name,memory.total,driver_version",
		"--format=csv,noheader,nounits",
	]);
	return (out ?? "")
		.split("\n")
		.map((line) => line.split(",").map((field) => field.trim()))
		.filter(([name, memory]) => name && Number(memory) > 0)
		.map(([name, memory, driver]) => ({
			vendor: "nvidia",
			name: name as string,
			memoryBytes: Number(memory) * MIB,
			...(driver && { driver }),
		}));
}

/** How much of a GPU's memory is free right now, and how much it has. */
export interface GpuMemory {
	freeBytes: number;
	totalBytes: number;
}

/**
 * Reads `nvidia-smi --query-gpu=memory.free,memory.total` output, in MiB, one
 * line per card. The first card is the one models run on; null when the
 * output is not what was asked for.
 */
export function parseGpuMemory(out: string | null): GpuMemory | null {
	const line = out?.split("\n").find((l) => l.trim());
	if (!line) return null;
	const [free, total, ...rest] = line.split(",").map((field) => field.trim());
	if (rest.length > 0 || !free || !total) return null;
	if (!/^\d+$/.test(free) || !/^\d+$/.test(total)) return null;
	if (Number(total) <= 0 || Number(free) > Number(total)) return null;
	return { freeBytes: Number(free) * MIB, totalBytes: Number(total) * MIB };
}

/**
 * The first NVIDIA card's free and total memory, or null on any other card
 * or when it cannot be read. Never throws.
 */
export async function readGpuMemory(
	run: RunCommand = runCommand,
): Promise<GpuMemory | null> {
	try {
		return parseGpuMemory(
			await run([
				"nvidia-smi",
				"--query-gpu=memory.free,memory.total",
				"--format=csv,noheader,nounits",
			]),
		);
	} catch {
		return null;
	}
}

/** Apple silicon's GPU uses system memory; Metal can claim about three quarters. */
async function apple(run: RunCommand, memoryBytes: number): Promise<Gpu[]> {
	const brand = (
		await run(["sysctl", "-n", "machdep.cpu.brand_string"])
	)?.trim();
	if (!brand?.startsWith("Apple")) return [];
	return [
		{
			vendor: "apple",
			name: `${brand} GPU`,
			memoryBytes: Math.floor(memoryBytes * 0.75),
		},
	];
}

async function amd(run: RunCommand): Promise<Gpu[]> {
	const out = await run([
		"rocm-smi",
		"--showproductname",
		"--showmeminfo",
		"vram",
		"--json",
	]);
	if (!out) return [];
	try {
		const cards = JSON.parse(out) as Record<string, Record<string, string>>;
		return Object.values(cards).flatMap((card) => {
			const total = Number(card["VRAM Total Memory (B)"]);
			const name = card["Card Series"] ?? card["Card series"] ?? "AMD GPU";
			return total > 0
				? [{ vendor: "amd" as const, name, memoryBytes: total }]
				: [];
		});
	} catch {
		return [];
	}
}

export interface DetectOptions {
	run?: RunCommand;
	platform?: string;
	arch?: string;
	memoryBytes?: number;
	/** The text of /proc/version, which names Microsoft under WSL. */
	procVersion?: string;
	/** Whether this runs in a container, which tells /.dockerenv. */
	container?: boolean;
}

/** Finds out what this machine can run models on. */
export async function detectHardware(
	options: DetectOptions = {},
): Promise<Hardware> {
	const run = options.run ?? runCommand;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const memoryBytes = options.memoryBytes ?? totalmem();
	const procVersion =
		options.procVersion ??
		(platform === "linux"
			? await readFile("/proc/version", "utf8").catch(() => "")
			: "");

	const gpus =
		platform === "darwin"
			? await apple(run, memoryBytes)
			: [
					...(await nvidia(run)),
					...(platform === "linux" ? await amd(run) : []),
				];
	return {
		os:
			platform === "linux" || platform === "darwin" || platform === "win32"
				? platform
				: "other",
		arch: arch === "x64" || arch === "arm64" ? arch : "other",
		// A container on WSL's kernel (Docker Desktop) cannot start Windows
		// programs: it runs the Linux builds, as on any other Linux.
		wsl:
			platform === "linux" &&
			/microsoft/i.test(procVersion) &&
			!(
				options.container ??
				(existsSync("/.dockerenv") || existsSync("/run/.containerenv"))
			),
		memoryBytes,
		gpus,
	};
}
