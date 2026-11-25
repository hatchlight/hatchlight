import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { FakeProvider, type ModelSpec } from "@hatchlight/core";
import { picture, safetensors } from "@hatchlight/core/testing";
import { nearestRatio } from "./image-api";
import { createApp, createRuntime } from "./index";
import { maskPixels } from "./masks";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (base64: string) => {
	const bytes = Buffer.from(base64, "base64");
	return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
};

/** A fake whose first model takes SDXL LoRAs, like a local SDXL model. */
class LoraProvider extends FakeProvider {
	override listModels(): ModelSpec[] {
		return super
			.listModels()
			.map((m, i) =>
				i === 0
					? { ...m, capabilities: { ...m.capabilities, loraBase: "sdxl" } }
					: m,
			);
	}
}

/** An RGBA PNG whose left half is transparent: OpenAI's mask for "redraw this". */
function halfTransparent(width: number, height: number): Uint8Array {
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.byteLength);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.byteLength);
		out.set(new TextEncoder().encode(type), 4);
		out.set(data, 8);
		view.setUint32(
			8 + data.byteLength,
			crc32(out.subarray(4, 8 + data.length)),
		);
		return out;
	};
	const header = new Uint8Array(13);
	new DataView(header.buffer).setUint32(0, width);
	new DataView(header.buffer).setUint32(4, height);
	header[8] = 8;
	header[9] = 6;
	const row = 1 + width * 4;
	const rows = new Uint8Array(row * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			rows.set([200, 200, 200, x < width / 2 ? 0 : 255], y * row + 1 + x * 4);
		}
	}
	return new Uint8Array(
		Buffer.concat([
			Buffer.from(PNG_SIGNATURE),
			chunk("IHDR", header),
			chunk("IDAT", deflateSync(rows)),
			chunk("IEND", new Uint8Array()),
		]),
	);
}

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "hatchlight-image-api-"));
	const fake = new LoraProvider();
	const paid = new FakeProvider("paid");
	paid.requiresKey = true;
	const runtime = await createRuntime({
		dataDir: root,
		providers: [fake, paid],
		localModels: [],
		engines: [],
		hardware: async () => ({
			os: "linux",
			arch: "x64",
			wsl: false,
			memoryBytes: 8 * 1024 ** 3,
			gpus: [],
		}),
		checkEngine: async () => null,
		fetch: async () => new Response("not here", { status: 404 }),
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
	/** As programs send it: JSON, and no Origin. */
	const post = (
		path: string,
		body: unknown,
		headers: Record<string, string> = {},
	) =>
		call(path, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	return { app, call, post, runtime, fake, paid };
}

test("an OpenAI client makes pictures, as PNG, in a session for its app", async () => {
	const { call, post, fake } = await setup();
	const made = await post(
		"/v1/images/generations",
		{ prompt: "a red fox", n: 3, size: "1792x1024", model: "dall-e-3" },
		{ "user-agent": "OpenAI/Python 1.40.0" },
	);
	expect(made.status).toBe(200);
	const body = (await made.json()) as {
		created: number;
		data: { b64_json: string }[];
	};
	expect(body.data).toHaveLength(3);
	expect(body.data.every((d) => isPng(d.b64_json))).toBe(true);
	expect(body.created).toBeGreaterThan(0);
	// An unknown model is the best free one; the size, its nearest ratio;
	// two at a time, as the model makes them.
	expect(fake.submitted.map((s) => [s.model, s.aspectRatio, s.count])).toEqual([
		["fake/alpha", "16:9", 2],
		["fake/alpha", "16:9", 1],
	]);

	await post(
		"/v1/images/generations",
		{ prompt: "a blue fox" },
		{ "user-agent": "OpenAI/Python 1.40.0" },
	);
	await post("/v1/images/generations", { prompt: "a green fox" });
	const sessions = (await (await call("/api/sessions")).json()) as {
		title: string;
	}[];
	expect(sessions.map((s) => s.title).sort()).toEqual([
		"Image API",
		"Image API: OpenAI",
	]);
	const gallery = (await (
		await call("/api/gallery?query=fox")
	).json()) as unknown[];
	expect(gallery).toHaveLength(5);
});

test("a URL can be asked for instead, and models are named loosely", async () => {
	const { call, post, fake } = await setup();
	const made = await post("/v1/images/generations", {
		prompt: "a cat",
		model: "beta",
		response_format: "url",
	});
	const { data } = (await made.json()) as { data: { url: string }[] };
	const url = new URL(data[0]?.url ?? "");
	expect(url.origin).toBe("http://localhost:4096");
	expect((await call(url.pathname)).status).toBe(200);
	expect(fake.submitted.map((s) => s.model)).toEqual(["fake/beta"]);

	const models = (await (await call("/v1/models")).json()) as {
		object: string;
		data: { id: string; object: string; owned_by: string }[];
	};
	expect(models.object).toBe("list");
	// Paid models are off for other apps.
	expect(models.data.map((m) => m.id)).toEqual(["fake/alpha", "fake/beta"]);
	expect(models.data[0]).toMatchObject({ object: "model", owned_by: "fake" });
});

test("errors come in OpenAI's shape", async () => {
	const { call, post } = await setup();
	const many = await post("/v1/images/generations", { prompt: "x", n: 9 });
	expect(many.status).toBe(400);
	expect(await many.json()).toEqual({
		error: {
			message: "n must be a whole number from 1 to 8",
			type: "invalid_request_error",
			param: null,
			code: null,
		},
	});
	const broken = await post("/v1/images/generations", "{not json");
	expect(broken.status).toBe(400);
	expect(
		((await broken.json()) as { error: { message: string } }).error,
	).toBeDefined();
	for (const body of [
		{ prompt: "" },
		{ prompt: "x", size: "big" },
		{ prompt: "x", response_format: "gif" },
	]) {
		expect((await post("/v1/images/generations", body)).status).toBe(400);
	}
	const missing = await call("/v1/audio/speech", { method: "POST" });
	expect(missing.status).toBe(404);
	expect(
		((await missing.json()) as { error: { type: string } }).error.type,
	).toBe("invalid_request_error");
	// AUTOMATIC1111's clients read `detail`.
	const a1111 = await post("/sdapi/v1/txt2img", { prompt: "x", batch_size: 9 });
	expect(a1111.status).toBe(400);
	expect(await a1111.json()).toMatchObject({
		detail: "batch_size must be a whole number from 1 to 8",
	});
});

test("an edit uploads the pictures and turns OpenAI's mask into Hatchlight's", async () => {
	const { call, fake } = await setup();
	const form = new FormData();
	form.append(
		"image",
		new Blob([picture(8, 4)], { type: "image/png" }),
		"a.png",
	);
	form.append(
		"mask",
		new Blob([halfTransparent(8, 4)], { type: "image/png" }),
		"mask.png",
	);
	form.append("prompt", "a hat");
	form.append("n", "1");
	const made = await call("/v1/images/edits", { method: "POST", body: form });
	expect(made.status).toBe(200);
	const { data } = (await made.json()) as { data: { b64_json: string }[] };
	expect(data).toHaveLength(1);
	// The model that takes a picture and a mask.
	const [sent] = fake.submitted;
	expect(sent?.model).toBe("fake/alpha");
	const mask = await maskPixels(sent?.mask ?? new Uint8Array());
	expect([mask.width, mask.height]).toEqual([8, 4]);
	// Transparent (left) is redrawn: white.
	expect(mask.white.slice(0, 8)).toEqual([
		true,
		true,
		true,
		true,
		false,
		false,
		false,
		false,
	]);

	const none = await call("/v1/images/edits", {
		method: "POST",
		body: (() => {
			const f = new FormData();
			f.append("prompt", "x");
			return f;
		})(),
	});
	expect(none.status).toBe(400);
});

test("AUTOMATIC1111's txt2img makes batches, tells the seed, and reads LoRA tags", async () => {
	const { call, post, fake, runtime } = await setup();
	const file = safetensors(["lora_unet_input_blocks_4_1_proj_in.alpha"], {
		"modelspec.title": "Porcelain",
	});
	const added = await call("/api/loras?name=porcelain.safetensors", {
		method: "POST",
		body: file,
	});
	expect(added.status).toBe(201);

	const made = await post("/sdapi/v1/txt2img", {
		prompt: "a vase <lora:Porcelain:0.7> <lora:unknown:1>",
		negative_prompt: "blurry",
		width: 1024,
		height: 576,
		seed: -1,
		batch_size: 2,
		n_iter: 2,
		steps: 4,
	});
	expect(made.status).toBe(200);
	const body = (await made.json()) as {
		images: string[];
		parameters: Record<string, unknown>;
		info: string;
	};
	expect(body.images).toHaveLength(4);
	expect(body.images.every(isPng)).toBe(true);
	expect(body.parameters).toMatchObject({ steps: 4, batch_size: 2 });
	const info = JSON.parse(body.info) as {
		seed: number;
		all_seeds: number[];
		sd_model_name: string;
	};
	expect(info.seed).toBeGreaterThanOrEqual(0);
	expect(info.all_seeds).toEqual([0, 1, 2, 3].map((i) => info.seed + i));
	expect(info.sd_model_name).toBe("fake/alpha");
	expect(fake.submitted.map((s) => s.aspectRatio)).toEqual(["16:9", "16:9"]);
	// The known LoRA is used; the unknown tag is left as written.
	expect(fake.submitted[0]?.prompt).toBe("a vase <lora:unknown:1>");
	const [session] = (await runtime.service.listSessions({
		userId: "local",
	})) as { id: string }[];
	const detail = await runtime.service.getSession(
		{ userId: "local" },
		session?.id ?? "",
	);
	expect(detail.turns[0]?.jobs[0]?.params.loras).toEqual([
		{ id: "porcelain", weight: 0.7 },
	]);
	expect(detail.turns[0]?.jobs[0]?.params.seed).toBe(info.seed);
});

test("img2img redraws a picture, with a mask read either way round", async () => {
	const { post, fake } = await setup();
	const image = Buffer.from(picture(8, 4)).toString("base64");
	const made = await post("/sdapi/v1/img2img", {
		prompt: "make it gold",
		init_images: [`data:image/png;base64,${image}`],
		mask: Buffer.from(picture(8, 4)).toString("base64"),
		inpainting_mask_invert: 1,
		denoising_strength: 0.6,
	});
	expect(made.status).toBe(200);
	expect(((await made.json()) as { images: string[] }).images).toHaveLength(1);
	// The mid-grey mask reads as white; inverted, all of it is kept.
	const mask = await maskPixels(fake.submitted[0]?.mask ?? new Uint8Array());
	expect(mask.white.some(Boolean)).toBe(false);

	expect(
		(await post("/sdapi/v1/img2img", { prompt: "x", init_images: [] })).status,
	).toBe(400);
	expect(
		(
			await post("/sdapi/v1/img2img", {
				prompt: "x",
				init_images: [image],
				denoising_strength: 2,
			})
		).status,
	).toBe(400);
});

test("the model chosen through options is the default, kept in settings", async () => {
	const { call, post, fake } = await setup();
	const models = (await (await call("/sdapi/v1/sd-models")).json()) as {
		title: string;
		model_name: string;
	}[];
	expect(models.map((m) => m.title)).toEqual(["fake/alpha", "fake/beta"]);
	const current = async () =>
		(
			(await (await call("/sdapi/v1/options")).json()) as {
				sd_model_checkpoint: string;
			}
		).sd_model_checkpoint;
	expect(await current()).toBe("fake/alpha");

	expect(
		(await post("/sdapi/v1/options", { sd_model_checkpoint: "Fake beta" }))
			.status,
	).toBe(200);
	expect(await current()).toBe("fake/beta");
	expect(
		((await (await call("/api/settings")).json()) as { otherAppsModel: string })
			.otherAppsModel,
	).toBe("fake/beta");
	await post("/sdapi/v1/txt2img", { prompt: "a boat" });
	// A model named in the request wins.
	await post("/sdapi/v1/txt2img", {
		prompt: "a boat",
		override_settings: { sd_model_checkpoint: "fake/alpha" },
	});
	expect(fake.submitted.map((s) => s.model)).toEqual([
		"fake/beta",
		"fake/alpha",
	]);

	const unknown = await post("/sdapi/v1/options", {
		sd_model_checkpoint: "nope",
	});
	expect(unknown.status).toBe(400);
	// What clients look at before they start.
	for (const path of [
		"/sdapi/v1/samplers",
		"/sdapi/v1/schedulers",
		"/sdapi/v1/upscalers",
		"/sdapi/v1/sd-vae",
		"/sdapi/v1/loras",
	]) {
		expect(Array.isArray(await (await call(path)).json())).toBe(true);
	}
	expect(await (await call("/sdapi/v1/progress")).json()).toMatchObject({
		progress: 0,
		state: { job_count: 0 },
	});
});

test("paid models are refused until the person lets other apps use them", async () => {
	const { call, post, paid } = await setup();
	await call("/api/providers/paid/key", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: "k" }),
	});
	const ask = () =>
		post("/v1/images/generations", { prompt: "x", model: "paid/alpha" });
	const refused = await ask();
	expect(refused.status).toBe(403);
	expect(
		((await refused.json()) as { error: { code: string } }).error.code,
	).toBe("otherAppsPaidOff");
	expect(paid.submitted).toHaveLength(0);
	expect(
		(await post("/sdapi/v1/options", { sd_model_checkpoint: "paid/alpha" }))
			.status,
	).toBe(403);

	const turnedOn = await call("/api/settings", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ otherAppsPaid: true }),
	});
	expect(await turnedOn.json()).toMatchObject({ otherAppsPaid: true });
	expect((await ask()).status).toBe(200);
	expect(paid.submitted).toHaveLength(1);
	const models = (await (await call("/v1/models")).json()) as {
		data: { id: string }[];
	};
	expect(models.data.map((m) => m.id)).toContain("paid/alpha");
	// Unasked, an app still gets a free model.
	await post("/v1/images/generations", { prompt: "y" });
	expect(paid.submitted).toHaveLength(1);

	expect(
		(
			await call("/api/settings", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ otherAppsPaid: "yes" }),
			})
		).status,
	).toBe(400);
});

