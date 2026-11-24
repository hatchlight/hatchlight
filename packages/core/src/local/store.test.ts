import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative as relativeTo } from "node:path";
import {
	formatBytes,
	type Hardware,
	isDemoSize,
	type LocalEngineSpec,
	type LocalModelEvent,
	type LocalModelSpec,
	LocalModelStore,
	type LocalModelVariant,
	NotFoundError,
	ValidationError,
} from "../index";
import { GpuLock } from "./gpu";
import { picture, tarGz, zip } from "./testing";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

const GB = 1024 ** 3;
const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(data).digest("hex");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

const BIG_PNG = picture(3000, 1500);

const UNET_A = bytes("weights of model a");
const UNET_A_SMALL = bytes("model a, quantized");
const UNET_B = bytes("weights of model b, a little longer");
const ENCODER = bytes("a text encoder both models use");
const ENGINE = zip([
	{ name: "bin/run", data: bytes("#!/bin/sh\necho run") },
	{ name: "lib/backend.so", data: bytes("a backend library") },
]);
const ENGINE_TAR = tarGz([
	{ name: "./bin/", type: "5" },
	{ name: "./bin/run", data: bytes("#!/bin/sh\necho run"), mode: 0o755 },
	{ name: "./bin/libbackend.so.1", data: bytes("a backend library") },
	{ name: "./bin/libbackend.so", type: "2", linkname: "libbackend.so.1" },
]);
const url = (name: string) => `https://models.example/${name}`;

const file = (name: string, data: Uint8Array, role?: string) => ({
	name,
	url: url(name),
	size: data.byteLength,
	sha256: sha256(data),
	...(role && { role }),
});
const variant = (
	id: string,
	memory: number,
	files: LocalModelVariant["files"],
): LocalModelVariant => ({
	id,
	label: id,
	engine: "run",
	memoryBytes: memory * GB,
	files,
});
const model = (
	id: string,
	variants: LocalModelVariant[],
	demos: LocalModelSpec["demos"] = [],
): LocalModelSpec => ({
	id,
	name: `Model ${id}`,
	author: "Example",
	media: "image",
	tasks: ["text-to-image"],
	summary: "A model for tests.",
	license: "MIT",
	licenseUrl: "https://license.example",
	commercial: { kind: "allowed" },
	homepage: "https://models.example",
	variants,
	demos,
	defaults: { size: 512, aspectRatios: ["1:1"], steps: 1, cfgScale: 1 },
});
const ENCODER_FILE = file("encoder.safetensors", ENCODER, "encoder");
const CATALOG = [
	model(
		"a",
		[
			variant("full", 16, [
				file("a.safetensors", UNET_A, "model"),
				ENCODER_FILE,
			]),
			variant("small", 4, [
				file("a-small.gguf", UNET_A_SMALL, "model"),
				ENCODER_FILE,
			]),
		],
		[
			{ url: url("demo.png"), media: "image", caption: "A sample" },
			{ url: url("page.html"), media: "image" },
		],
	),
	model("b", [
		variant("full", 4, [file("b.safetensors", UNET_B, "model"), ENCODER_FILE]),
	]),
];
const ENGINES: LocalEngineSpec[] = [
	{
		id: "run",
		name: "Runner",
		homepage: "https://engine.example",
		license: "MIT",
		builds: [
			{
				id: "run-linux-x64-cuda",
				engine: "run",
				version: "1",
				backend: "cuda",
				os: "linux",
				arch: "x64",
				files: [file("engine.zip", ENGINE)],
				executable: "bin/run",
			},
			{
				id: "run-linux-x64-cpu",
				engine: "run",
				version: "1",
				backend: "cpu",
				os: "linux",
				arch: "x64",
				files: [file("engine.zip", ENGINE)],
				executable: "bin/run",
			},
		],
	},
];

const machine = (gpuMemory: number | null, memory = 32): Hardware => ({
	os: "linux",
	arch: "x64",
	wsl: false,
	memoryBytes: memory * GB,
	gpus:
		gpuMemory == null
			? []
			: [{ vendor: "nvidia", name: "Card", memoryBytes: gpuMemory * GB }],
});

/** A server holding `files`, answering ranges as a download host does. */
function remote(files: Record<string, Uint8Array>) {
	const requests: { url: string; range: string | null }[] = [];
	const control = {
		/** When set, a download stalls on this after its first bytes. */
		hold: null as Promise<void> | null,
		status: 200,
		ignoreRange: false,
		/** How many bytes to leave out of the end of each answer. */
		cut: 0,
	};
	const fetch = async (target: string, init?: RequestInit) => {
		const range = new Headers(init?.headers).get("range");
		requests.push({ url: target, range });
		const data = files[target];
		if (!data) return new Response("Not found", { status: 404 });
		if (control.status !== 200) {
			return new Response("Unavailable", { status: control.status });
		}
		const start =
			range && !control.ignoreRange ? Number(range.match(/\d+/)?.[0]) : 0;
		const body = data.slice(start, data.length - control.cut);
		const signal = init?.signal;
		const { hold } = control;
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const aborted = new Promise<never>((_, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason));
				});
				try {
					controller.enqueue(body.slice(0, 4));
					if (hold) await Promise.race([hold, aborted]);
					if (body.length > 4) controller.enqueue(body.slice(4));
					controller.close();
				} catch (error) {
					controller.error(error);
				}
			},
		});
		return new Response(stream, { status: start > 0 ? 206 : 200 });
	};
	return { fetch, requests, control };
}

