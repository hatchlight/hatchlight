import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubTarget } from "../hugging-face";
import type { LocalModelEvent, LocalModelSpec } from "../types";
import { catalogModelFor, hubFetch, resolveHub } from "./hub";
import { LocalModelStore } from "./store";
import { safetensors } from "./testing";

/** The names a whole SDXL model has, as in sd_xl_base_1.0.safetensors. */
const SDXL = [
	"model.diffusion_model.input_blocks.0.0.weight",
	"conditioner.embedders.0.transformer.text_model.embeddings.position_ids",
	"conditioner.embedders.1.model.ln_final.weight",
	"first_stage_model.decoder.conv_in.weight",
];
const SDXL_LORA = ["lora_unet_input_blocks_4_1_proj_in.alpha"];
/** One part of a diffusers pipeline: neither a whole model nor a LoRA. */
const PART = ["decoder.conv_in.weight", "encoder.conv_in.weight"];

const SHA = "a".repeat(40);
const sha256 = (data: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(data).digest("hex");

interface FakeRepo {
	files: Record<string, Uint8Array>;
	gated?: boolean | string;
	license?: string;
	/** Hashes Hugging Face says the files have, when not their own. */
	hashes?: Record<string, string>;
}

/**
 * Hugging Face's API and file servers, for tests: nothing leaves the
 * machine. Files are sent from a redirect to its file servers, as it does.
 */
function fakeHub(repos: Record<string, FakeRepo>, options = { ranges: true }) {
	const asked: string[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		asked.push(url);
		const { hostname, pathname, searchParams } = new URL(url);
		if (hostname === "cas-bridge.xethub.hf.co") {
			const data = new Uint8Array(
				await Bun.file(searchParams.get("blob") ?? "").arrayBuffer(),
			);
			const range = new Headers(init?.headers).get("range");
			const match = range?.match(/^bytes=(\d+)-(\d+)$/);
			if (match && options.ranges) {
				const [, from, to] = match.map(Number) as [number, number, number];
				return new Response(data.slice(from, to + 1), { status: 206 });
			}
			return new Response(data);
		}
		if (hostname !== "huggingface.co") throw new Error(`Asked ${url}`);
		const api = pathname.match(
			/^\/api\/models\/([^/]+\/[^/]+)\/revision\/(\w+)$/,
		);
		if (api) {
			const repo = repos[api[1] as string];
			if (!repo) return Response.json({ error: "Not found" }, { status: 404 });
			return Response.json({
				id: api[1],
				sha: SHA,
				gated: repo.gated ?? false,
				cardData: repo.license ? { license: repo.license } : {},
				tags: ["diffusers"],
				siblings: Object.entries(repo.files).map(([name, data]) => ({
					rfilename: name,
					size: data.byteLength,
					...(name.endsWith(".safetensors") && {
						lfs: {
							sha256: repo.hashes?.[name] ?? sha256(data),
							size: data.byteLength,
						},
					}),
				})),
			});
		}
		const file = pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/(\w+)\/(.+)$/);
		const data =
			file && repos[file[1] as string]?.files[decodeURI(file[3] as string)];
		if (!file || file[2] !== SHA || !data)
			return new Response("", { status: 404 });
		// Kept on disk so the redirect can name it, like a signed address.
		const blob = join(await scratch(), sha256(data));
		await Bun.write(blob, data);
		return new Response(null, {
			status: 302,
			headers: {
				location: `https://cas-bridge.xethub.hf.co/x?${new URLSearchParams({ blob })}`,
			},
		});
	};
	return { fetch, asked };
}

const dirs: string[] = [];
async function scratch() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-hub-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

const CATALOG: LocalModelSpec[] = [
	{
		id: "sdxl-base",
		name: "SDXL",
		author: "Stability AI",
		media: "image",
		tasks: ["text-to-image"],
		summary: "",
		license: "OpenRAIL++",
		licenseUrl: "https://license.example",
		commercial: { kind: "allowed" },
		homepage: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0",
		variants: [
			{
				id: "q8",
				label: "8-bit",
				engine: "sd-cpp",
				memoryBytes: 1,
				files: [
					{
						name: "sdxl.gguf",
						url: `https://huggingface.co/Mirror/SDXL-GGUF/resolve/${SHA}/sdxl-q8.gguf`,
						size: 1,
						sha256: "0".repeat(64),
						role: "model",
					},
				],
			},
		],
		demos: [],
		defaults: { size: 1024, aspectRatios: ["1:1"], steps: 30, cfgScale: 7 },
	},
];

const target = (repo: string, file: string | null = null): HubTarget => ({
	repo,
	file,
});

