import { describe, expect, test } from "bun:test";
import { chooseBuild, type Hardware } from "@hatchlight/core";
import { builtinEngines } from "./engines";

const GB = 1024 ** 3;
const ENGINES = builtinEngines();
const builds = ENGINES.flatMap((engine) => engine.builds);

const machine = (over: Partial<Hardware> = {}): Hardware => ({
	os: "linux",
	arch: "x64",
	wsl: false,
	memoryBytes: 32 * GB,
	gpus: [],
	...over,
});
const nvidia = (driver: string) => ({
	vendor: "nvidia" as const,
	name: "GeForce RTX 4070",
	memoryBytes: 12 * GB,
	driver,
});
const pick = (engine: string, hardware: Hardware) =>
	chooseBuild(engine, builds, hardware)?.build.id;

describe("the Linux builds", () => {
	test("are tar.gz archives from Hatchlight's engines release", () => {
		const linux = builds.filter((build) => build.os === "linux");
		expect(linux.map((build) => build.id).sort()).toEqual([
			"llama-cpp-linux-x64-cpu",
			"sd-cpp-linux-x64-cpu",
			"sd-cpp-linux-x64-cuda",
		]);
		for (const build of linux) {
			expect(build.executable).not.toEndWith(".exe");
			for (const file of build.files) {
				expect(file.name).toEndWith(".tar.gz");
				expect(file.url).toBe(
					`https://github.com/hatchlight/hatchlight/releases/download/engines-master-1106-532d2c1-b12034/${file.name}`,
				);
				expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
				expect(file.size).toBeGreaterThan(0);
			}
		}
	});

	test("run CUDA on Linux with an NVIDIA card, and llama.cpp on the processor", () => {
		const gpu = machine({ gpus: [nvidia("570.124.06")] });
		expect(pick("sd-cpp", gpu)).toBe("sd-cpp-linux-x64-cuda");
		expect(pick("llama-cpp", gpu)).toBe("llama-cpp-linux-x64-cpu");
	});

	test("fall back to the processor when the driver is older than CUDA 12.8", () => {
		expect(pick("sd-cpp", machine({ gpus: [nvidia("550.54.15")] }))).toBe(
			"sd-cpp-linux-x64-cpu",
		);
	});

	test("run on the processor on Linux without a card", () => {
		expect(pick("sd-cpp", machine())).toBe("sd-cpp-linux-x64-cpu");
		expect(pick("llama-cpp", machine())).toBe("llama-cpp-linux-x64-cpu");
	});

	test("are never chosen under WSL: the Windows builds are", () => {
		for (const gpus of [[nvidia("616.56")], []]) {
			const wsl = machine({ wsl: true, gpus });
			for (const engine of ["sd-cpp", "llama-cpp"]) {
				const choice = chooseBuild(engine, builds, wsl);
				expect(choice?.build.os).toBe("win32");
				expect(choice?.throughWindows).toBe(true);
			}
		}
	});
});