const HOSTED = {
	[url("a.safetensors")]: UNET_A,
	[url("a-small.gguf")]: UNET_A_SMALL,
	[url("b.safetensors")]: UNET_B,
	[url("encoder.safetensors")]: ENCODER,
	[url("engine.zip")]: ENGINE,
	[url("engine.tar.gz")]: ENGINE_TAR,
	[url("demo.png")]: PNG,
	[url("big.png")]: BIG_PNG,
	[url("page.html")]: bytes("<script>alert(1)</script>"),
};

async function setup(
	options: {
		hardware?: Hardware;
		catalog?: LocalModelSpec[];
		/** Says why a freshly installed engine does not run; by default all do. */
		checkEngine?: (executable: string) => Promise<string | null>;
		root?: string;
		engines?: LocalEngineSpec[];
		enginesDir?: string;
	} = {},
) {
	// A second store on an existing root reopens it, as after a restart.
	const root =
		options.root ?? (await mkdtemp(join(tmpdir(), "hatchlight-models-")));
	if (!options.root) dirs.push(root);
	const host = remote(HOSTED);
	const hardware = options.hardware ?? machine(24);
	const store = new LocalModelStore({
		root,
		catalog: options.catalog ?? CATALOG,
		engines: options.engines ?? ENGINES,
		fetch: host.fetch,
		hardware: async () => hardware,
		checkEngine: options.checkEngine ?? (async () => null),
		enginesDir: options.enginesDir,
	});
	const events: LocalModelEvent[] = [];
	store.subscribe((event) => events.push(event));
	const status = async (id: string) => {
		const found = (await store.list()).models.find((m) => m.id === id);
		if (!found) throw new Error(`Not listed: ${id}`);
		return found;
	};
	const blobs = () => readdir(join(root, "blobs")).catch(() => []);
	const engines = () => readdir(join(root, "engines")).catch(() => []);
	return { root, store, events, status, blobs, engines, ...host };
}

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

