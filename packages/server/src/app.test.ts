import { afterEach, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rename,
	rm,
	stat,
	utimes,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatModel,
	type ChatReply,
	CodedError,
	FakeProvider,
	LEGACY_NAME,
	type LocalEngineSpec,
	type LocalModelSpec,
	parseConsistency,
} from "@hatchlight/core";
import { picture, safetensors, zip } from "@hatchlight/core/testing";
import type { AssistantView, ConsistencyResult } from "@hatchlight/core/types";
import {
	createApp,
	createRuntime,
	DataDirInUseError,
	databaseFile,
	lockDataDir,
	type Runtime,
	type RuntimeOptions,
} from "./index";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const WEIGHTS = new TextEncoder().encode("the weights of a small model");
const ENGINE = zip([{ name: "run", data: new TextEncoder().encode("run") }]);
const hash = (data: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(data).digest("hex");
const ENGINES: LocalEngineSpec[] = [
	{
		id: "run",
		name: "Runner",
		homepage: "https://engine.example",
		license: "MIT",
		builds: [
			{
				id: "run-cpu",
				engine: "run",
				version: "1",
				backend: "cpu",
				os: "linux",
				arch: "x64",
				executable: "run",
				files: [
					{
						name: "run.zip",
						url: "https://models.example/run.zip",
						size: ENGINE.byteLength,
						sha256: hash(ENGINE),
					},
				],
			},
		],
	},
];
const LOCAL_MODEL: LocalModelSpec = {
	id: "tiny",
	name: "Tiny",
	author: "Example",
	media: "image",
	tasks: ["text-to-image"],
	summary: "A model for tests.",
	license: "MIT",
	licenseUrl: "https://license.example",
	commercial: { kind: "allowed" },
	homepage: "https://models.example",
	variants: [
		{
			id: "full",
			label: "Full",
			engine: "run",
			memoryBytes: 1,
			files: [
				{
					name: "tiny.safetensors",
					url: "https://models.example/tiny.safetensors",
					size: WEIGHTS.byteLength,
					sha256: hash(WEIGHTS),
					role: "model",
				},
			],
		},
	],
	demos: [{ url: "https://models.example/demo.png", media: "image" }],
	defaults: { size: 512, aspectRatios: ["1:1"], steps: 1, cfgScale: 1 },
};
/** Stands in for the hosts models and their demos are downloaded from. */
const download = async (url: string) =>
	new Response(
		url.endsWith(".png") ? PNG : url.endsWith(".zip") ? ENGINE : WEIGHTS,
	);

async function setup(options: Partial<RuntimeOptions> = {}) {
	// A nested path that does not exist yet, as on a first run.
	const root = await mkdtemp(join(tmpdir(), "hatchlight-server-"));
	const dir = join(root, "data", "hatchlight");
	const provider = new FakeProvider();
	const runtime: Runtime = await createRuntime({
		dataDir: dir,
		providers: [provider],
		localModels: [LOCAL_MODEL],
		engines: ENGINES,
		hardware: async () => ({
			os: "linux",
			arch: "x64",
			wsl: false,
			memoryBytes: 8 * 1024 ** 3,
			gpus: [],
		}),
		// The test engine is not a real program.
		checkEngine: async () => null,
		fetch: download,
		...options,
	});
	cleanups.push(async () => {
		await runtime.engine.idle();
		runtime.close();
		await rm(root, { recursive: true });
	});
	await runtime.start();
	const app = createApp(runtime);
	const call = (path: string, init?: RequestInit) =>
		app.request(`http://localhost:4096${path}`, init);
	const post = (path: string, body: unknown, method = "POST") =>
		call(path, {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	return { call, post, runtime, provider, dir };
}

test("a turn is created, runs, and shows up in its session", async () => {
	const { call, post, runtime } = await setup();
	expect(((await (await call("/api/models")).json()) as unknown[]).length).toBe(
		2,
	);

	const created = await post("/api/turns", {
		prompt: "a red fox",
		modelIds: ["fake/alpha", "fake/beta"],
	});
	expect(created.status).toBe(201);
	const { session } = (await created.json()) as { session: { id: string } };
	await runtime.engine.idle();

	const sessions = (await (await call("/api/sessions")).json()) as unknown[];
	expect(sessions).toHaveLength(1);
	const detail = (await (await call(`/api/sessions/${session.id}`)).json()) as {
		turns: { jobs: { status: string; assets: { id: string }[] }[] }[];
	};
	const jobs = detail.turns[0]?.jobs ?? [];
	expect(jobs.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);

	const image = await call(`/api/assets/${jobs[0]?.assets[0]?.id}`);
	expect(image.status).toBe(200);
	expect(image.headers.get("content-type")).toBe("image/bmp");
	// Stored files come from providers; they must never run as a page.
	expect(image.headers.get("content-security-policy")).toBe("sandbox");
	expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);

	const gallery = (await (
		await call("/api/gallery?query=fox")
	).json()) as unknown[];
	expect(gallery).toHaveLength(2);

	expect(
		(await call(`/api/sessions/${session.id}`, { method: "DELETE" })).status,
	).toBe(204);
	expect((await call(`/api/sessions/${session.id}`)).status).toBe(404);
});

test("the best of a comparison is picked, cleared and ranked", async () => {
	const { call, post, runtime } = await setup();
	const created = await post("/api/turns", {
		prompt: "a red fox",
		modelIds: ["fake/alpha", "fake/beta"],
	});
	const { session, turn } = (await created.json()) as {
		session: { id: string };
		turn: { id: string };
	};
	await runtime.engine.idle();
	const detail = async () =>
		(await (await call(`/api/sessions/${session.id}`)).json()) as {
			turns: {
				pickedAssetId: string | null;
				jobs: { assets: { id: string }[] }[];
			}[];
		};
	const assetId = (await detail()).turns[0]?.jobs[0]?.assets[0]?.id;
	const pick = (body: unknown) =>
		post(`/api/turns/${turn.id}/pick`, body, "PUT");

	expect((await pick({ assetId })).status).toBe(204);
	expect((await detail()).turns[0]?.pickedAssetId).toBe(assetId);
	const ranking = (await (
		await call("/api/ranking?media=image&period=30d&kind=all")
	).json()) as { comparisons: number; models: { modelId: string }[] };
	expect(ranking.comparisons).toBe(1);
	expect(ranking.models[0]?.modelId).toBe("fake/alpha");

	expect((await pick({ assetId: null })).status).toBe(204);
	expect((await detail()).turns[0]?.pickedAssetId).toBeNull();

	for (const body of [{}, { assetId: 3 }]) {
		expect((await pick(body)).status).toBe(400);
	}
	expect(
		(await post("/api/turns/trn_nope/pick", { assetId }, "PUT")).status,
	).toBe(404);
	for (const query of ["media=sound", "period=week", "kind=cats"]) {
		expect((await call(`/api/ranking?${query}`)).status).toBe(400);
	}
});

test("characters and styles are kept, used by a turn, and keep their pictures", async () => {
	const { call, post, runtime } = await setup();
	const upload = await call("/api/assets", {
		method: "POST",
		body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]),
	});
	const picture = (await upload.json()) as { id: string };
	const created = await post("/api/library", {
		kind: "character",
		name: "Rex",
		pictureIds: [picture.id],
		prompt: "a corgi",
	});
	expect(created.status).toBe(201);
	const rex = (await created.json()) as { id: string; name: string };
	expect(
		(await post("/api/library", { kind: "character", name: "REX" })).status,
	).toBe(400);
	expect(
		(await post("/api/library", { kind: "dragon", name: "x" })).status,
	).toBe(400);
	const renamed = await post(
		`/api/library/${rex.id}`,
		{
			kind: "character",
			name: "Rex",
			pictureIds: [picture.id],
			prompt: "a dog",
		},
		"PUT",
	);
	expect(((await renamed.json()) as { prompt: string }).prompt).toBe("a dog");
	expect(
		((await (await call("/api/library")).json()) as { id: string }[]).map(
			(e) => e.id,
		),
	).toEqual([rex.id]);

	const turn = await post("/api/turns", {
		prompt: "Rex in the snow",
		modelIds: ["fake/alpha"],
		characterId: rex.id,
	});
	expect(turn.status).toBe(201);
	const { turn: made } = (await turn.json()) as {
		turn: {
			jobs: { params: { prompt: string; referenceAssetIds: string[] } }[];
		};
	};
	expect(made.jobs[0]?.params).toMatchObject({
		prompt: "the person in picture 1 in the snow, a dog",
		referenceAssetIds: [picture.id],
	});
	await runtime.engine.idle();

	const kept = await call(`/api/assets/${picture.id}`, { method: "DELETE" });
	expect(kept.status).toBe(400);
	expect(((await kept.json()) as { code: string }).code).toBe(
		"pictureInLibrary",
	);
	expect(
		(await call(`/api/library/${rex.id}`, { method: "DELETE" })).status,
	).toBe(204);
	expect(
		(await call(`/api/library/${rex.id}`, { method: "DELETE" })).status,
	).toBe(404);
	expect(
		(await call(`/api/assets/${picture.id}`, { method: "DELETE" })).status,
	).toBe(204);
	const gone = await post("/api/turns", {
		prompt: "Rex",
		modelIds: ["fake/alpha"],
		characterId: rex.id,
	});
	expect(gone.status).toBe(404);
});