describe("a repository the catalog knows", () => {
	test("is found by its page or its files, whatever the case", () => {
		expect(
			catalogModelFor(
				CATALOG,
				target("stabilityai/stable-diffusion-xl-base-1.0"),
			),
		).toBe("sdxl-base");
		expect(catalogModelFor(CATALOG, target("mirror/sdxl-gguf"))).toBe(
			"sdxl-base",
		);
		expect(
			catalogModelFor(CATALOG, target("Mirror/SDXL-GGUF", "sdxl-q8.gguf")),
		).toBe("sdxl-base");
		expect(catalogModelFor(CATALOG, target("someone/else"))).toBeNull();
		// Not a repository whose name only starts the same.
		expect(catalogModelFor(CATALOG, target("Mirror/SDXL"))).toBeNull();
	});

	test("opens its install without asking Hugging Face", async () => {
		const hub = fakeHub({});
		expect(
			await resolveHub(target("Mirror/SDXL-GGUF"), CATALOG, hub.fetch),
		).toEqual({
			kind: "catalog",
			repo: "Mirror/SDXL-GGUF",
			modelId: "sdxl-base",
		});
		expect(hub.asked).toEqual([]);
	});
});

describe("a single file", () => {
	const hub = () =>
		fakeHub({
			"someone/checkpoint": {
				files: {
					"README.md": new Uint8Array(4),
					"juggernaut.safetensors": safetensors(SDXL),
				},
				license: "openrail++",
			},
			"someone/lora": {
				files: { "folder/style.safetensors": safetensors(SDXL_LORA) },
			},
		});

	test("a whole SDXL model is a checkpoint, with its size and license", async () => {
		const fake = hub();
		const choice = await resolveHub(
			target("someone/checkpoint"),
			[],
			fake.fetch,
		);
		expect(choice).toMatchObject({
			kind: "checkpoint",
			repo: "someone/checkpoint",
			file: "juggernaut.safetensors",
			revision: SHA,
			size: safetensors(SDXL).byteLength,
			license: "openrail++",
			base: "sdxl",
		});
		// Only Hugging Face and its file servers were asked.
		for (const url of fake.asked) {
			expect(new URL(url).hostname).toMatch(/(^|\.)(huggingface\.co|hf\.co)$/);
		}
	});

	test("a LoRA named by the link is a LoRA, even in a folder", async () => {
		expect(
			await resolveHub(
				target("someone/lora", "folder/style.safetensors"),
				[],
				hub().fetch,
			),
		).toMatchObject({ kind: "lora", base: "sdxl", license: null });
	});

	test("its kind is read the same from a server that ignores ranges", async () => {
		const fake = fakeHub(
			{
				"someone/lora": { files: { "a.safetensors": safetensors(SDXL_LORA) } },
			},
			{ ranges: false },
		);
		expect(
			await resolveHub(target("someone/lora"), [], fake.fetch),
		).toMatchObject({ kind: "lora", file: "a.safetensors" });
	});
});

test("a license is read from the card or the tags, without control characters", async () => {
	const file = safetensors(SDXL_LORA);
	const license = async (info: Record<string, unknown>) => {
		const choice = await resolveHub(target("a/b"), [], async (url) =>
			url.includes("/api/")
				? Response.json({
						sha: SHA,
						siblings: [{ rfilename: "a.safetensors", size: file.byteLength }],
						...info,
					})
				: new Response(file),
		);
		return choice.kind === "lora" ? choice.license : choice.kind;
	};
	expect(await license({ tags: ["license:apache-2.0"] })).toBe("apache-2.0");
	expect(
		await license({
			cardData: { license: "other", license_name: "flux-1-dev-non-commercial" },
		}),
	).toBe("flux-1-dev-non-commercial");
	expect(await license({ cardData: { license: "mit\u001b[2J\u0007" } })).toBe(
		"mit[2J",
	);
	expect(await license({})).toBeNull();
});

describe("what is not supported yet", () => {
	const reason = async (
		repos: Record<string, FakeRepo>,
		repo: string,
		file: string | null = null,
	) => {
		const choice = await resolveHub(
			target(repo, file),
			[],
			fakeHub(repos).fetch,
		);
		return choice.kind === "unsupported" ? choice.reason : choice.kind;
	};

	test("says why", async () => {
		expect(await reason({}, "no/such")).toBe("notFound");
		expect(
			await reason(
				{
					"a/b": {
						files: { "m.safetensors": safetensors(SDXL) },
						gated: "auto",
					},
				},
				"a/b",
			),
		).toBe("gated");
		// A diffusers pipeline: its files are all in folders.
		expect(
			await reason(
				{
					"a/b": {
						files: {
							"model_index.json": new Uint8Array(2),
							"vae/diffusion_pytorch_model.safetensors": safetensors(PART),
						},
					},
				},
				"a/b",
			),
		).toBe("noFile");
		expect(
			await reason(
				{
					"a/b": {
						files: {
							"one.safetensors": safetensors(SDXL_LORA),
							"two.safetensors": safetensors(SDXL_LORA),
						},
					},
				},
				"a/b",
			),
		).toBe("manyFiles");
		const repos = {
			"a/b": {
				files: {
					"model.ckpt": new Uint8Array(16),
					"vae/diffusion_pytorch_model.safetensors": safetensors(PART),
				},
			},
		};
		expect(await reason(repos, "a/b", "missing.safetensors")).toBe(
			"fileNotFound",
		);
		expect(await reason(repos, "a/b", "model.ckpt")).toBe("notSafetensors");
		expect(
			await reason(repos, "a/b", "vae/diffusion_pytorch_model.safetensors"),
		).toBe("unknownFile");
		// Not a safetensors file inside, whatever its name says.
		expect(
			await reason(
				{ "a/b": { files: { "x.safetensors": new Uint8Array(64) } } },
				"a/b",
			),
		).toBe("unknownFile");
	});
});