async function until(condition: () => Promise<boolean> | boolean) {
	for (let i = 0; i < 200; i++) {
		if (await condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for a condition");
}

const A_FULL = UNET_A.length + ENCODER.length;
const A_SMALL = UNET_A_SMALL.length + ENCODER.length;

test("lists each model with the variant this machine runs best", async () => {
	const { store } = await setup();
	const view = await store.list();
	expect(view.hardware.gpus[0]?.memoryBytes).toBe(24 * GB);
	expect(view.engines).toEqual([
		{
			engine: "run",
			name: "Runner",
			build: "run-linux-x64-cuda",
			version: "1",
			backend: "cuda",
			throughWindows: false,
			installed: false,
			size: ENGINE.length,
			usedBy: [],
		},
	]);
	const [a] = view.models;
	expect(a).toMatchObject({
		state: "available",
		variant: "full",
		installed: false,
		// The engine is part of the first install.
		size: A_FULL + ENGINE.length,
		receivedBytes: 0,
		reclaimableBytes: 0,
		demos: [{ media: "image", caption: "A sample" }, { media: "image" }],
	});
	expect(a?.variants.map((v) => [v.id, v.fit, v.size])).toEqual([
		["full", "gpu", A_FULL],
		["small", "gpu", A_SMALL],
	]);
	// Where files come from stays on the server.
	expect(JSON.stringify(view)).not.toContain("models.example/");
	expect(view.disk.usedBytes).toBe(0);
});

test("a variant whose files are already here is proposed when it runs as well", async () => {
	// No graphics card: every variant runs on the processor, so the smaller
	// would be proposed...
	const { store, status, root } = await setup({ hardware: machine(null, 64) });
	expect((await status("a")).variant).toBe("small");
	// ...unless the larger one's files are already on disk.
	await mkdir(join(root, "blobs"), { recursive: true });
	await Bun.write(join(root, "blobs", sha256(UNET_A)), UNET_A);
	await Bun.write(join(root, "blobs", sha256(ENCODER)), ENCODER);
	expect((await status("a")).variant).toBe("full");
	await store.install("a");
	await store.idle();
	expect(await status("a")).toMatchObject({ installed: true, variant: "full" });
});

test("a smaller card gets the smaller variant, and says what the larger needs", async () => {
	const { store, status } = await setup({ hardware: machine(8) });
	const a = await status("a");
	expect(a.variant).toBe("small");
	expect(a.variants.map((v) => v.fit)).toEqual(["offload", "gpu"]);

	await store.install("a");
	await store.idle();
	expect(await status("a")).toMatchObject({
		installed: true,
		variant: "small",
	});
});

test("installing fetches the engine and the files, and runs from them", async () => {
	const { store, status, events, blobs, engines, root } = await setup();
	await store.install("a");
	expect((await status("a")).state).not.toBe("available");
	await store.idle();

	const installed = await status("a");
	expect(installed).toMatchObject({
		state: "installed",
		installed: true,
		variant: "full",
		// The engine is extracted, so its archive no longer counts.
		size: A_FULL,
		receivedBytes: A_FULL,
	});
	expect(installed.error).toBeUndefined();
	expect(await engines()).toEqual(["run-linux-x64-cuda"]);
	// The archive is dropped once extracted.
	expect((await blobs()).sort()).toEqual(
		[sha256(UNET_A), sha256(ENCODER)].sort(),
	);

	const runtime = await store.runtime("a");
	expect(runtime.variant.id).toBe("full");
	expect(runtime.build.id).toBe("run-linux-x64-cuda");
	expect(runtime.throughWindows).toBe(false);
	expect(runtime.executable).toBe(
		join(root, "engines", "run-linux-x64-cuda", "bin", "run"),
	);
	expect((await stat(runtime.executable)).mode & 0o111).toBeTruthy();
	expect(await Bun.file(runtime.files.model as string).bytes()).toEqual(UNET_A);
	expect(Object.keys(runtime.files)).toEqual(["model", "encoder"]);

	const view = await store.list();
	expect(view.engines[0]).toMatchObject({ installed: true, usedBy: ["a"] });
	expect(view.disk.usedBytes).toBeGreaterThan(A_FULL);

	await Bun.sleep(20); // progress is reported off the download's own path
	expect(events.at(-1)).toEqual({ type: "models.changed" });
	expect(events.some((e) => e.type === "model.progress")).toBe(true);

	// Installing again does nothing.
	const before = events.length;
	await store.install("a");
	expect(events).toHaveLength(before);
});

test("models share files and the engine; the engine goes with the last one", async () => {
	const { store, status, requests, blobs, engines } = await setup();
	await store.install("a");
	await store.idle();
	expect(await status("b")).toMatchObject({
		installed: false,
		// Neither the encoder nor the engine needs downloading again.
		size: UNET_B.length + ENCODER.length,
		receivedBytes: ENCODER.length,
		reclaimableBytes: 0,
	});

	await store.install("b");
	await store.idle();
	expect(requests.map((r) => r.url)).toEqual([
		url("engine.zip"),
		url("a.safetensors"),
		url("encoder.safetensors"),
		url("b.safetensors"),
	]);
	// Deleting one frees only what the other does not use.
	expect((await status("a")).reclaimableBytes).toBe(UNET_A.length);

	await store.remove("a");
	expect(await status("a")).toMatchObject({ state: "available" });
	expect((await status("b")).state).toBe("installed");
	expect((await blobs()).sort()).toEqual(
		[sha256(UNET_B), sha256(ENCODER)].sort(),
	);
	expect(await engines()).toEqual(["run-linux-x64-cuda"]);
	await expect(store.runtime("a")).rejects.toBeInstanceOf(ValidationError);

	// The last model takes its engine with it.
	const b = await status("b");
	expect(b.reclaimableBytes).toBeGreaterThan(UNET_B.length + ENCODER.length);
	await store.remove("b");
	expect(await blobs()).toEqual([]);
	expect(await engines()).toEqual([]);
	expect((await store.list()).disk.usedBytes).toBe(0);
});

test("another variant can be asked for, unless it cannot run here", async () => {
	const { store, status } = await setup({ hardware: machine(null, 16) });
	expect((await status("a")).variants.map((v) => v.fit)).toEqual([
		"none",
		"cpu",
	]);
	await expect(store.install("a", "full")).rejects.toThrow(
		"does not run on this machine",
	);
	await expect(store.install("a", "nope")).rejects.toBeInstanceOf(
		NotFoundError,
	);

	await store.install("a", "small");
	await store.idle();
	const runtime = await store.runtime("a");
	expect(runtime.variant.id).toBe("small");
	expect(runtime.build.id).toBe("run-linux-x64-cpu");
});

test("a model no variant of which fits is refused", async () => {
	const { store, status } = await setup({ hardware: machine(null, 2) });
	expect((await status("a")).variant).toBeNull();
	await expect(store.install("a")).rejects.toThrow(
		"does not run on this machine",
	);
});

test("a model installed before variants existed keeps working", async () => {
	const { store, root, status } = await setup();
	await store.install("a", "small");
	await store.idle();
	// The marker of an older version: empty, naming no variant.
	await Bun.write(join(root, "installed", "a"), "");
	expect(await status("a")).toMatchObject({
		installed: true,
		variant: "small",
	});
	expect((await store.runtime("a")).variant.id).toBe("small");
});

test("an installed model without its engine gets the engine on install", async () => {
	const { store, root, status, requests } = await setup();
	await store.install("a", "small");
	await store.idle();
	await rm(join(root, "engines"), { recursive: true });
	expect(await status("a")).toMatchObject({ installed: true, ready: false });
	await expect(store.runtime("a")).rejects.toThrow("engine");

	requests.length = 0;
	await store.install("a");
	await store.idle();
	expect(await status("a")).toMatchObject({ ready: true, variant: "small" });
	// Only the engine was downloaded again.
	expect(requests.map((r) => r.url)).toEqual([url("engine.zip")]);
});

test("a canceled install keeps what it downloaded and resumes from there", async () => {
	const { store, status, requests, control, blobs } = await setup();
	await store.install("b");
	await store.idle();
	control.hold = new Promise(() => {});
	await store.install("a");
	await until(
		async () => (await status("a")).receivedBytes === ENCODER.length + 4,
	);
	expect((await status("a")).state).toBe("downloading");

	await store.cancel("a");
	expect(await status("a")).toMatchObject({
		state: "available",
		receivedBytes: ENCODER.length + 4,
	});
	expect((await status("a")).error).toBeUndefined();
	expect(await blobs()).toContain(`${sha256(UNET_A)}.part`);

	control.hold = null;
	await store.install("a");
	await store.idle();
	expect((await status("a")).state).toBe("installed");
	expect(requests.filter((r) => r.url === url("a.safetensors"))).toEqual([
		{ url: url("a.safetensors"), range: null },
		{ url: url("a.safetensors"), range: "bytes=4-" },
	]);
	expect(
		await Bun.file((await store.runtime("a")).files.model as string).bytes(),
	).toEqual(UNET_A);
});

test("a host that ignores the range is downloaded from the start", async () => {
	const { store, status, control } = await setup();
	control.hold = new Promise(() => {});
	await store.install("a");
	await until(async () => (await status("a")).receivedBytes === 4);
	await store.cancel("a");

	control.hold = null;
	control.ignoreRange = true;
	await store.install("a");
	await store.idle();
	expect(await status("a")).toMatchObject({ state: "installed" });
});

test("deleting a half-downloaded model removes what it had fetched", async () => {
	const { store, status, control, blobs } = await setup();
	control.hold = new Promise(() => {});
	await store.install("a");
	await until(async () => (await status("a")).receivedBytes === 4);
	await store.remove("a");
	expect(await status("a")).toMatchObject({
		state: "available",
		receivedBytes: 0,
	});
	expect(await blobs()).toEqual([]);
});

test("a file that fails its check is discarded and reported", async () => {
	const { store, status, blobs, root } = await setup();
	const tampered = remote({
		...HOSTED,
		[url("a.safetensors")]: bytes("weights of model A"), // same length
	});
	const bad = new LocalModelStore({
		root,
		catalog: CATALOG,
		engines: ENGINES,
		fetch: tampered.fetch,
		hardware: async () => machine(24),
	});
	await bad.install("a");
	await bad.idle();
	const failed = (await bad.list()).models[0];
	expect(failed?.state).toBe("available");
	expect(failed?.error).toBe("a.safetensors did not match its expected hash");
	expect(await blobs()).not.toContain(sha256(UNET_A));
	expect(await blobs()).not.toContain(`${sha256(UNET_A)}.part`);

	// Trying again starts clean, and the engine is not fetched twice.
	await store.install("a");
	await store.idle();
	expect(await status("a")).toMatchObject({ state: "installed" });
});

test("a broken engine archive fails the install and leaves nothing half extracted", async () => {
	const broken = bytes("this is not a zip archive at all");
	const { root } = await setup();
	const engines: LocalEngineSpec[] = [
		{
			...(ENGINES[0] as LocalEngineSpec),
			builds: (ENGINES[0] as LocalEngineSpec).builds.map((build) => ({
				...build,
				files: [file("broken.zip", broken)],
			})),
		},
	];
	const host = remote({ ...HOSTED, [url("broken.zip")]: broken });
	const store = new LocalModelStore({
		root,
		catalog: CATALOG,
		engines,
		fetch: host.fetch,
		hardware: async () => machine(24),
	});
	await store.install("b");
	await store.idle();
	const b = (await store.list()).models[1];
	expect(b?.error).toBe("Not a zip archive");
	expect(b?.installed).toBe(false);
	expect(await readdir(join(root, "engines")).catch(() => [])).toEqual([]);
});

test("a download that fails or is cut short is reported, and can be retried", async () => {
	const { store, status, control } = await setup();
	control.status = 503;
	await store.install("a");
	await store.idle();
	expect((await status("a")).error).toBe(
		"Could not download engine.zip (HTTP 503)",
	);

	control.status = 200;
	control.cut = 1;
	await store.install("a");
	await store.idle();
	expect((await status("a")).error).toBe(
		"The download of engine.zip was cut short",
	);

	control.cut = 0;
	await store.install("a");
	await store.idle();
	const done = await status("a");
	expect(done.state).toBe("installed");
	expect(done.error).toBeUndefined();
});

test("installs run one at a time, and a waiting one cancels at once", async () => {
	const { store, status, control } = await setup();
	const hold = gate();
	control.hold = hold.promise;
	await store.install("a");
	await store.install("b");
	await until(async () => (await status("a")).state === "downloading");
	expect((await status("b")).state).toBe("queued");

	await store.cancel("b");
	expect((await status("b")).state).toBe("available");
	hold.open();
	await store.idle();
	expect((await status("a")).state).toBe("installed");
	expect((await status("b")).state).toBe("available");
});

test("refuses a model that does not fit on the disk", async () => {
	const huge = { ...file("huge.safetensors", UNET_A), size: 1e18 };
	const { store, requests } = await setup({
		catalog: [model("huge", [variant("full", 1, [huge])])],
	});
	await expect(store.install("huge")).rejects.toThrow("Not enough disk space");
	const refusal = await store.install("huge").catch((error) => error);
	expect(refusal.code).toBe("notEnoughDisk");
	// The model, plus the engine it would bring.
	expect(refusal.params.neededBytes).toBeGreaterThanOrEqual(1e18);
	await store.idle();
	expect(requests).toHaveLength(0);
});

test("unknown models and malformed catalogs are refused", async () => {
	const { store, root } = await setup();
	await expect(store.install("nope")).rejects.toBeInstanceOf(NotFoundError);
	await expect(store.remove("nope")).rejects.toBeInstanceOf(NotFoundError);

	const invalid =
		(catalog: LocalModelSpec[], engines: LocalEngineSpec[] = ENGINES) =>
		() =>
			new LocalModelStore({ root, catalog, engines });
	const good = file("a.safetensors", UNET_A);
	const one = (files = [good], engine = "run") => [
		model("a", [{ ...variant("v", 1, files), engine }]),
	];
	expect(invalid([model("../escape", [variant("v", 1, [good])])])).toThrow(
		"Invalid or repeated",
	);
	expect(invalid([model("a", [])])).toThrow("without variants");
	expect(invalid(one([]))).toThrow("has no files");
	expect(invalid(one([good, good]))).toThrow("Repeated file name");
	expect(invalid(one([{ ...good, sha256: "abc" }]))).toThrow("Invalid hash");
	expect(invalid(one([{ ...good, url: "http://models.example/a" }]))).toThrow(
		"Not an HTTPS URL",
	);
	expect(invalid(one([good], "missing"))).toThrow("Unknown engine");
	expect(
		invalid([
			model(
				"a",
				[variant("v", 1, [good])],
				[{ url: "file:///etc/passwd", media: "image" }],
			),
		]),
	).toThrow("Not an HTTPS URL");
	const engine = ENGINES[0] as LocalEngineSpec;
	const build = engine.builds[0] as LocalEngineSpec["builds"][number];
	expect(
		invalid(one(), [
			{ ...engine, builds: [{ ...build, executable: "../../bin/sh" }] },
		]),
	).toThrow("Unsafe executable path");
});

test("a demo is fetched once, kept, and served as what its bytes are", async () => {
	const { store, requests } = await setup();
	const [first, second] = await Promise.all([
		store.demo("a", 0),
		store.demo("a", 0),
	]);
	expect(first.mime).toBe("image/png");
	expect(await first.blob.bytes()).toEqual(PNG);
	expect(second.mime).toBe("image/png");
	await store.demo("a", 0);
	expect(requests).toEqual([{ url: url("demo.png"), range: null }]);

	// Whatever the catalog links to, only images and videos are stored.
	expect(store.demo("a", 1)).rejects.toThrow("not an image or a video");
	expect(store.demo("a", 2)).rejects.toBeInstanceOf(NotFoundError);
	expect(store.demo("a", -1)).rejects.toBeInstanceOf(NotFoundError);
});

test("a demo picture is served smaller, and as it came when it cannot be read", async () => {
	const demos: LocalModelSpec["demos"] = [
		{ url: url("big.png"), media: "image" },
		{ url: url("demo.png"), media: "image" },
	];
	const { store, root, requests } = await setup({
		catalog: [model("p", [variant("full", 4, [ENCODER_FILE])], demos)],
	});
	const [card, again] = await Promise.all([
		store.demo("p", 0, "card"),
		store.demo("p", 0, "card"),
	]);
	expect(card.mime).toBe("image/webp");
	expect(await new Bun.Image(card.blob).metadata()).toMatchObject({
		width: 960,
		height: 480,
		format: "webp",
	});
	expect(await again.blob.bytes()).toEqual(await card.blob.bytes());
	const large = await store.demo("p", 0, "large");
	expect(await new Bun.Image(large.blob).metadata()).toMatchObject({
		width: 2560,
		height: 1280,
	});
	const original = await store.demo("p", 0);
	expect(await original.blob.bytes()).toEqual(BIG_PNG);
	// Downloaded once, made smaller once per size, kept.
	expect(requests).toHaveLength(1);
	expect((await readdir(join(root, "demos"))).sort()).toHaveLength(3);

	// Only a PNG signature: served as it came, nothing broken left behind.
	const broken = await store.demo("p", 1, "card");
	expect(broken.mime).toBe("image/png");
	expect(await broken.blob.bytes()).toEqual(PNG);
	expect(await readdir(join(root, "demos"))).toHaveLength(4);

	// Only sizes of its own: not names every object inherits.
	expect(isDemoSize("card")).toBe(true);
	expect(isDemoSize("constructor")).toBe(false);
	expect(isDemoSize("__proto__")).toBe(false);
});

test("leftover temporary folders are not taken for engines", async () => {
	const { store, root } = await setup();
	await mkdir(join(root, "engines", "run-linux-x64-cuda.1234.tmp"), {
		recursive: true,
	});
	expect((await store.list()).engines[0]?.installed).toBe(false);
});

test("an engine can come as a tar.gz archive", async () => {
	const [spec] = ENGINES;
	if (!spec) throw new Error("No engine");
	const engines: LocalEngineSpec[] = [
		{
			...spec,
			builds: spec.builds.map((build) => ({
				...build,
				files: [file("engine.tar.gz", ENGINE_TAR)],
			})),
		},
	];
	const { store, root } = await setup({ engines });
	await store.install("a");
	await store.idle();
	const { executable } = await store.runtime("a");
	expect(executable).toBe(
		join(root, "engines", "run-linux-x64-cuda", "bin", "run"),
	);
	expect((await stat(executable)).mode & 0o111).not.toBe(0);
	expect(
		await Bun.file(
			join(root, "engines", "run-linux-x64-cuda", "bin", "libbackend.so"),
		).text(),
	).toBe("a backend library");
});

/** A folder of engines as a Docker image has them, with `builds` in it. */
async function providedEngines(builds: string[]) {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-engines-"));
	dirs.push(dir);
	for (const build of builds) {
		await Bun.write(join(dir, build, "bin", "run"), "#!/bin/sh\necho run");
	}
	return dir;
}

test("engines that came with the system are used and never downloaded", async () => {
	const enginesDir = await providedEngines(["run-linux-x64-cuda"]);
	const checked: string[] = [];
	const { store, root, requests, engines } = await setup({
		enginesDir,
		checkEngine: async (executable) => {
			checked.push(executable);
			return null;
		},
	});
	expect((await store.list()).engines[0]).toMatchObject({
		build: "run-linux-x64-cuda",
		installed: true,
	});

	await store.install("a");
	await store.idle();
	expect(requests.map((r) => r.url)).not.toContain(url("engine.zip"));
	// Tried once, when the store first looked at the machine.
	expect(checked).toEqual([
		join(enginesDir, "run-linux-x64-cuda", "bin", "run"),
	]);
	expect(await engines()).toEqual([]);
	const runtime = await store.runtime("a");
	expect(runtime.build.id).toBe("run-linux-x64-cuda");
	expect(runtime.executable).toBe(
		join(enginesDir, "run-linux-x64-cuda", "bin", "run"),
	);

	// Removing the last model leaves the folder as it was.
	await store.remove("a");
	expect(await readdir(enginesDir)).toEqual(["run-linux-x64-cuda"]);
	expect(
		await Bun.file(join(enginesDir, "run-linux-x64-cuda", "bin", "run")).text(),
	).toBe("#!/bin/sh\necho run");
	expect(await readdir(join(root, "engines")).catch(() => [])).toEqual([]);
});

test("an engine from the system's folder that does not run is set aside", async () => {
	const enginesDir = await providedEngines([
		"run-linux-x64-cuda",
		"run-linux-x64-cpu",
	]);
	const checkEngine = async (executable: string) =>
		executable.includes("cuda") ? "libcuda.so.1 was not found" : null;
	const { store, root, requests } = await setup({ enginesDir, checkEngine });
	await store.install("a", "small");
	await store.idle();
	const runtime = await store.runtime("a");
	expect(runtime.build.id).toBe("run-linux-x64-cpu");
	expect(runtime.executable).toBe(
		join(enginesDir, "run-linux-x64-cpu", "bin", "run"),
	);
	expect(requests.map((r) => r.url)).not.toContain(url("engine.zip"));
	// Only in memory: the next start tries it again.
	expect(await Bun.file(join(root, "broken-engines.json")).exists()).toBe(
		false,
	);
	const again = await setup({ root, enginesDir });
	expect((await again.store.runtime("a")).build.id).toBe("run-linux-x64-cuda");
});

test("a relative system engines folder is taken from where the app started", async () => {
	const enginesDir = await providedEngines(["run-linux-x64-cuda"]);
	const relative = join(".", relativeTo(process.cwd(), enginesDir));
	const { store } = await setup({ enginesDir: relative });
	await store.install("a");
	await store.idle();
	expect((await store.runtime("a")).executable).toBe(
		join(enginesDir, "run-linux-x64-cuda", "bin", "run"),
	);
});

test("an engine missing from the system's folder is downloaded as usual", async () => {
	// Only a build for other hardware, and a folder without its program.
	const enginesDir = await providedEngines(["run-linux-x64-cpu"]);
	await mkdir(join(enginesDir, "run-linux-x64-cuda"));
	const { store, requests, engines } = await setup({ enginesDir });
	await store.install("a");
	await store.idle();
	expect(requests.map((r) => r.url)).toContain(url("engine.zip"));
	expect(await engines()).toEqual(["run-linux-x64-cuda"]);
	expect((await store.runtime("a")).executable).not.toContain(enginesDir);
	expect((await readdir(enginesDir)).sort()).toEqual([
		"run-linux-x64-cpu",
		"run-linux-x64-cuda",
	]);
});

test("an engine that does not run here is set aside for the next best", async () => {
	const tried: string[] = [];
	const { store, status, engines, blobs, root } = await setup({
		checkEngine: async (executable) => {
			tried.push(executable);
			return executable.includes("cuda")
				? "cudart64_12.dll was not found"
				: null;
		},
	});
	await store.install("a");
	await store.idle();
	expect(tried.map((path) => path.includes("cuda"))).toEqual([true, false]);
	expect((await status("a")).state).toBe("installed");
	expect(await engines()).toEqual(["run-linux-x64-cpu"]);
	expect((await store.runtime("a")).build.id).toBe("run-linux-x64-cpu");
	// Neither the broken build nor its archive is left behind.
	expect((await blobs()) as string[]).not.toContain(sha256(ENGINE));

	// Remembered after a restart: the CUDA build is not offered again.
	const again = await setup({ root, checkEngine: async () => null });
	expect((await again.store.runtime("a")).build.id).toBe("run-linux-x64-cpu");
	expect((await again.store.list()).engines[0]).toMatchObject({
		build: "run-linux-x64-cpu",
	});
});

test("when no engine runs here, the install says why", async () => {
	const { store, status } = await setup({
		checkEngine: async () => "the program was blocked",
	});
	await store.install("a");
	await store.idle();
	const failed = await status("a");
	expect(failed.state).toBe("available");
	expect(failed.errorCode).toBe("engineDoesNotRun");
	expect(failed.errorParams).toEqual({ reason: "the program was blocked" });
});

test("a model installed by another Hatchlight on the same folder is noticed", async () => {
	const first = await setup();
	await first.store.install("a");
	await first.store.idle();

	// A second process on the same folder, started before the install...
	const { root } = first;
	const other = await setup({ root });
	const events: string[] = [];
	other.store.subscribe((event) => events.push(event.type));
	await other.store.list();
	expect(events).toEqual([]);
	// ...sees a model removed by the first one and says so.
	await first.store.remove("a");
	await other.store.list();
	expect(events).toEqual(["models.changed"]);
});

test("two Hatchlights installing the same model download each file once", async () => {
	const first = await setup();
	const second = await setup({ root: first.root });
	const held = gate();
	first.control.hold = held.promise;
	await first.store.install("a");
	// The first is in the middle of its first download...
	await until(async () =>
		(await first.blobs()).some((name) => name.endsWith(".part")),
	);
	// ...when the second asks for the same model, and waits for it.
	await second.store.install("a");
	await Bun.sleep(50);
	expect(second.requests).toEqual([]);

	held.open();
	first.control.hold = null;
	await Promise.all([first.store.idle(), second.store.idle()]);
	expect((await first.status("a")).ready).toBe(true);
	expect((await second.status("a")).ready).toBe(true);
	const fetched = [...first.requests, ...second.requests].map((r) => r.url);
	expect(fetched.sort()).toEqual(
		[
			url("engine.zip"),
			url("a.safetensors"),
			url("encoder.safetensors"),
		].sort(),
	);
	// No lock is left behind.
	expect((await first.blobs()).filter((n) => n.endsWith(".lock"))).toEqual([]);
});

test("models move to another folder, and stay there for every Hatchlight", async () => {
	const first = await setup();
	const locationFile = join(first.root, "..", `${crypto.randomUUID()}.json`);
	const store = new LocalModelStore({
		root: first.root,
		catalog: CATALOG,
		engines: ENGINES,
		fetch: first.fetch,
		hardware: async () => machine(24),
		checkEngine: async () => null,
		locationFile,
	});
	await store.install("a");
	await store.idle();
	const used = (await store.list()).disk.usedBytes;
	expect((await store.list()).disk.changeable).toBe(true);

	const target = await mkdtemp(join(tmpdir(), "hatchlight-target-"));
	dirs.push(target, locationFile);
	const moving: number[] = [];
	store.subscribe((event) => {
		if (event.type === "models.moving") moving.push(event.movedBytes);
	});
	await store.relocate(target);
	// Moving back is refused until the old files are gone.
	await expect(store.relocate(first.root)).rejects.toMatchObject({
		code: "modelsMoving",
	});
	await store.idle();

	const view = await store.list();
	expect(view.disk.path).toBe(target);
	expect(view.disk.usedBytes).toBe(used);
	expect(view.disk.moving).toBeNull();
	expect(view.models.find((m) => m.id === "a")?.ready).toBe(true);
	expect(moving.at(-1)).toBeGreaterThan(0);
	expect(await readdir(join(first.root, "blobs")).catch(() => [])).toEqual([]);
	// Written where every Hatchlight sharing the default folder reads it.
	expect(await Bun.file(locationFile).json()).toEqual({ path: target });

	// Another Hatchlight, still on the old folder, follows.
	const other = new LocalModelStore({
		root: first.root,
		catalog: CATALOG,
		engines: ENGINES,
		hardware: async () => machine(24),
		locationFile,
	});
	expect((await other.list()).disk.path).toBe(target);
});

test("moving the models is refused while they are in use, or without a place to write it down", async () => {
	const { store, root } = await setup();
	await expect(store.relocate("/elsewhere")).rejects.toMatchObject({
		code: "modelsFolderFixed",
	});
	expect((await store.list()).disk.changeable).toBe(false);

	const locationFile = join(root, "location.json");
	const movable = new LocalModelStore({
		root,
		catalog: CATALOG,
		engines: ENGINES,
		hardware: async () => machine(24),
		locationFile,
	});
	await expect(movable.relocate("relative/path")).rejects.toMatchObject({
		code: "folderNotAbsolute",
	});
	await expect(movable.relocate(join(root, "inside"))).rejects.toMatchObject({
		code: "folderInside",
	});
	// A local job holds the GPU.
	const it = movable.gpu.acquire(1, new AbortController().signal);
	let held = await it.next();
	while (!held.done) held = await it.next();
	const target = await mkdtemp(join(tmpdir(), "hatchlight-target-"));
	dirs.push(target);
	await expect(movable.relocate(target)).rejects.toMatchObject({
		code: "modelsBusy",
	});
	held.value.release();

	// Another Hatchlight on the folder holds the GPU.
	const other = new GpuLock({ root, capacity: async () => 2 ** 34 });
	const theirs = other.acquire(1, new AbortController().signal);
	let taken = await theirs.next();
	while (!taken.done) taken = await theirs.next();
	await expect(movable.relocate(target)).rejects.toMatchObject({
		code: "modelsBusy",
	});
	taken.value.release();
	other.close();
});

test("the same folder under another name is not moved, and nothing is lost", async () => {
	const { store: installer, root } = await setup();
	await installer.install("a");
	await installer.idle();
	// Never written: nothing moves.
	const locationFile = join(root, "..", `${crypto.randomUUID()}.json`);
	const store = new LocalModelStore({
		root,
		catalog: CATALOG,
		engines: ENGINES,
		hardware: async () => machine(24),
		locationFile,
	});
	const alias = `${root}-alias`;
	await symlink(root, alias);
	dirs.push(alias);
	await store.relocate(alias);
	await store.idle();
	expect((await store.list()).models.find((m) => m.id === "a")?.ready).toBe(
		true,
	);
	expect(await Bun.file(locationFile).exists()).toBe(false);
});

test("while another Hatchlight moves the models, nothing installs, runs or is removed", async () => {
	const { store, root } = await setup();
	await store.install("b");
	await store.idle();
	// Another Hatchlight is moving the folder.
	await Bun.write(join(root, "moving.lock"), "other");
	await expect(store.install("a")).rejects.toMatchObject({
		code: "modelsMoving",
	});
	await expect(store.runtime("b")).rejects.toMatchObject({
		code: "modelsMoving",
	});
	await expect(store.remove("b")).rejects.toMatchObject({
		code: "modelsMoving",
	});
});

test("a model another Hatchlight is installing keeps the files it shares", async () => {
	const { store, root, blobs } = await setup();
	await store.install("a");
	await store.idle();
	// Another Hatchlight is installing b, which shares a's encoder.
	await Bun.write(join(root, "installed", "b.lock"), "other");
	await store.remove("a");
	const encoder = new Bun.CryptoHasher("sha256").update(ENCODER).digest("hex");
	expect(await blobs()).toContain(encoder);
});

test("a model kept loaded lets go of its files before they are deleted or moved", async () => {
	const { store, root } = await setup();
	await store.install("a");
	await store.idle();
	const order: string[] = [];
	store.onLetGo(async () => {
		order.push("let go");
	});
	const removing = store.remove("a");
	await removing;
	order.push("removed");
	expect(order).toEqual(["let go", "removed"]);

	const movable = new LocalModelStore({
		root,
		catalog: CATALOG,
		engines: ENGINES,
		hardware: async () => machine(24),
		locationFile: join(root, "..", `${crypto.randomUUID()}.json`),
	});
	let lets = 0;
	movable.onLetGo(async () => {
		lets++;
	});
	const target = await mkdtemp(join(tmpdir(), "hatchlight-target-"));
	dirs.push(target);
	await movable.relocate(target);
	await movable.idle();
	expect(lets).toBe(1);
});

test("removing a model leaves a file another Hatchlight is downloading", async () => {
	const first = await setup();
	await first.store.install("a");
	await first.store.idle();
	const blob = (await first.blobs()).find((n) => /^[a-f0-9]{64}$/.test(n));
	// Another Hatchlight holds a download of one of its files.
	await Bun.write(join(first.root, "blobs", `${blob}.lock`), "other");
	await first.store.remove("a");
	expect(await first.blobs()).toContain(blob as string);
});

test("sizes are written in the units disks use, bytes below a kilobyte", () => {
	expect(formatBytes(0)).toBe("0 B");
	expect(formatBytes(32)).toBe("32 B");
	expect(formatBytes(1_500)).toBe("2 kB");
	expect(formatBytes(176_128)).toBe("176 kB");
	expect(formatBytes(6_938_081_905)).toBe("6.94 GB");
});