test("hiding model names until a pick is a person's choice", async () => {
	const { call, post } = await setup();
	expect(
		((await (await call("/api/settings")).json()) as { blindPicks: boolean })
			.blindPicks,
	).toBe(false);
	const set = await post("/api/settings", { blindPicks: true }, "PUT");
	expect(((await set.json()) as { blindPicks: boolean }).blindPicks).toBe(true);
	expect(
		(await post("/api/settings", { blindPicks: "yes" }, "PUT")).status,
	).toBe(400);
});

test("invalid requests get a 400 with the reason", async () => {
	const { post, call } = await setup();
	for (const body of [
		{ prompt: "x", modelIds: [] },
		{ prompt: "x", modelIds: ["nope/x"] },
		{ prompt: "", modelIds: ["fake/alpha"] },
		{ prompt: "x", modelIds: "fake/alpha" },
		{ prompt: "x", modelIds: ["fake/alpha"], count: "many" },
		[],
	]) {
		const response = await post("/api/turns", body);
		expect(response.status).toBe(400);
		expect(typeof ((await response.json()) as { error: string }).error).toBe(
			"string",
		);
	}
	const unknown = await post("/api/turns", {
		prompt: "x",
		modelIds: ["nope/x"],
	});
	expect(await unknown.json()).toEqual({
		error: "Unknown model: nope/x",
		code: "unknownModel",
		params: { model: "nope/x" },
	});
	expect((await call("/api/gallery?limit=0")).status).toBe(400);
	expect((await call("/api/gallery?before=5")).status).toBe(400);
	expect((await call("/api/sessions/missing")).status).toBe(404);
	expect((await call("/api/nothing-here")).status).toBe(404);
	expect(
		(await call("/api/jobs/missing/cancel", { method: "POST" })).status,
	).toBe(404);
});

test("uploads are stored and usable as references", async () => {
	const { call, post, runtime } = await setup();
	const upload = await call("/api/assets", {
		method: "POST",
		headers: { "content-type": "image/png" },
		body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
	});
	expect(upload.status).toBe(201);
	const asset = (await upload.json()) as { id: string; mime: string };
	expect(asset.mime).toBe("image/png");

	const turn = await post("/api/turns", {
		prompt: "restyle",
		modelIds: ["fake/alpha"],
		referenceAssetIds: [asset.id],
	});
	expect(turn.status).toBe(201);
	await runtime.engine.idle();

	const rejected = await call("/api/assets", {
		method: "POST",
		// The claimed type is ignored; the bytes decide.
		headers: { "content-type": "image/png" },
		body: "<script>",
	});
	expect(rejected.status).toBe(400);
});

test("keys can be set and removed but are never sent back", async () => {
	const { call, post } = await setup();
	expect(
		(await post("/api/providers/fake/key", { key: "s3cret" }, "PUT")).status,
	).toBe(204);
	const text = await (await call("/api/providers")).text();
	expect(JSON.parse(text)[0].hasKey).toBe(true);
	expect(text).not.toContain("s3cret");
	expect(
		(await call("/api/providers/fake/key", { method: "DELETE" })).status,
	).toBe(204);
	expect(
		(await post("/api/providers/nope/key", { key: "x" }, "PUT")).status,
	).toBe(404);
});