describe("asking Hugging Face", () => {
	test("redirects are followed only to its own servers, over https", async () => {
		const to = (location: string) => async () =>
			new Response(null, { status: 302, headers: { location } });
		for (const location of [
			"https://evil.example/file",
			"http://cdn-lfs.hf.co/file",
			"https://huggingface.co.evil.example/file",
			"https://user@huggingface.co/file",
		]) {
			await expect(
				hubFetch(to(location), "https://huggingface.co/a/b"),
			).rejects.toMatchObject({ code: "hubUnreachable" });
		}
		await expect(
			hubFetch(async () => new Response("ok"), "https://evil.example/"),
		).rejects.toMatchObject({ code: "hubUnreachable" });
		const ok = await hubFetch(
			async (url) =>
				url.startsWith("https://huggingface.co/")
					? new Response(null, {
							status: 307,
							headers: { location: "https://cdn-lfs.hf.co/x" },
						})
					: new Response("the file"),
			"https://huggingface.co/a/b",
		);
		expect(await ok.text()).toBe("the file");
	});

	test("a server error or an unreachable network is said as such", async () => {
		await expect(
			resolveHub(
				target("a/b"),
				[],
				async () => new Response("", { status: 503 }),
			),
		).rejects.toMatchObject({
			code: "hubUnreachable",
			params: { status: 503 },
		});
		await expect(
			resolveHub(target("a/b"), [], async () => {
				throw new TypeError("offline");
			}),
		).rejects.toMatchObject({ code: "hubUnreachable" });
	});
});

describe("adding a file from Hugging Face", () => {
	async function store(repos: Record<string, FakeRepo>) {
		const hub = fakeHub(repos);
		const models = new LocalModelStore({
			root: await scratch(),
			catalog: [],
			engines: [],
			fetch: hub.fetch,
			hardware: async () => ({
				os: "linux",
				arch: "x64",
				wsl: false,
				memoryBytes: 8e9,
				gpus: [],
			}),
		});
		const events: LocalModelEvent[] = [];
		models.subscribe((event) => events.push(event));
		return { models, events, hub };
	}

	test("a checkpoint and a LoRA go to their shelves, with progress", async () => {
		const { models, events } = await store({
			"someone/checkpoint": {
				files: { "juggernaut.safetensors": safetensors(SDXL) },
			},
			"someone/lora": {
				files: { "style.safetensors": safetensors(SDXL_LORA) },
			},
		});
		const added = await models.addFromHub(
			target("someone/checkpoint", "juggernaut.safetensors"),
			SHA,
		);
		expect(added).toMatchObject({
			kind: "checkpoint",
			item: { id: "juggernaut", base: "sdxl" },
		});
		expect((await models.checkpoints.list()).map((c) => c.id)).toEqual([
			"juggernaut",
		]);
		expect(events).toContainEqual({
			type: "hub.progress",
			repo: "someone/checkpoint",
			file: "juggernaut.safetensors",
			receivedBytes: 0,
			size: safetensors(SDXL).byteLength,
		});
		const lora = await models.addFromHub(
			target("someone/lora", "style.safetensors"),
			SHA,
		);
		expect(lora).toMatchObject({ kind: "lora", item: { id: "style" } });
	});

	test("a file that does not match its hash is not kept", async () => {
		const { models } = await store({
			"someone/lora": {
				files: { "style.safetensors": safetensors(SDXL_LORA) },
				hashes: { "style.safetensors": "0".repeat(64) },
			},
		});
		await expect(
			models.addFromHub(target("someone/lora", "style.safetensors"), SHA),
		).rejects.toMatchObject({ code: "hashMismatch" });
		expect(await models.loras.list()).toEqual([]);
		const left = await readdir(join(models.loras.path("x"), "..")).catch(
			() => [],
		);
		expect(left.filter((name) => name.endsWith(".part"))).toEqual([]);
	});

	test("what is not a checkpoint or a LoRA, or no revision, is refused", async () => {
		const { models } = await store({
			"a/b": { files: { "vae.safetensors": safetensors(PART) } },
		});
		await expect(
			models.addFromHub(target("a/b", "vae.safetensors"), SHA),
		).rejects.toMatchObject({
			code: "hubUnsupported",
			params: { reason: "unknownFile" },
		});
		await expect(
			models.addFromHub(target("a/b", "vae.safetensors"), "main"),
		).rejects.toMatchObject({ code: "hubInvalid" });
		await expect(models.addFromHub(target("a/b"), SHA)).rejects.toMatchObject({
			code: "hubInvalid",
		});
	});
});
