import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent } from "../provider";
import { GpuLock } from "./gpu";
import type { Spawn } from "./provider";
import { WarmEngines, type WarmRequest } from "./warm";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const request: WarmRequest = {
	video: false,
	prompt: "a fox",
	width: 512,
	height: 512,
	seed: 7,
	steps: 4,
	cfgScale: 1,
};

/** A fake engine server: each process says it listens, then runs until killed. */
function fakeServers(options: { failToStart?: boolean } = {}) {
	const started: string[][] = [];
	const killed: string[][] = [];
	const spawn: Spawn = (argv) => {
		started.push(argv);
		let exit: (code: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			exit = resolve;
		});
		async function* output() {
			if (options.failToStart) {
				yield "[E] failed to load model";
				exit(1);
				return;
			}
			yield "[I] listening on: http://127.0.0.1:1";
			await exited;
		}
		return {
			output: output(),
			exited,
			kill: () => {
				killed.push(argv);
				exit(0);
			},
		};
	};
	return { spawn, started, killed };
}

/** A fake server API: a job runs its steps over a few polls, then completes. */
function fakeApi(
	options: { steps?: number; fail?: string; preview?: boolean } = {},
) {
	const calls: string[] = [];
	const bodies: unknown[] = [];
	let polls = 0;
	const steps = options.steps ?? 2;
	const fetch = async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname;
		calls.push(`${init?.method ?? "GET"} ${path}`);
		if (path === "/sdcpp/v1/img_gen") {
			polls = 0;
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({ id: "job1" }, { status: 202 });
		}
		if (path.endsWith("/cancel"))
			return Response.json({ cancel_requested: true });
		polls++;
		if (options.fail) {
			return Response.json({
				status: "failed",
				error: { message: options.fail },
			});
		}
		if (polls <= steps) {
			return Response.json({
				status: "generating",
				progress: { completed: polls, total: steps, unit: "steps" },
				...(options.preview && {
					preview: {
						step: polls,
						b64_json: Buffer.from(PNG).toString("base64"),
					},
				}),
			});
		}
		return Response.json({
			status: "completed",
			result: { images: [{ b64_json: Buffer.from(PNG).toString("base64") }] },
		});
	};
	return { fetch, calls, bodies };
}

async function collect(
	events: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const all: ProviderEvent[] = [];
	for await (const event of events) all.push(event);
	return all;
}

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

const engines = (spawn: Spawn, fetch: ReturnType<typeof fakeApi>["fetch"]) =>
	new WarmEngines({ spawn, fetch, freePort: async () => 4242, idleMs: 60_000 });