test("requests from other websites or hosts are refused", async () => {
	const { call, runtime } = await setup();
	const crossSite = await call("/api/turns", {
		method: "POST",
		headers: { origin: "https://evil.example", "content-type": "text/plain" },
		body: JSON.stringify({ prompt: "x", modelIds: ["fake/alpha"] }),
	});
	expect(crossSite.status).toBe(403);

	const rebound = await createApp(runtime).request(
		"http://evil.example/api/models",
	);
	expect(rebound.status).toBe(403);

	// Sandboxed frames and file:// pages send a literal "null" origin.
	const opaque = await call("/api/models", { headers: { origin: "null" } });
	expect(opaque.status).toBe(403);

	const sameOrigin = await call("/api/models", {
		headers: { origin: "http://localhost:4096" },
	});
	expect(sameOrigin.status).toBe(200);

	const dev = await createApp({
		...runtime,
		allowedOrigins: ["http://localhost:5173"],
	}).request("http://localhost:4096/api/models", {
		headers: { origin: "http://localhost:5173" },
	});
	expect(dev.status).toBe(200);
});

test("a personal install says so", async () => {
	const { call } = await setup();
	expect(await (await call("/api/server")).json()).toEqual({
		mode: "personal",
		secure: false,
	});
	expect(await (await call("/api/health")).json()).toEqual({ ok: true });
});

test("every answer carries the security headers", async () => {
	const { call } = await setup();
	const page = await call("/api/models");
	expect(page.headers.get("content-security-policy")).toContain(
		"frame-ancestors 'none'",
	);
	expect(page.headers.get("x-frame-options")).toBe("DENY");
	expect(page.headers.get("referrer-policy")).toBe("no-referrer");
	expect(page.headers.get("x-content-type-options")).toBe("nosniff");
	expect(page.headers.get("permissions-policy")).toContain("camera=()");
	// Plain http on loopback: no HSTS.
	expect(page.headers.get("strict-transport-security")).toBeNull();
	// Refusals too.
	const refused = await createApp((await setup()).runtime).request(
		"http://evil.example/api/models",
	);
	expect(refused.headers.get("x-frame-options")).toBe("DENY");
	// Stored files keep their own, stricter policy.
	const upload = await call("/api/assets", {
		method: "POST",
		headers: { "content-type": "image/png" },
		body: PNG,
	});
	const { id } = (await upload.json()) as { id: string };
	const file = await call(`/api/assets/${id}`);
	expect(file.headers.get("content-security-policy")).toBe("sandbox");
	expect(file.headers.get("x-frame-options")).toBe("DENY");
});

/** The owner a lock file names, in either of its formats. */
async function lockPid(path: string): Promise<number> {
	const text = await Bun.file(path).text();
	return text.startsWith("{") ? JSON.parse(text).pid : Number(text);
}

/** A live process that is not this one, for as long as the test runs. */
function otherProcess(): number {
	const child = Bun.spawn(["sleep", "60"]);
	cleanups.push(async () => {
		child.kill();
		await child.exited;
	});
	return child.pid;
}

test("a personal install answers only connections from this computer", async () => {
	const { runtime } = await setup();
	const app = createApp(runtime);
	// Host can be forged; the connection's address cannot.
	const from = (peer: string) =>
		app.request("http://localhost:4096/api/models", {}, { peer });
	const refused = await from("192.168.1.9");
	expect(refused.status).toBe(403);
	expect(await refused.json()).toEqual({ error: "Forbidden address" });
	expect((await from("::ffff:10.0.0.4")).status).toBe(403);
	expect((await from("127.0.0.1")).status).toBe(200);
	expect((await from("::1")).status).toBe(200);
	expect((await from("::ffff:127.0.0.1")).status).toBe(200);
});

test("a second process cannot take over a data directory in use", async () => {
	const { dir, runtime, post } = await setup();
	runtime.engine.subscribe(() => {});
	await expect(
		createRuntime({ dataDir: dir, providers: [new FakeProvider()] }),
	).rejects.toBeInstanceOf(DataDirInUseError);

	// The first process is untouched and still runs jobs.
	const created = await post("/api/turns", {
		prompt: "x",
		modelIds: ["fake/alpha"],
	});
	expect(created.status).toBe(201);
});

test.skipIf(process.platform === "win32")(
	"the data directory and the database are readable by their owner only",
	async () => {
		// One made by an older version, open to everyone, as a bind mount is.
		const root = await mkdtemp(join(tmpdir(), "hatchlight-private-"));
		cleanups.push(() => rm(root, { recursive: true }));
		const dir = join(root, "data");
		await mkdir(dir, { mode: 0o755 });
		await chmod(dir, 0o755);
		const db = databaseFile(dir);
		await Bun.write(db, "");
		await Bun.write(`${db}-wal`, "");
		await chmod(db, 0o644);
		await chmod(`${db}-wal`, 0o644);
		const runtime = await createRuntime({
			dataDir: dir,
			providers: [new FakeProvider()],
		});
		runtime.close();
		const mode = async (path: string) => (await stat(path)).mode & 0o777;
		expect(await mode(dir)).toBe(0o700);
		expect(await mode(db)).toBe(0o600);
		expect(await mode(`${db}-wal`)).toBe(0o600);

		// A new one is made private from the start.
		const fresh = join(root, "fresh");
		const again = await createRuntime({
			dataDir: fresh,
			providers: [new FakeProvider()],
		});
		again.close();
		expect(await mode(fresh)).toBe(0o700);
		expect(await mode(databaseFile(fresh))).toBe(0o600);
	},
);

/** Makes a file look written before this machine started. */
async function beforeBoot(path: string) {
	const long = new Date("2000-01-01T00:00:00Z");
	await utimes(path, long, long);
}

test("a bare process id from before this machine started is taken over", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	await Bun.write(join(root, "hatchlight.lock"), "2147483646");
	await beforeBoot(join(root, "hatchlight.lock"));
	const runtime = await createRuntime({
		dataDir: root,
		providers: [new FakeProvider()],
	});
	const lock = JSON.parse(await Bun.file(join(root, "hatchlight.lock")).text());
	expect(lock).toMatchObject({ pid: process.pid, host: hostname() });
	expect(typeof lock.startedAt).toBe("string");
	runtime.close();
	expect(await Bun.file(join(root, "hatchlight.lock")).exists()).toBe(false);
	await rm(root, { recursive: true });
});