test("web pages on other sites are refused; programs are not", async () => {
	const { app, call, post } = await setup();
	const evil = await post(
		"/v1/images/generations",
		{ prompt: "x" },
		{ origin: "https://evil.example" },
	);
	expect(evil.status).toBe(403);
	// A page sending no Origin still says where it is.
	const sneaky = await post(
		"/sdapi/v1/txt2img",
		{ prompt: "x" },
		{ "sec-fetch-site": "cross-site" },
	);
	expect(sneaky.status).toBe(403);
	const preflight = await call("/v1/images/generations", {
		method: "OPTIONS",
		headers: {
			origin: "https://evil.example",
			"access-control-request-method": "POST",
		},
	});
	expect(preflight.status).toBe(403);
	expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
	// Another name for this computer, as DNS rebinding would use.
	expect((await app.request("http://evil.example:4096/v1/models")).status).toBe(
		403,
	);
	expect((await call("/v1/models")).status).toBe(200);
});

test("a client that goes away cancels what it asked for", async () => {
	const { app, fake, runtime } = await setup();
	fake.gate = new Promise(() => {});
	const controller = new AbortController();
	const answer = app.request("http://localhost:4096/v1/images/generations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ prompt: "slow" }),
		signal: controller.signal,
	});
	while (fake.submitted.length === 0) await Bun.sleep(5);
	controller.abort();
	expect((await answer).status).toBe(499);
	await runtime.engine.idle();
	const [session] = await runtime.service.listSessions({ userId: "local" });
	const detail = await runtime.service.getSession(
		{ userId: "local" },
		session?.id ?? "",
	);
	expect(detail.turns[0]?.jobs[0]?.status).toBe("canceled");
});

