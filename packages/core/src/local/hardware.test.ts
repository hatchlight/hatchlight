import { expect, test } from "bun:test";
import { detectHardware, type RunCommand } from "../index";

/** Answers each program with a canned output; others are not installed. */
const programs =
	(outputs: Record<string, string>): RunCommand =>
	async ([name]) =>
		outputs[name as string] ?? null;

const GB = 1024 ** 3;

test("a container on WSL's kernel is plain Linux: it cannot reach Windows", async () => {
	const hardware = await detectHardware({
		run: programs({
			"nvidia-smi": "NVIDIA GeForce RTX 4070 SUPER, 12282, 616.56\n",
		}),
		platform: "linux",
		arch: "x64",
		memoryBytes: 16 * GB,
		procVersion: "Linux version 6.18.58.1-microsoft-standard-WSL2",
		container: true,
	});
	expect(hardware.wsl).toBe(false);
	expect(hardware.gpus).toHaveLength(1);
});

test("an NVIDIA card under WSL", async () => {
	const hardware = await detectHardware({
		run: programs({
			"nvidia-smi": "NVIDIA GeForce RTX 4070 SUPER, 12282, 616.56\n",
		}),
		platform: "linux",
		arch: "x64",
		memoryBytes: 16 * GB,
		procVersion: "Linux version 6.18.58.1-microsoft-standard-WSL2",
		container: false,
	});
	expect(hardware).toEqual({
		os: "linux",
		arch: "x64",
		wsl: true,
		memoryBytes: 16 * GB,
		gpus: [
			{
				vendor: "nvidia",
				name: "NVIDIA GeForce RTX 4070 SUPER",
				memoryBytes: 12282 * 1024 * 1024,
				driver: "616.56",
			},
		],
	});
});

test("several NVIDIA cards, and none", async () => {
	const two = await detectHardware({
		run: programs({
			"nvidia-smi":
				"NVIDIA RTX A6000, 49140, 590.10\nNVIDIA RTX A6000, 49140, 590.10\n",
		}),
		platform: "win32",
		arch: "x64",
	});
	expect(two.gpus.map((gpu) => gpu.memoryBytes)).toEqual([
		49140 * 1024 * 1024,
		49140 * 1024 * 1024,
	]);
	expect(two.wsl).toBe(false);

	const none = await detectHardware({
		run: programs({}),
		platform: "linux",
		arch: "x64",
		procVersion: "Linux version 6.8.0-45-generic",
	});
	expect(none.gpus).toEqual([]);
	expect(none.wsl).toBe(false);
});

test("Apple silicon shares system memory with its GPU", async () => {
	const hardware = await detectHardware({
		run: programs({ sysctl: "Apple M3 Pro\n" }),
		platform: "darwin",
		arch: "arm64",
		memoryBytes: 36 * GB,
	});
	expect(hardware.gpus).toEqual([
		{ vendor: "apple", name: "Apple M3 Pro GPU", memoryBytes: 27 * GB },
	]);

	const intelMac = await detectHardware({
		run: programs({ sysctl: "Intel(R) Core(TM) i9-9980HK\n" }),
		platform: "darwin",
		arch: "x64",
	});
	expect(intelMac.gpus).toEqual([]);
});

test("an AMD card on Linux", async () => {
	const hardware = await detectHardware({
		run: programs({
			"rocm-smi": JSON.stringify({
				card0: {
					"Card Series": "Radeon RX 7900 XTX",
					"VRAM Total Memory (B)": String(24 * GB),
				},
			}),
		}),
		platform: "linux",
		arch: "x64",
		procVersion: "Linux version 6.8.0",
	});
	expect(hardware.gpus).toEqual([
		{ vendor: "amd", name: "Radeon RX 7900 XTX", memoryBytes: 24 * GB },
	]);
});

test("unreadable tool output is ignored, not trusted", async () => {
	const hardware = await detectHardware({
		run: programs({
			"nvidia-smi": "No devices were found\n",
			"rocm-smi": "not json",
		}),
		platform: "linux",
		arch: "x64",
		procVersion: "",
	});
	expect(hardware.gpus).toEqual([]);
});

test("this machine is detected without errors", async () => {
	const hardware = await detectHardware();
	expect(hardware.memoryBytes).toBeGreaterThan(0);
	for (const gpu of hardware.gpus) expect(gpu.memoryBytes).toBeGreaterThan(0);
});