test("a bare process id since this machine started is taken over once that process is gone", async () => {
	// Left by an older desktop app that crashed: both its locks name it.
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	await Bun.write(join(root, "hatchlight.lock"), "2147483646");
	await Bun.write(join(root, `${LEGACY_NAME}.lock`), "2147483646");
	const release = lockDataDir(root, { seesEveryProcess: true });
	expect(await lockPid(join(root, "hatchlight.lock"))).toBe(process.pid);
	release();
});

test("a bare process id is not guessed at where other processes cannot be seen", async () => {
	// In a container or WSL, the host's processes do not show.
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	await Bun.write(join(root, "hatchlight.lock"), "2147483646");
	expect(() => lockDataDir(root, { seesEveryProcess: false })).toThrow(
		`delete ${join(root, "hatchlight.lock")}`,
	);
});

test("a bare process id of a running process, or of this one, is not guessed at", async () => {
	// This process's id may be another container's process 1.
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	const alive = Bun.spawn(["sleep", "30"]);
	cleanups.push(async () => {
		alive.kill();
	});
	for (const pid of [String(process.pid), String(alive.pid)]) {
		await Bun.write(join(root, "hatchlight.lock"), pid);
		expect(() => lockDataDir(root, { seesEveryProcess: true })).toThrow(
			`delete ${join(root, "hatchlight.lock")}`,
		);
	}
});

test("an old lock of this machine with this process's id was left by a crash", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	await Bun.write(
		join(root, "hatchlight.lock"),
		JSON.stringify({ pid: process.pid, host: hostname() }),
	);
	await Bun.write(join(root, `${LEGACY_NAME}.lock`), String(process.pid));
	const runtime = await createRuntime({
		dataDir: root,
		providers: [new FakeProvider()],
	});
	runtime.close();
});

test("an old lock naming another host is refused, with a way out", async () => {
	// Process 1 here and process 1 in another container are not the same.
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	await Bun.write(
		join(root, "hatchlight.lock"),
		JSON.stringify({ pid: process.pid, host: "other-container" }),
	);
	const refused = createRuntime({
		dataDir: root,
		providers: [new FakeProvider()],
	});
	await expect(refused).rejects.toThrow("on other-container");
	await expect(refused).rejects.toThrow("Stop that container");
});

test("a lock from before this machine last started is taken over", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	// Its process id now belongs to something else that runs.
	const pid = otherProcess();
	await Bun.write(
		join(root, "hatchlight.lock"),
		JSON.stringify({ pid, host: hostname(), bootId: "an earlier start" }),
	);
	await Bun.write(join(root, `${LEGACY_NAME}.lock`), String(pid));
	const started = createRuntime({
		dataDir: root,
		providers: [new FakeProvider()],
	});
	// Only Linux tells when the machine started.
	if (await Bun.file("/proc/sys/kernel/random/boot_id").exists()) {
		(await started).close();
	} else {
		await expect(started).rejects.toBeInstanceOf(DataDirInUseError);
	}
});

test("a live owner on another machine keeps its lock", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	await Bun.write(
		join(root, "hatchlight.lock"),
		JSON.stringify({ pid: otherProcess(), host: "elsewhere", bootId: "x" }),
	);
	await expect(
		createRuntime({ dataDir: root, providers: [new FakeProvider()] }),
	).rejects.toThrow("on elsewhere");
});

test("a live lock is kept even when its process id is this one's", async () => {
	// Two containers on one volume: both servers are process 1.
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	await Bun.write(
		join(root, "hatchlight.lock"),
		JSON.stringify({
			pid: process.pid,
			host: "another-container",
			heartbeat: true,
			token: "theirs",
		}),
	);
	await expect(
		createRuntime({ dataDir: root, providers: [new FakeProvider()] }),
	).rejects.toThrow("on another-container");
});

test("a lock whose heartbeat stopped is taken over", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	const lock = join(root, "hatchlight.lock");
	await Bun.write(
		lock,
		JSON.stringify({ pid: 1, host: "gone", heartbeat: true, token: "x" }),
	);
	// Last rewritten a minute ago.
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	await Bun.write(join(root, `${LEGACY_NAME}.lock`), "1");
	const runtime = await createRuntime({
		dataDir: root,
		providers: [new FakeProvider()],
	});
	expect(JSON.parse(await Bun.file(lock).text()).pid).toBe(process.pid);
	runtime.close();
	expect(await Bun.file(lock).exists()).toBe(false);
});

test("the lock is rewritten while the directory is held", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	const release = lockDataDir(root, { heartbeatMs: 20 });
	const lock = join(root, "hatchlight.lock");
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	await Bun.sleep(80);
	expect((await stat(lock)).mtimeMs).toBeGreaterThan(Date.now() - 10_000);
	release();
});

test("a process from before the rename keeps its data directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	const pid = otherProcess();
	await Bun.write(join(root, `${LEGACY_NAME}.lock`), String(pid));
	await expect(
		createRuntime({ dataDir: root, providers: [new FakeProvider()] }),
	).rejects.toBeInstanceOf(DataDirInUseError);
	// Its lock is left as it was, and no new one stays behind.
	expect(await Bun.file(join(root, `${LEGACY_NAME}.lock`)).text()).toBe(
		String(pid),
	);
	expect(await Bun.file(join(root, "hatchlight.lock")).exists()).toBe(false);
});

test("the data directory is locked under both names, and freed under both", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-lock-"));
	cleanups.push(() => rm(root, { recursive: true }));
	const legacy = join(root, `${LEGACY_NAME}.lock`);
	// Left by a process from before the rename that died, before a restart.
	await Bun.write(legacy, "2147483646");
	await beforeBoot(legacy);
	const runtime = await createRuntime({
		dataDir: root,
		providers: [new FakeProvider()],
	});
	for (const lock of [join(root, "hatchlight.lock"), legacy]) {
		expect(await lockPid(lock)).toBe(process.pid);
	}
	// Older versions read the legacy lock as a bare process id.
	expect(await Bun.file(legacy).text()).toBe(String(process.pid));
	runtime.close();
	for (const lock of [join(root, "hatchlight.lock"), legacy]) {
		expect(await Bun.file(lock).exists()).toBe(false);
	}
});