test("bodies are limited, and pictures too large are refused clearly", async () => {
	const { call, post } = await setup();
	const big = await post("/v1/images/generations", {
		prompt: "x".repeat(1024 * 1024 + 10),
	});
	expect(big.status).toBe(413);
	expect(
		((await big.json()) as { error: { message: string } }).error.message,
	).toBe("The request is too large");
	const huge = "A".repeat(28 * 1024 * 1024);
	const img = await post("/sdapi/v1/img2img", {
		prompt: "x",
		init_images: [huge],
	});
	expect(img.status).toBe(413);
	expect(((await img.json()) as { detail: string }).detail).toBe(
		"A picture is larger than 20 MB",
	);
	const form = new FormData();
	form.append("image", new Blob([new Uint8Array(21 * 1024 * 1024)]), "a.png");
	form.append("prompt", "x");
	expect(
		(await call("/v1/images/edits", { method: "POST", body: form })).status,
	).toBe(413);
});

test("sizes map to the nearest ratio a model offers", () => {
	const ratios = ["1:1", "16:9", "9:16", "4:3"];
	expect(nearestRatio(ratios, 1024, 1024)).toBe("1:1");
	expect(nearestRatio(ratios, 1792, 1024)).toBe("16:9");
	expect(nearestRatio(ratios, 1024, 1792)).toBe("9:16");
	expect(nearestRatio(ratios, 1536, 1024)).toBe("4:3");
	expect(nearestRatio([], 1024, 1024)).toBeUndefined();
	expect(nearestRatio(ratios, undefined, undefined)).toBeUndefined();
});
