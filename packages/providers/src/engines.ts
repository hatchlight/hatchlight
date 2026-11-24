import type { EngineBuild, LocalEngineSpec } from "@hatchlight/core";

const SD_CPP_VERSION = "master-1106-532d2c1";

const release = (name: string) =>
	`https://github.com/leejet/stable-diffusion.cpp/releases/download/${SD_CPP_VERSION}/${name}`;

const archive = (name: string, size: number, sha256: string) => ({
	name,
	url: release(name),
	size,
	sha256,
});

const LLAMA_CPP_VERSION = "b12034";

/** The release where .github/workflows/engines.yml published the Linux builds. */
const ENGINES_RELEASE = `engines-${SD_CPP_VERSION}-${LLAMA_CPP_VERSION}`;

/** A tar.gz from that release: `size` and `sha256` from its .sha256 file. */
const linuxArchive = (name: string, size: number, sha256: string) => ({
	name,
	url: `https://github.com/hatchlight/hatchlight/releases/download/${ENGINES_RELEASE}/${name}`,
	size,
	sha256,
});

/**
 * Programs built with CUDA 12.8 need an NVIDIA driver from its first
 * release on: 570.26 on Linux.
 */
const CUDA_12_8_LINUX_DRIVER = "570.26";

const build = (
	backend: EngineBuild["backend"],
	os: EngineBuild["os"],
	arch: EngineBuild["arch"],
	files: EngineBuild["files"],
	extra: Partial<EngineBuild> = {},
): EngineBuild => ({
	id: `sd-cpp-${os}-${arch}-${backend}`,
	engine: "sd-cpp",
	version: SD_CPP_VERSION,
	backend,
	os,
	arch,
	files,
	executable: os === "win32" ? "sd-cli.exe" : "sd-cli",
	...extra,
});

/**
 * The engines that run local models, as official release builds. Sizes and
 * hashes are the ones GitHub reports for the release.
 *
 * stable-diffusion.cpp publishes no Linux build that runs on current LTS
 * distributions (they need glibc 2.43), nor a Linux CUDA build, so the Linux
 * builds are Hatchlight's own: .github/workflows/engines.yml
 * (scripts/build-engines.sh) makes them on Ubuntu 22.04 (glibc 2.35) and
 * publishes them in the release ENGINES_RELEASE, one tar.gz each. The `cuda`
 * one leaves out the CUDA 12 runtime (libcudart, libcublas, libnccl): the
 * nvidia/cuda runtime image that runs it provides it. Under WSL the Windows
 * builds are chosen (see chooseBuild).
 */
export function builtinEngines(): LocalEngineSpec[] {
	return [
		{
			id: "sd-cpp",
			name: "stable-diffusion.cpp",
			homepage: "https://github.com/leejet/stable-diffusion.cpp",
			license: "MIT",
			builds: [
				build(
					"cuda",
					"win32",
					"x64",
					[
						archive(
							"sd-master-532d2c1-bin-win-cuda12-x64.zip",
							412_365_497,
							"b087219145a382cc1b1e826318289e1f672b9bb6965977734ef0deb85fe2d03a",
						),
						archive(
							"cudart-sd-bin-win-cu12-x64.zip",
							563_452_046,
							"fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
						),
					],
					// CUDA 12 programs run on drivers from this release on.
					{ minNvidiaDriver: "527.41" },
				),
				build("rocm", "win32", "x64", [
					archive(
						"sd-master-532d2c1-bin-win-rocm-10.1.0-x64.zip",
						283_581_117,
						"b10fcc88f5a37adc1b63e0c1bd06fcbc8212340a68b96022b45d72e64c9e45a1",
					),
				]),
				build("vulkan", "win32", "x64", [
					archive(
						"sd-master-532d2c1-bin-win-vulkan-x64.zip",
						30_312_081,
						"3e66222c87ca27074e1fd8ce79706eef17a8aaf39949906aa1bee7e060f22ecc",
					),
				]),
				build("cpu", "win32", "x64", [
					archive(
						"sd-master-532d2c1-bin-win-cpu-x64.zip",
						18_358_541,
						"abef332cfca7861cc567910e79bedb70bfb2920bb4eedac97fcbb6db477f1596",
					),
				]),
				build(
					"cuda",
					"linux",
					"x64",
					[
						linuxArchive(
							`sd-cpp-${SD_CPP_VERSION}-linux-x64-cuda.tar.gz`,
							164_510_710,
							"63c94c099eb0b6ef0c17a329c144bcd3080ebf903f966b01f25895213cc6b845",
						),
					],
					{ minNvidiaDriver: CUDA_12_8_LINUX_DRIVER },
				),
				build("cpu", "linux", "x64", [
					linuxArchive(
						`sd-cpp-${SD_CPP_VERSION}-linux-x64-cpu.tar.gz`,
						25_169_126,
						"0af250d002d62af8463405d08693fe5e030564f1ee25b01595d5bdb2053c11f4",
					),
				]),
				build("metal", "darwin", "arm64", [
					archive(
						"sd-master-532d2c1-bin-Darwin-macOS-26.7.2-arm64.zip",
						38_331_254,
						"8146d6ffc75f8ff8f64b62a80fffee8fb714ab65e368e202084135fa07cc6f36",
					),
				]),
			],
		},
		LLAMA_CPP,
	];
}

/**
 * Runs the small language model that puts prompts into English. Only on the
 * processor, on purpose: a prompt is a few words, and the graphics card
 * stays for pictures. Under WSL the Windows build runs through it; the
 * Linux one comes from .github/workflows/engines.yml (see builtinEngines).
 */
const LLAMA_CPP: LocalEngineSpec = {
	id: "llama-cpp",
	name: "llama.cpp",
	homepage: "https://github.com/ggml-org/llama.cpp",
	license: "MIT",
	builds: [
		{
			id: "llama-cpp-win32-x64-cpu",
			engine: "llama-cpp",
			version: LLAMA_CPP_VERSION,
			backend: "cpu",
			os: "win32",
			arch: "x64",
			files: [
				{
					name: `llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip`,
					url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip`,
					size: 24_582_890,
					sha256:
						"16c38cd9ff7487bf118a37808784245a2d639d844110f21fe9b373aaa40ff511",
				},
			],
			// Keeps the model loaded between prompts; `llama-completion.exe`,
			// next to it, translates once where the server cannot be reached.
			executable: "llama-server.exe",
		},
		{
			id: "llama-cpp-linux-x64-cpu",
			engine: "llama-cpp",
			version: LLAMA_CPP_VERSION,
			backend: "cpu",
			os: "linux",
			arch: "x64",
			files: [
				linuxArchive(
					`llama-cpp-${LLAMA_CPP_VERSION}-linux-x64-cpu.tar.gz`,
					14_461_625,
					"bb514e30740c88c85944f26e773d1a984e66f7549d8cb74b5086fd67b5dafa01",
				),
			],
			// `llama-completion` and `llama-mtmd-cli` are next to it.
			executable: "llama-server",
		},
	],
};