test("the gallery from before the rename is kept, under its old name", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-db-"));
	cleanups.push(() => rm(root, { recursive: true }));
	const current = join(root, "hatchlight.sqlite");
	const legacy = join(root, `${LEGACY_NAME}.sqlite`);
	expect(databaseFile(root)).toBe(current);
	await Bun.write(legacy, "");
	expect(databaseFile(root)).toBe(legacy);
	const runtime = await createRuntime({
		dataDir: root,
		providers: [new FakeProvider()],
	});
	runtime.close();
	expect(await Bun.file(current).exists()).toBe(false);
	await Bun.write(current, "");
	expect(databaseFile(root)).toBe(current);
});

test("the event stream reports a job from start to finish", async () => {
	const { call, post } = await setup();
	const stream = await call("/api/events");
	expect(stream.headers.get("content-type")).toContain("text/event-stream");
	const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let text = "";
	const readUntil = async (marker: string) => {
		while (!text.includes(marker)) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`Stream ended before ${marker}`);
			text += decoder.decode(value);
		}
	};
	await readUntil("event: ready");
	await post("/api/turns", { prompt: "x", modelIds: ["fake/alpha"] });
	await readUntil('"status":"succeeded"');
	expect(text).toContain("event: job.progress");
	expect(text).toContain("event: job.updated");
	await reader.cancel();
});

test("a stored file can be read in ranges, as video players do", async () => {
	const { call } = await setup();
	const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1];
	const upload = await call("/api/assets", {
		method: "POST",
		body: new Uint8Array(bytes),
	});
	const { id } = (await upload.json()) as { id: string };
	const get = (range: string) =>
		call(`/api/assets/${id}`, { headers: { range } });
	const read = async (response: Response) =>
		Array.from(new Uint8Array(await response.arrayBuffer()));

	expect((await call(`/api/assets/${id}`)).headers.get("accept-ranges")).toBe(
		"bytes",
	);

	const middle = await get("bytes=1-3");
	expect(middle.status).toBe(206);
	expect(middle.headers.get("content-range")).toBe("bytes 1-3/9");
	expect(middle.headers.get("content-length")).toBe("3");
	expect(middle.headers.get("content-type")).toBe("image/png");
	expect(await read(middle)).toEqual(bytes.slice(1, 4));

	const open = await get("bytes=7-");
	expect(open.headers.get("content-range")).toBe("bytes 7-8/9");
	expect(await read(open)).toEqual(bytes.slice(7));

	const beyond = await get("bytes=4-999");
	expect(beyond.headers.get("content-range")).toBe("bytes 4-8/9");

	const suffix = await get("bytes=-2");
	expect(suffix.headers.get("content-range")).toBe("bytes 7-8/9");
	expect(await read(suffix)).toEqual(bytes.slice(7));

	for (const range of ["bytes=9-", "bytes=5-2", "bytes=-0"]) {
		const response = await get(range);
		expect(response.status).toBe(416);
		expect(response.headers.get("content-range")).toBe("bytes */9");
	}

	// Anything that is not one byte range is answered with the whole file.
	for (const range of ["bytes=0-1,4-5", "items=0-1", "bytes=-"]) {
		const response = await get(range);
		expect(response.status).toBe(200);
		expect(await read(response)).toEqual(bytes);
	}
});

test("a local model is listed, installed, and deleted", async () => {
	const { call, runtime } = await setup();
	type View = {
		models: { id: string; state: string; size: number; demos: object[] }[];
		disk: { freeBytes: number; usedBytes: number };
	};
	const list = async () =>
		(await (await call("/api/local-models")).json()) as View;

	const before = await list();
	expect(before.models).toHaveLength(1);
	expect(before.models[0]).toMatchObject({
		id: "tiny",
		state: "available",
		// The engine comes with the first model.
		size: WEIGHTS.byteLength + ENGINE.byteLength,
		demos: [{ media: "image" }],
	});
	// Where files come from is the server's business.
	expect(JSON.stringify(before)).not.toContain("models.example/");

	const stream = await call("/api/events");
	const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
	const install = await call("/api/local-models/tiny/install", {
		method: "POST",
	});
	expect(install.status).toBe(202);
	await runtime.models.idle();
	const installed = await list();
	expect(installed.models[0]?.state).toBe("installed");
	// The weights and the extracted engine.
	expect(installed.disk.usedBytes).toBe(WEIGHTS.byteLength + 3);
	let text = "";
	while (!text.includes("event: models.changed")) {
		text += new TextDecoder().decode((await reader.read()).value);
	}
	await reader.cancel();

	const remove = await call("/api/local-models/tiny", { method: "DELETE" });
	expect(remove.status).toBe(204);
	expect((await list()).disk.usedBytes).toBe(0);

	for (const [path, method] of [
		["/api/local-models/nope/install", "POST"],
		["/api/local-models/nope/cancel", "POST"],
		["/api/local-models/nope", "DELETE"],
		["/api/local-models/nope/demos/0", "GET"],
		["/api/local-models/tiny/demos/7", "GET"],
		["/api/local-models/tiny/demos/x", "GET"],
	] as const) {
		expect((await call(path, { method })).status).toBe(404);
	}
});

test("a LoRA is added from a file, listed, and deleted", async () => {
	const { call } = await setup();
	const add = (name: string, body: Uint8Array) =>
		call(`/api/loras?${new URLSearchParams({ name })}`, {
			method: "POST",
			body,
		});
	const file = safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"], {
		"modelspec.title": "Porcelain",
	});

	const added = await add("porcelain.safetensors", file);
	expect(added.status).toBe(201);
	expect(await added.json()).toMatchObject({
		id: "porcelain",
		name: "Porcelain",
		base: "sdxl",
		size: file.byteLength,
	});
	expect(await (await call("/api/loras")).json()).toMatchObject([
		{ id: "porcelain" },
	]);

	const wrongName = await add("porcelain.ckpt", file);
	expect(wrongName.status).toBe(400);
	expect(await wrongName.json()).toMatchObject({ code: "loraUnreadable" });
	const notLora = await add("x.safetensors", new Uint8Array(40));
	expect(await notLora.json()).toMatchObject({ code: "loraUnreadable" });

	expect(
		(await call("/api/loras/porcelain", { method: "DELETE" })).status,
	).toBe(204);
	expect(await (await call("/api/loras")).json()).toEqual([]);
	const gone = await call("/api/loras/porcelain", { method: "DELETE" });
	expect(gone.status).toBe(404);
	expect(await gone.json()).toMatchObject({ code: "loraMissing" });
});