describe("warm engines", () => {
	test("load the model once and keep it for the next picture", async () => {
		const servers = fakeServers();
		const api = fakeApi();
		const warm = engines(servers.spawn, api.fetch);
		const signal = new AbortController().signal;

		const first = await collect(
			warm.run("sdxl:fp16", ["sd-server", "-m", "/m"], request, signal),
		);
		expect(first[0]).toMatchObject({ type: "progress", stage: "loading" });
		expect(
			first.filter((e) => e.type === "progress" && e.stage === "generating"),
		).toEqual([
			{
				type: "progress",
				fraction: 0.5,
				message: "Generating",
				stage: "generating",
				step: 1,
				steps: 2,
			},
			{
				type: "progress",
				fraction: 1,
				message: "Generating",
				stage: "generating",
				step: 2,
				steps: 2,
			},
		]);
		expect(first.at(-1)).toEqual({
			type: "completed",
			outputs: [{ data: PNG, mime: "image/png" }],
			costUsd: 0,
		});

		const second = await collect(
			warm.run("sdxl:fp16", ["sd-server", "-m", "/m"], request, signal),
		);
		expect(
			second.some((e) => e.type === "progress" && e.stage === "loading"),
		).toBe(false);
		expect(servers.started).toEqual([
			[
				"sd-server",
				"-m",
				"/m",
				"--listen-ip",
				"127.0.0.1",
				"--listen-port",
				"4242",
			],
		]);
		expect(api.bodies[0]).toMatchObject({
			prompt: "a fox",
			width: 512,
			seed: 7,
			sample_params: { sample_steps: 4, guidance: { txt_cfg: 1 } },
		});
		warm.stop();
	});

	test("unload one model before loading another", async () => {
		const servers = fakeServers();
		const warm = engines(servers.spawn, fakeApi().fetch);
		const signal = new AbortController().signal;
		await collect(warm.run("a:v", ["sd-server", "-m", "/a"], request, signal));
		await collect(warm.run("b:v", ["sd-server", "-m", "/b"], request, signal));
		expect(servers.killed.map((argv) => argv[2])).toEqual(["/a"]);
		expect(warm.loaded).toBe("b:v");
		warm.stop();
		expect(warm.loaded).toBeNull();
	});

	test("a loaded model keeps its memory reserved until another job wants it", async () => {
		const root = await mkdtemp(join(tmpdir(), "hatchlight-gpu-"));
		roots.push(root);
		const GB = 2 ** 30;
		const gpu = new GpuLock({
			root,
			capacity: async () => 12 * GB,
			pollMs: 5,
		});
		const warm = new WarmEngines({
			spawn: fakeServers().spawn,
			fetch: fakeApi().fetch,
			freePort: async () => 4242,
			idleMs: 60_000,
			gpu,
		});
		const signal = new AbortController().signal;
		await collect(warm.run("sdxl:v", ["sd-server"], request, signal, 8 * GB));
		expect(warm.loaded).toBe("sdxl:v");
		expect(gpu.reserved).toBe(8 * GB);
		// A video needing 7 GB does not fit beside it: the idle model goes.
		const video = gpu.acquire(7 * GB, signal);
		let next = await video.next();
		while (!next.done) next = await video.next();
		expect(warm.loaded).toBeNull();
		expect(gpu.reserved).toBe(7 * GB);
		gpu.close();
	});

	test("tells what an unloaded model held once the next one has the GPU, and not when the loaded one is reused", async () => {
		const root = await mkdtemp(join(tmpdir(), "hatchlight-gpu-"));
		roots.push(root);
		const GB = 2 ** 30;
		const gpu = new GpuLock({ root, capacity: async () => 12 * GB });
		const warm = new WarmEngines({
			spawn: fakeServers().spawn,
			fetch: fakeApi().fetch,
			freePort: async () => 4242,
			idleMs: 60_000,
			gpu,
		});
		const signal = new AbortController().signal;
		const seen: [string, number, number][] = [];
		const acquired = (name: string) =>
			async function* (released: number): AsyncIterable<ProviderEvent> {
				seen.push([name, released, gpu.reserved]);
				yield { type: "progress", message: name };
			};
		await collect(
			warm.run("a", ["sd-server"], request, signal, 4 * GB, acquired("a")),
		);
		await collect(
			warm.run("a", ["sd-server"], request, signal, 4 * GB, acquired("again")),
		);
		await collect(
			warm.run("b", ["sd-server"], request, signal, 5 * GB, acquired("b")),
		);
		// Called after the memory is reserved; never for the model reused.
		expect(seen).toEqual([
			["a", 0, 4 * GB],
			["b", 4 * GB, 5 * GB],
		]);
		gpu.close();
	});

	test("a model failing to load gives its memory back", async () => {
		const root = await mkdtemp(join(tmpdir(), "hatchlight-gpu-"));
		roots.push(root);
		const gpu = new GpuLock({ root, capacity: async () => 2 ** 34 });
		const warm = new WarmEngines({
			spawn: fakeServers({ failToStart: true }).spawn,
			fetch: fakeApi().fetch,
			freePort: async () => 4242,
			gpu,
		});
		await expect(
			collect(
				warm.run(
					"a:v",
					["sd-server"],
					request,
					new AbortController().signal,
					1,
				),
			),
		).rejects.toThrow();
		expect(gpu.reserved).toBe(0);
	});

	test("say why a server would not start, so the job can run another way", async () => {
		const warm = engines(
			fakeServers({ failToStart: true }).spawn,
			fakeApi().fetch,
		);
		await expect(
			collect(
				warm.run("a:v", ["sd-server"], request, new AbortController().signal),
			),
		).rejects.toThrow("failed to load model");
	});

	test("report the engine's own failure", async () => {
		const warm = engines(
			fakeServers().spawn,
			fakeApi({ fail: "out of memory" }).fetch,
		);
		const events = await collect(
			warm.run("a:v", ["sd-server"], request, new AbortController().signal),
		);
		expect(events.at(-1)).toEqual({
			type: "failed",
			error: "The engine stopped: out of memory",
			code: "engineStopped",
			params: { reason: "out of memory" },
			retry: { attempts: 2 },
		});
		warm.stop();
	});

	test("cancel the job on the server when the job is canceled", async () => {
		const api = fakeApi({ steps: 50 });
		const warm = engines(fakeServers().spawn, api.fetch);
		const controller = new AbortController();
		const events: ProviderEvent[] = [];
		for await (const event of warm.run(
			"a:v",
			["sd-server"],
			request,
			controller.signal,
		)) {
			events.push(event);
			if (event.type === "progress" && event.step === 2) controller.abort();
		}
		expect(api.calls).toContain("POST /sdcpp/v1/jobs/job1/cancel");
		expect(events.some((e) => e.type === "completed")).toBe(false);
		// The model stays loaded for the next picture.
		expect(warm.loaded).toBe("a:v");
		warm.stop();
	});
});

test("show the picture as it forms when asked", async () => {
	const api = fakeApi({ preview: true });
	const warm = engines(fakeServers().spawn, api.fetch);
	const events = await collect(
		warm.run(
			"a:v",
			["sd-server"],
			{ ...request, previewInterval: 1 },
			new AbortController().signal,
		),
	);
	expect(api.bodies[0]).toMatchObject({ preview: "vae", preview_interval: 1 });
	const shown = events.filter((e) => e.type === "progress" && e.preview);
	expect(shown).toHaveLength(2);
	expect(shown[0]).toMatchObject({
		step: 1,
		preview: { data: PNG, mime: "image/png" },
	});
	warm.stop();
});