test("a whole model is added from a file, set up, and deleted", async () => {
	const { call } = await setup();
	const file = safetensors([
		"model.diffusion_model.input_blocks.0.0.weight",
		"conditioner.embedders.1.model.ln_final.weight",
		"first_stage_model.decoder.conv_in.weight",
	]);
	const added = await call(
		`/api/checkpoints?${new URLSearchParams({ name: "Juggernaut XL.safetensors" })}`,
		{ method: "POST", body: file },
	);
	expect(added.status).toBe(201);
	expect(await added.json()).toMatchObject({
		id: "juggernaut-xl",
		base: "sdxl",
		steps: 30,
	});
	const patch = (body: object) =>
		call("/api/checkpoints/juggernaut-xl", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const changed = await patch({ steps: 8, cfgScale: 2, id: "ignored" });
	expect(await changed.json()).toMatchObject({
		id: "juggernaut-xl",
		steps: 8,
		cfgScale: 2,
	});
	expect((await patch({ steps: -1 })).status).toBe(400);
	expect(await (await call("/api/checkpoints")).json()).toMatchObject([
		{ id: "juggernaut-xl", steps: 8 },
	]);
	expect(
		(await call("/api/checkpoints/juggernaut-xl", { method: "DELETE" })).status,
	).toBe(204);
	const gone = await call("/api/checkpoints/juggernaut-xl", {
		method: "DELETE",
	});
	expect(await gone.json()).toMatchObject({ code: "checkpointMissing" });
});

test("another app's folder is linked, its models listed, and unlinked", async () => {
	const app = await mkdtemp(join(tmpdir(), "hatchlight-comfyui-"));
	cleanups.push(() => rm(app, { recursive: true }));
	await mkdir(join(app, "models", "loras"), { recursive: true });
	await mkdir(join(app, "models", "checkpoints"), { recursive: true });
	await Bun.write(
		join(app, "models", "loras", "Ink.safetensors"),
		safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"]),
	);
	await Bun.write(
		join(app, "models", "checkpoints", "Juggernaut.safetensors"),
		safetensors([
			"model.diffusion_model.input_blocks.0.0.weight",
			"conditioner.embedders.1.model.ln_final.weight",
			"first_stage_model.decoder.conv_in.weight",
		]),
	);
	const { call, post, dir } = await setup({
		modelFolderPlaces: async () => [app, join(app, "nope")],
	});
	expect(await (await call("/api/model-folders/suggestions")).json()).toEqual([
		{ path: app, app: "comfyui" },
	]);
	const added = await post("/api/model-folders", { path: app });
	expect(added.status).toBe(201);
	const folder = (await added.json()) as { id: string };
	expect(folder).toMatchObject({ app: "comfyui", loras: 1, checkpoints: 1 });
	expect(await (await call("/api/loras")).json()).toMatchObject([
		{ id: "ink", linked: { folder: folder.id, app: "comfyui" } },
	]);
	expect(await (await call("/api/checkpoints")).json()).toMatchObject([
		{ id: "juggernaut", linked: { folder: folder.id } },
	]);
	const refused = await call("/api/loras/ink", { method: "DELETE" });
	expect(refused.status).toBe(400);
	expect(await refused.json()).toMatchObject({ code: "modelLinked" });
	expect((await post("/api/model-folders", { path: app })).status).toBe(400);
	expect(
		await (await post("/api/model-folders", { path: "relative" })).json(),
	).toMatchObject({ code: "folderNotAbsolute" });
	expect(
		await (
			await post("/api/model-folders", { path: join(dir, "models") })
		).json(),
	).toMatchObject({ code: "modelFolderInside" });
	expect(
		await (await post("/api/model-folders", { path: join(app, "no") })).json(),
	).toMatchObject({ code: "modelFolderMissing" });
	expect(
		await (await post("/api/model-folders/rescan", {})).json(),
	).toMatchObject([{ id: folder.id, loras: 1 }]);
	expect(await (await call("/api/model-folders/suggestions")).json()).toEqual(
		[],
	);
	expect(
		(await call(`/api/model-folders/${folder.id}`, { method: "DELETE" }))
			.status,
	).toBe(204);
	expect(await (await call("/api/loras")).json()).toEqual([]);
	expect(await (await call("/api/model-folders")).json()).toEqual([]);
	const gone = await call(`/api/model-folders/${folder.id}`, {
		method: "DELETE",
	});
	expect(await gone.json()).toMatchObject({ code: "modelFolderNotFound" });
});

test("the trainer reports itself, and nothing trains before it is installed", async () => {
	const { call } = await setup();
	const status = await (await call("/api/trainer")).json();
	expect(status).toMatchObject({
		state: "missing",
		install: null,
		training: null,
	});
	const train = await call("/api/trainings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "x",
			trigger: "qzx",
			steps: 800,
			pictures: [],
			consent: true,
		}),
	});
	expect(train.status).toBe(400);
	expect(await train.json()).toMatchObject({ code: "trainerMissing" });
	// Nothing trains unless the person says the pictures are theirs to use.
	const unconfirmed = await call("/api/trainings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "x",
			trigger: "qzx",
			steps: 800,
			pictures: [],
		}),
	});
	expect(await unconfirmed.json()).toMatchObject({
		code: "trainingNeedsConsent",
	});
	const bad = await call("/api/trainings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "x",
			trigger: "qzx",
			steps: 800,
			pictures: [{}],
			consent: true,
		}),
	});
	expect(bad.status).toBe(400);
	// No training, so no samples and nothing to keep.
	expect((await call("/api/trainings/x/samples/100")).status).toBe(404);
	const finish = await call("/api/trainings/finish", { method: "POST" });
	expect(await finish.json()).toMatchObject({ code: "trainingNothingSaved" });
});

test("a picture is checked against pictures of its character", async () => {
	const seen: { references: string[]; candidate: string; traits?: string }[] =
		[];
	const { call, post } = await setup({
		judge: {
			compare: async (references, candidate, _signal, options) => {
				seen.push({
					references: references.map((r) => r.mimeType),
					candidate: candidate.mimeType,
					traits: options?.traits,
				});
				return {
					score: 62,
					differences: ["coat is blue"],
					verdict: "different",
				};
			},
		},
	});
	const upload = async (data: Uint8Array) =>
		(
			(await (
				await call("/api/assets", {
					method: "POST",
					headers: { "content-type": "image/png" },
					body: data,
				})
			).json()) as { id: string }
		).id;
	const first = await upload(picture(64, 48));
	const second = await upload(picture(48, 64));
	const checked = await post("/api/consistency", {
		assetId: second,
		referenceAssetIds: [first],
		traits: "green coat",
		language: "pt-BR",
	});
	expect(checked.status).toBe(200);
	expect((await checked.json()) as ConsistencyResult).toEqual({
		score: 62,
		differences: ["coat is blue"],
		verdict: "different",
	});
	// Small JPEG copies: the local model reads no WebP.
	expect(seen).toEqual([
		{
			references: ["image/jpeg"],
			candidate: "image/jpeg",
			traits: "green coat",
		},
	]);

	for (const body of [
		{ assetId: second, referenceAssetIds: [] },
		{ assetId: second, referenceAssetIds: [first, first, first, first] },
		{ assetId: second, referenceAssetIds: [second] },
		{ assetId: 3, referenceAssetIds: [first] },
		{ assetId: second, referenceAssetIds: [first], traits: 4 },
		{ assetId: second, referenceAssetIds: [first], language: "not a code" },
	]) {
		expect((await post("/api/consistency", body)).status).toBe(400);
	}
	const gone = await post("/api/consistency", {
		assetId: "ast_nope",
		referenceAssetIds: [first],
	});
	expect(gone.status).toBe(404);
	expect(seen).toHaveLength(1);
});

test("an answer without a score is a failed service, said in the reader's language", async () => {
	const { call, post } = await setup({
		judge: { compare: async () => parseConsistency("They look alike.") },
	});
	const upload = async () =>
		(
			(await (
				await call("/api/assets", {
					method: "POST",
					headers: { "content-type": "image/png" },
					body: picture(32, 32),
				})
			).json()) as { id: string }
		).id;
	const failed = await post("/api/consistency", {
		assetId: await upload(),
		referenceAssetIds: [await upload()],
	});
	expect(failed.status).toBe(502);
	expect(await failed.json()).toMatchObject({ code: "noVerdict" });
});

test("without a model that sees, a character check says what to install", async () => {
	const { call, post } = await setup();
	const upload = async () =>
		(
			(await (
				await call("/api/assets", {
					method: "POST",
					headers: { "content-type": "image/png" },
					body: picture(32, 32),
				})
			).json()) as { id: string }
		).id;
	const refused = await post("/api/consistency", {
		assetId: await upload(),
		referenceAssetIds: [await upload()],
	});
	expect(refused.status).toBe(400);
	expect(await refused.json()).toMatchObject({ code: "noJudge" });
});

test("training pictures are described by the model that looks at pictures", async () => {
	const { call, runtime } = await setup();
	const upload = await call("/api/assets", {
		method: "POST",
		headers: { "content-type": "image/png" },
		body: PNG,
	});
	const asset = (await upload.json()) as { id: string };
	const caption = (path: string, body: unknown) =>
		app.request(`http://localhost:4096${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	// Without the model, it says what to install.
	let app = createApp({ ...runtime, captioner: undefined });
	expect(
		await (await app.request("http://localhost:4096/api/captioner")).json(),
	).toEqual({ ready: false });
	const missing = await caption("/api/captions", { assetId: asset.id });
	expect(await missing.json()).toMatchObject({ code: "captionNeedsModel" });

	const seen: string[] = [];
	app = createApp({
		...runtime,
		captioner: {
			ready: async () => true,
			caption: async (picture) => {
				seen.push(picture.mimeType);
				return "standing on a table, soft light";
			},
		},
	});
	expect(
		await (await app.request("http://localhost:4096/api/captioner")).json(),
	).toEqual({ ready: true });
	const described = await caption("/api/captions", { assetId: asset.id });
	expect(await described.json()).toEqual({
		caption: "standing on a table, soft light",
	});
	expect(seen).toEqual(["image/png"]);
	expect((await caption("/api/captions", { assetId: "nope" })).status).toBe(
		404,
	);
});

test("a model's demo is served from this origin, and never as a page", async () => {
	const { call } = await setup();
	const demo = await call("/api/local-models/tiny/demos/0");
	expect(demo.status).toBe(200);
	expect(demo.headers.get("content-type")).toBe("image/png");
	expect(demo.headers.get("content-security-policy")).toBe("sandbox");
	expect(new Uint8Array(await demo.arrayBuffer())).toEqual(PNG);

	const part = await call("/api/local-models/tiny/demos/0", {
		headers: { range: "bytes=0-3" },
	});
	expect(part.status).toBe(206);
	expect(part.headers.get("content-range")).toBe("bytes 0-3/9");
});

test("a prompt is improved by the language model, and refused without one", async () => {
	const { post, runtime } = await setup();
	// Nothing installed and no key: there is nothing to write with.
	const none = await post("/api/prompts/improve", {
		prompt: "a fox",
		modelIds: ["fake/alpha"],
	});
	expect(none.status).toBe(400);
	expect(((await none.json()) as { code: string }).code).toBe(
		"noLanguageModel",
	);

	const asked: unknown[] = [];
	const app = createApp({
		...runtime,
		improvePrompt: async (_ctx, request) => {
			asked.push(request);
			return "a red fox curled up in fresh snow";
		},
	});
	const improve = (body: unknown) =>
		app.request("http://localhost:4096/api/prompts/improve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const answer = await improve({
		prompt: "a fox",
		modelIds: ["fake/alpha"],
		editing: true,
		language: "pt-BR",
	});
	expect(await answer.json()).toEqual({
		prompt: "a red fox curled up in fresh snow",
	});
	expect(asked).toEqual([
		{
			prompt: "a fox",
			modelIds: ["fake/alpha"],
			editing: true,
			language: "pt-BR",
		},
	]);
	for (const bad of [
		{ prompt: " ", modelIds: [] },
		{ prompt: "a fox", modelIds: "fake/alpha" },
		{ prompt: "x".repeat(1001), modelIds: [] },
		{ prompt: "a fox", modelIds: [], language: "<script>" },
		{ prompt: "a fox", modelIds: Array(51).fill("fake/alpha") },
	]) {
		expect((await improve(bad)).status).toBe(400);
	}
});

test("a coded failure is a bad gateway only when a service failed", async () => {
	const { runtime } = await setup();
	for (const [thrown, status] of [
		[new CodedError("Could not", "improveFailed"), 502],
		[new CodedError("Busy", "providerBusy"), 502],
		[new CodedError("Full", "notEnoughDisk", { neededBytes: 1 }), 500],
	] as const) {
		const app = createApp({
			...runtime,
			improvePrompt: async () => {
				throw thrown;
			},
		});
		const response = await app.request(
			"http://localhost:4096/api/prompts/improve",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: "a fox", modelIds: [] }),
			},
		);
		expect(response.status).toBe(status);
		expect(((await response.json()) as { code: string }).code).toBe(
			thrown.code as string,
		);
	}
});

test("settings keep what improves prompts, and refuse what is not a choice", async () => {
	const { runtime } = await setup();
	const app = createApp(runtime);
	const put = (body: unknown) =>
		app.request("http://localhost:4096/api/settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	expect((await put({ improveWith: "owl" })).status).toBe(400);
	const saved = await put({ improveWith: "openai" });
	expect(await saved.json()).toMatchObject({ improveWith: "openai" });
	const read = await app.request("http://localhost:4096/api/settings");
	expect(await read.json()).toMatchObject({
		translateWith: "local",
		improveWith: "openai",
	});
});

test("the assistant answers in a session, and asks before paying", async () => {
	const replies: ChatReply[] = [
		{
			text: "",
			toolCalls: [
				{
					id: "c1",
					name: "generate",
					arguments: { prompt: "a red fox", models: ["fake/alpha"] },
				},
			],
		},
		{ text: "Aqui está.", toolCalls: [] },
	];
	const brain: ChatModel = {
		vision: false,
		chat: async () => replies.shift() ?? { text: "", toolCalls: [] },
	};
	const { call, post, runtime } = await setup({ assistantModel: brain });
	const view = async (id: string) => {
		for (let i = 0; i < 200; i++) {
			const body = (await (
				await call(`/api/sessions/${id}/assistant`)
			).json()) as AssistantView;
			if (!body.busy) return body;
			await Bun.sleep(10);
		}
		throw new Error("still busy");
	};

	expect((await post("/api/assistant/messages", { text: " " })).status).toBe(
		400,
	);
	const sent = await post("/api/assistant/messages", {
		text: "uma raposa com o fake/alpha",
		language: "pt-BR",
	});
	expect(sent.status).toBe(200);
	const { sessionId } = (await sent.json()) as { sessionId: string };
	// The fake models cost money: the person is asked first.
	const asked = (await view(sessionId)).entries.at(-1);
	expect(asked?.confirm).toMatchObject({ usd: 0.01, state: "asked" });

	const yes = await post(`/api/sessions/${sessionId}/assistant/answers`, {
		entryId: asked?.id,
		approve: true,
	});
	expect(yes.status).toBe(202);
	const done = await view(sessionId);
	await runtime.engine.idle();
	expect(done.entries.at(-1)?.message).toMatchObject({ text: "Aqui está." });
	const turnId = done.entries.find((e) => e.id === asked?.id)?.turnId;
	const session = (await (await call(`/api/sessions/${sessionId}`)).json()) as {
		turns: { id: string; prompt: string }[];
	};
	expect(session.turns).toEqual([
		expect.objectContaining({ id: turnId, prompt: "a red fox" }),
	]);
	expect(done.spentUsd).toBeCloseTo(0.01);

	// Answered already; and a session that is not there is not found.
	expect(
		(
			await post(`/api/sessions/${sessionId}/assistant/answers`, {
				entryId: asked?.id,
				approve: true,
			})
		).status,
	).toBe(404);
	expect((await call("/api/sessions/ses_none/assistant")).status).toBe(404);
});

test("trying the app with fake models offers a paid one too, which needs a key", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-fake-"));
	cleanups.push(() => rm(root, { recursive: true }));
	process.env.HATCHLIGHT_FAKE = "1";
	try {
		const runtime = await createRuntime({ dataDir: root, providers: [] });
		const providers = await runtime.service.listProviders({ userId: "local" });
		const required = new Map(providers.map((p) => [p.id, p.requiresKey]));
		expect(required.get("fake")).toBe(false);
		expect(required.get("fake-paid")).toBe(true);
		runtime.close();
	} finally {
		delete process.env.HATCHLIGHT_FAKE;
	}
});

test("keys saved before encryption are encrypted on start; keys a new secret cannot open are set aside", async () => {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-secret-"));
	cleanups.push(() => rm(root, { recursive: true }));
	const auth = join(root, "auth.json");
	await Bun.write(auth, JSON.stringify({ local: { fake: "sk-from-before" } }));
	const start = () =>
		createRuntime({ dataDir: root, providers: [new FakeProvider()] });
	const first = await start();
	expect(await Bun.file(auth).text()).not.toContain("sk-from-before");
	first.close();

	// The secret is lost, or another one is in place: it still starts.
	const sealed = await Bun.file(auth).text();
	const secret = await Bun.file(join(root, "secret.key")).bytes();
	await Bun.write(
		join(root, "secret.key"),
		crypto.getRandomValues(new Uint8Array(32)),
	);
	const second = await start();
	const app = createApp(second);
	expect(
		await (await app.request("http://localhost/api/keys/lost")).json(),
	).toEqual({
		lost: true,
	});
	// The keys are kept aside, untouched; nothing is deleted.
	const aside = (await readdir(root)).find((name) =>
		name.startsWith("auth.unreadable-"),
	) as string;
	expect(await Bun.file(join(root, aside)).text()).toBe(sealed);
	expect(await Bun.file(auth).exists()).toBe(false);
	// Seen once, not told again.
	await app.request("http://localhost/api/keys/lost", { method: "DELETE" });
	expect(
		await (await app.request("http://localhost/api/keys/lost")).json(),
	).toEqual({
		lost: false,
	});
	second.close();

	// The old secret and file put back: the keys are there again.
	await Bun.write(join(root, "secret.key"), secret);
	await rename(join(root, aside), auth);
	const third = await start();
	expect(await third.service.listProviders({ userId: "local" })).toContainEqual(
		expect.objectContaining({ id: "fake", hasKey: true }),
	);
	third.close();
});
