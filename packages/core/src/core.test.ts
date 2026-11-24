import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	adaptParams,
	FakeProvider,
	FileKeyStore,
	FsAssetStore,
	JobEngine,
	LOCAL_USER,
	type ModelSpec,
	type ProviderEvent,
	ProviderRegistry,
	ReelService,
	SqliteRepository,
	sniffMime,
	type Translator,
	ValidationError,
} from "./index";

const dirs: string[] = [];
/** The PNG signature plus one byte: enough to pass as an uploaded image. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-"));
	dirs.push(dir);
	return dir;
}

/** The start of an MP4 file: a box size, then "ftyp" and a brand. */
const MP4 = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypisom")]);

const CLIP: ModelSpec = {
	id: "fake/clip",
	providerId: "fake",
	providerModelId: "clip",
	name: "Fake clip",
	media: "video",
	operations: ["generate", "edit"],
	capabilities: {
		aspectRatios: ["16:9"],
		seed: false,
		maxCount: 1,
		maxReferenceImages: 1,
		durations: [4, 6, 8],
	},
	pricing: { usdPerSecond: 0.1 },
};

/** A fake whose one model makes videos, answered as a link to download. */
class FakeVideoProvider extends FakeProvider {
	output = {
		url: "https://cdn.example/clip",
		headers: { authorization: "Bearer k" },
	};

	override listModels(): ModelSpec[] {
		return [CLIP];
	}

	override async *events(): AsyncIterable<ProviderEvent> {
		yield { type: "completed", outputs: [this.output] };
	}
}

/** A fake that decides whether it can resume by looking at the handle. */
class PerHandleProvider extends FakeProvider {
	isResumable(): boolean {
		return true;
	}
}

/** Builds the whole core on `dir`, as a fresh process would. */
function boot(
	dir: string,
	provider = new FakeProvider(),
	concurrency = 4,
	translator?: Translator,
) {
	const repo = new SqliteRepository(join(dir, "db.sqlite"));
	const assets = new FsAssetStore(join(dir, "assets"));
	const keys = new FileKeyStore(
		join(dir, "auth.json"),
		crypto.getRandomValues(new Uint8Array(32)),
	);
	const registry = new ProviderRegistry().register(provider);
	const engine = new JobEngine({
		repo,
		assets,
		registry,
		keys,
		concurrencyPerProvider: concurrency,
		retryDelayMs: 1,
		translator: () => translator ?? null,
	});
	const service = new ReelService({ repo, assets, registry, keys, engine });
	return { repo, assets, keys, engine, service, provider };
}

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** Lets queued engine work reach its next await point. */
const settle = () => Bun.sleep(20);

describe("turns", () => {
	test("one prompt on two models yields one finished job per model", async () => {
		const app = boot(await tempDir());
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "a red fox",
			modelIds: ["fake/alpha", "fake/beta"],
			count: 2,
		});
		await app.engine.idle();

		const { turns, title } = await app.service.getSession(
			LOCAL_USER,
			session.id,
		);
		expect(title).toBe("a red fox");
		expect(turns).toHaveLength(1);
		const jobs = turns[0]?.jobs ?? [];
		expect(jobs.map((j) => j.modelId)).toEqual(["fake/alpha", "fake/beta"]);
		for (const job of jobs) {
			expect(job.status).toBe("succeeded");
			expect(job.assets).toHaveLength(2);
			expect(job.costUsd).toBeCloseTo(0.02);
		}

		const assetId = jobs[0]?.assets[0]?.id as string;
		const file = await app.service.getAssetFile(LOCAL_USER, assetId);
		expect(file.asset.mime).toBe("image/bmp");
		expect(file.blob.size).toBeGreaterThan(0);
	});

	test("a chosen output becomes the reference of the next turn", async () => {
		const app = boot(await tempDir());
		const first = await app.service.createTurn(LOCAL_USER, {
			prompt: "a red fox",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const session = await app.service.getSession(LOCAL_USER, first.session.id);
		const chosen = session.turns[0]?.jobs[0]?.assets[0]?.id as string;

		await app.service.createTurn(LOCAL_USER, {
			sessionId: session.id,
			prompt: "make it snow",
			modelIds: ["fake/alpha"],
			referenceAssetIds: [chosen],
		});
		await app.engine.idle();

		const after = await app.service.getSession(LOCAL_USER, session.id);
		expect(after.turns).toHaveLength(2);
		expect(after.turns[1]?.referenceAssetIds).toEqual([chosen]);
		expect(after.turns[1]?.jobs[0]?.status).toBe("succeeded");
	});

	test("parameters are fitted to each model", async () => {
		const app = boot(await tempDir());
		const { turn } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
			count: 5,
			aspectRatio: "9:21",
		});
		expect(turn.jobs[0]?.params.count).toBe(2);
		expect(turn.jobs[0]?.params.aspectRatio).toBeUndefined();
		await app.engine.idle();
	});

	test("rejects references for a model that cannot take them", async () => {
		const app = boot(await tempDir());
		const upload = await app.service.uploadAsset(LOCAL_USER, PNG);
		expect(
			app.service.createTurn(LOCAL_USER, {
				prompt: "x",
				modelIds: ["fake/alpha", "fake/beta"],
				referenceAssetIds: [upload.id],
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(await app.service.listSessions(LOCAL_USER)).toHaveLength(0);
	});

	test("a mask marks what of the reference a model redraws", async () => {
		const app = boot(await tempDir());
		const picture = await app.service.uploadAsset(LOCAL_USER, PNG);
		const mask = await app.service.uploadAsset(LOCAL_USER, PNG);
		const turn = (modelIds: string[], over: object = {}) =>
			app.service.createTurn(LOCAL_USER, {
				prompt: "x",
				modelIds,
				referenceAssetIds: [picture.id],
				maskAssetId: mask.id,
				...over,
			});
		await turn(["fake/alpha"]);
		await app.engine.idle();
		expect(app.provider.submitted[0]?.mask).toEqual(PNG);

		await expect(turn(["fake/alpha", "fake/beta"])).rejects.toMatchObject({
			code: "noReferences",
		});
		await expect(
			turn(["fake/alpha"], { referenceAssetIds: [] }),
		).rejects.toMatchObject({ code: "maskWithoutReference" });
		await expect(
			turn(["fake/alpha"], { referenceAssetIds: [picture.id, mask.id] }),
		).rejects.toMatchObject({ code: "maskWithoutReference" });
		await expect(
			turn(["fake/alpha"], { maskAssetId: "ast_missing" }),
		).rejects.toMatchObject({ code: "referenceNotFound" });
	});

	test("an upscaler is refused without a picture to enlarge", () => {
		const upscaler = {
			...CLIP,
			capabilities: {
				...CLIP.capabilities,
				maxReferenceImages: 1,
				upscale: 4,
			},
		};
		const params = { prompt: "x", count: 1, extras: {} };
		expect(() =>
			adaptParams(upscaler, { ...params, referenceAssetIds: [] }),
		).toThrow(expect.objectContaining({ code: "needsPicture" }));
		expect(
			adaptParams(upscaler, { ...params, referenceAssetIds: ["a"] })
				.referenceAssetIds,
		).toEqual(["a"]);
	});

	test("LoRAs go only to models that take them, so a comparison still runs", () => {
		const params = {
			prompt: "x",
			count: 1,
			referenceAssetIds: [],
			extras: {},
			loras: [{ id: "porcelain", weight: 0.8 }],
		};
		expect(adaptParams(CLIP, params).loras).toBeUndefined();
		expect(
			adaptParams(
				{ ...CLIP, capabilities: { ...CLIP.capabilities, loraBase: "sdxl" } },
				params,
			).loras,
		).toEqual([{ id: "porcelain", weight: 0.8 }]);
	});

	test("a model that cannot take a mask is refused one", () => {
		const params = {
			prompt: "x",
			count: 1,
			referenceAssetIds: ["a"],
			extras: {},
			maskAssetId: "m",
		};
		const model = {
			...CLIP,
			capabilities: { ...CLIP.capabilities, maxReferenceImages: 1 },
		};
		expect(() => adaptParams(model, params)).toThrow(
			expect.objectContaining({ code: "noMask" }),
		);
		expect(
			adaptParams(
				{ ...model, capabilities: { ...model.capabilities, mask: 0.85 } },
				params,
			).maskAssetId,
		).toBe("m");
	});

	test("rejects unknown models and empty prompts", async () => {
		const app = boot(await tempDir());
		expect(
			app.service.createTurn(LOCAL_USER, { prompt: "x", modelIds: ["nope/x"] }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(
			app.service.createTurn(LOCAL_USER, {
				prompt: "  ",
				modelIds: ["fake/alpha"],
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});
});

describe("job engine", () => {
	test("a provider failure fails only that job, with its message", async () => {
		const app = boot(await tempDir());
		app.provider.failWith = "content policy";
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.status).toBe("failed");
		expect(job?.error).toBe("content policy");
		expect(job?.assets).toHaveLength(0);
	});

	test("canceling a running job stops it and tells the provider", async () => {
		const app = boot(await tempDir());
		app.provider.gate = gate().promise;
		const { turn, session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await settle();
		await app.service.cancelJob(LOCAL_USER, turn.jobs[0]?.id as string);
		await app.engine.idle();

		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.status).toBe("canceled");
		expect(app.provider.canceled).toHaveLength(1);
	});

	test("a job shows the picture as it forms, only to its owner and only while running", async () => {
		const app = boot(await tempDir());
		const g = gate();
		app.provider.gate = g.promise;
		const progress: unknown[] = [];
		app.engine.subscribe((_, event) => {
			if (event.type === "job.progress") progress.push(event);
		});
		const { turn } = await app.service.createTurn(LOCAL_USER, {
			prompt: "a red fox",
			modelIds: ["fake/alpha"],
		});
		const jobId = turn.jobs[0]?.id as string;
		await settle();

		// The event only counts pictures; the picture itself is fetched.
		expect(progress).toEqual([
			expect.objectContaining({ jobId, fraction: 0.5, preview: 1 }),
		]);
		const preview = app.service.jobPreview(LOCAL_USER, jobId);
		expect(preview.mime).toBe("image/bmp");
		expect(preview.data.length).toBeGreaterThan(54);
		expect(() =>
			app.service.jobPreview({ userId: "someone-else" }, jobId),
		).toThrow();

		g.open();
		await app.engine.idle();
		expect(() => app.service.jobPreview(LOCAL_USER, jobId)).toThrow();
	});

	test("runs at most the configured number of jobs per provider", async () => {
		const app = boot(await tempDir(), new FakeProvider(), 1);
		const g = gate();
		app.provider.gate = g.promise;
		const { turn, session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha", "fake/beta"],
		});
		await settle();

		const during = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs;
		expect(during?.map((j) => j.status)).toEqual(["running", "queued"]);

		// A job still waiting for a slot can be canceled too.
		await app.service.cancelJob(LOCAL_USER, turn.jobs[1]?.id as string);
		g.open();
		await app.engine.idle();
		const after = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs;
		expect(after?.map((j) => j.status)).toEqual(["succeeded", "canceled"]);
		expect(app.provider.submitted).toHaveLength(1);
	});

	test("a provider can run fewer jobs at once than the engine allows", async () => {
		const provider = Object.assign(new FakeProvider(), { maxConcurrency: 1 });
		const app = boot(await tempDir(), provider, 4);
		const g = gate();
		provider.gate = g.promise;
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha", "fake/beta"],
		});
		await settle();
		const during = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs;
		expect(during?.map((j) => j.status)).toEqual(["running", "queued"]);
		g.open();
		await app.engine.idle();
	});

	test("a job waiting in line is told its place, and moves up", async () => {
		const provider = Object.assign(new FakeProvider(), { maxConcurrency: 1 });
		const app = boot(await tempDir(), provider, 4);
		const places: string[] = [];
		app.engine.subscribe((_, event) => {
			if (event.type === "job.progress" && event.stage === "queued") {
				places.push(`${event.jobId}@${event.position}`);
			}
		});
		const g = gate();
		provider.gate = g.promise;
		const first = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha", "fake/beta"],
		});
		const later = await app.service.createTurn(LOCAL_USER, {
			prompt: "y",
			modelIds: ["fake/alpha"],
		});
		await settle();
		const second = first.turn.jobs[1]?.id;
		const third = later.turn.jobs[0]?.id;
		expect(places.slice(-2)).toEqual([`${second}@1`, `${third}@2`]);
		g.open();
		await app.engine.idle();
		// Once the first finished, the last one was next.
		expect(places).toContain(`${third}@1`);
	});

	test("a provider's lines each run their own jobs", async () => {
		const provider = Object.assign(
			new FakeProvider("fake", ["alpha", "beta", "gamma"]),
			{
				maxConcurrency: 1,
				lineOf: (modelId: string) => (modelId === "fake/gamma" ? "b" : "a"),
			},
		);
		const app = boot(await tempDir(), provider, 4);
		const g = gate();
		provider.gate = g.promise;
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha", "fake/beta", "fake/gamma"],
		});
		await settle();
		const during = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs;
		// The third job is in another line: it does not wait behind the second.
		expect(during?.map((j) => j.status)).toEqual([
			"running",
			"queued",
			"running",
		]);
		g.open();
		await app.engine.idle();
	});

	test("a passing failure is tried again, and the job then succeeds", async () => {
		const app = boot(await tempDir());
		app.provider.failures = [
			{ type: "failed", error: "busy", code: "providerBusy", retry: {} },
		];
		const stages: unknown[] = [];
		app.engine.subscribe((_, event) => {
			if (event.type === "job.progress") stages.push(event.stage);
		});
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const [job] =
			(await app.service.getSession(LOCAL_USER, session.id)).turns[0]?.jobs ??
			[];
		expect(job?.status).toBe("succeeded");
		expect(stages).toContain("retrying");
		// Tried again on the same request: nothing was sent twice.
		expect(app.provider.submitted).toHaveLength(1);
	});

	test("a failure that is not passing is not tried again", async () => {
		const app = boot(await tempDir());
		app.provider.failures = [
			{ type: "failed", error: "content refused" },
			{ type: "failed", error: "never reached" },
		];
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const [job] =
			(await app.service.getSession(LOCAL_USER, session.id)).turns[0]?.jobs ??
			[];
		expect(job?.status).toBe("failed");
		expect(job?.error).toBe("content refused");
		expect(app.provider.failures).toHaveLength(1);
	});

	test("trying again stops at the failure's limit", async () => {
		const app = boot(await tempDir());
		const crash = {
			type: "failed" as const,
			error: "crashed",
			code: "engineExitCode" as const,
			params: { code: 1 },
			retry: { attempts: 2 },
		};
		app.provider.failures = [crash, crash, crash];
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const [job] =
			(await app.service.getSession(LOCAL_USER, session.id)).turns[0]?.jobs ??
			[];
		expect(job?.status).toBe("failed");
		expect(app.provider.failures).toHaveLength(1);
	});

	test("a failed job can be tried again by hand, as it was asked", async () => {
		const app = boot(await tempDir());
		app.provider.failWith = "down";
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
			seed: 42,
		});
		await app.engine.idle();
		const failed = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs[0];
		expect(failed?.status).toBe("failed");

		app.provider.failWith = null;
		await app.service.retryJob(LOCAL_USER, failed?.id as string);
		await app.engine.idle();
		const again = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs[0];
		expect(again?.id).toBe(failed?.id);
		expect(again?.status).toBe("succeeded");
		expect(again?.error).toBeNull();
		expect(again?.params.seed).toBe(42);
		expect(again?.assets).toHaveLength(1);
	});

	test("trying again follows a job the provider took, instead of paying again", async () => {
		const provider = Object.assign(new FakeProvider(), { resumable: true });
		const app = boot(await tempDir(), provider);
		provider.failures = [
			{
				type: "failed",
				error: "Lost the connection to fake",
				code: "connectionLost",
				params: { provider: "fake" },
			},
		];
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const lost = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(lost?.status).toBe("failed");

		await app.service.retryJob(LOCAL_USER, lost?.id as string);
		await app.engine.idle();
		const found = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs[0];
		expect(found?.status).toBe("succeeded");
		expect(provider.submitted).toHaveLength(1);
	});

	test("trying again sends anew once the provider said the job failed", async () => {
		const provider = Object.assign(new FakeProvider(), { resumable: true });
		const app = boot(await tempDir(), provider);
		provider.failures = [{ type: "failed", error: "content refused" }];
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const failed = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs[0];
		await app.service.retryJob(LOCAL_USER, failed?.id as string);
		await app.engine.idle();
		expect(provider.submitted).toHaveLength(2);
	});

	test("trying again twice at once runs the job once", async () => {
		const app = boot(await tempDir());
		app.provider.failWith = "down";
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const failed = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs[0];
		app.provider.failWith = null;
		const id = failed?.id as string;
		await Promise.all([
			app.service.retryJob(LOCAL_USER, id),
			app.service.retryJob(LOCAL_USER, id),
		]);
		await app.engine.idle();
		// One submit for the first run, one for the retry.
		expect(app.provider.submitted).toHaveLength(2);
	});

	test("only a job that failed or was canceled can be tried again", async () => {
		const app = boot(await tempDir());
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const done = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		await expect(
			app.service.retryJob(LOCAL_USER, done?.id as string),
		).rejects.toMatchObject({ code: "jobNotRetryable" });
		await expect(
			app.service.retryJob({ userId: "someone-else" }, done?.id as string),
		).rejects.toMatchObject({ code: "jobNotFound" });
	});

	test("a model that reads only English gets the prompt in English, once per turn", async () => {
		const asked: string[] = [];
		const translator: Translator = {
			toEnglish: async (prompt) => {
				asked.push(prompt);
				return "Translation: a red fox in the snow";
			},
		};
		const provider = new FakeProvider("fake", ["alpha", "beta", "beta2"]);
		const english = Object.assign(provider, {
			listModels: () =>
				FakeProvider.prototype.listModels.call(provider).map((m) =>
					m.id === "fake/beta2"
						? {
								...m,
								capabilities: { ...m.capabilities, englishPrompts: true },
							}
						: m,
				),
		});
		const app = boot(await tempDir(), english, 4, translator);
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "uma raposa vermelha na neve",
			modelIds: ["fake/alpha", "fake/beta", "fake/beta2"],
		});
		await app.engine.idle();
		// Translated once for both models that need it.
		expect(asked).toEqual(["uma raposa vermelha na neve"]);
		const sent = new Map(provider.submitted.map((h) => [h.model, h.prompt]));
		expect(sent.get("fake/alpha")).toBe("uma raposa vermelha na neve");
		expect(sent.get("fake/beta")).toBe("a red fox in the snow");
		const jobs = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs;
		const beta = jobs?.find((j) => j.modelId === "fake/beta");
		// The prompt as written stays; the translation is shown with the job.
		expect(beta?.params.prompt).toBe("uma raposa vermelha na neve");
		expect(beta?.params.translatedPrompt).toBe("a red fox in the snow");
		expect(
			jobs?.find((j) => j.modelId === "fake/alpha")?.params.translatedPrompt,
		).toBeUndefined();
	});

	test("without a translator, or when it fails, the prompt goes as written", async () => {
		const failing: Translator = {
			toEnglish: async () => {
				throw new Error("not installed");
			},
		};
		for (const translator of [undefined, failing]) {
			const app = boot(await tempDir(), new FakeProvider(), 4, translator);
			const { session } = await app.service.createTurn(LOCAL_USER, {
				prompt: "uma raposa",
				modelIds: ["fake/beta"],
			});
			await app.engine.idle();
			expect(app.provider.submitted[0]?.prompt).toBe("uma raposa");
			const job = (await app.service.getSession(LOCAL_USER, session.id))
				.turns[0]?.jobs[0];
			expect(job?.status).toBe("succeeded");
			expect(job?.params.translatedPrompt).toBeUndefined();
		}
	});

	test("canceling while the prompt is translated stops the job at once", async () => {
		const slow = gate();
		const app = boot(await tempDir(), new FakeProvider(), 4, {
			toEnglish: async () => {
				await slow.promise;
				return "a fox";
			},
		});
		const { turn, session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "uma raposa",
			modelIds: ["fake/beta"],
		});
		await settle();
		await app.service.cancelJob(LOCAL_USER, turn.jobs[0]?.id as string);
		await settle();
		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.status).toBe("canceled");
		// Nothing was sent, nor is the translation written onto it later.
		slow.open();
		await app.engine.idle();
		expect(app.provider.submitted).toHaveLength(0);
		const after = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs[0];
		expect(after?.params.translatedPrompt).toBeUndefined();
	});

	test("a failed translation is not kept: trying again translates again", async () => {
		let calls = 0;
		const app = boot(await tempDir(), new FakeProvider(), 4, {
			toEnglish: async () => {
				calls++;
				if (calls === 1) throw new Error("still loading");
				return "a fox";
			},
		});
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "uma raposa",
			modelIds: ["fake/beta"],
		});
		await app.engine.idle();
		const first = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs[0];
		expect(first?.params.translatedPrompt).toBeUndefined();
		await app.service.createTurn(LOCAL_USER, {
			prompt: "uma raposa",
			modelIds: ["fake/beta"],
			sessionId: session.id,
		});
		await app.engine.idle();
		expect(calls).toBe(2);
		expect(app.provider.submitted.at(-1)?.prompt).toBe("a fox");
	});

	test("a prompt already in English is sent as it is, and nothing is shown", async () => {
		const app = boot(await tempDir(), new FakeProvider(), 4, {
			toEnglish: async (prompt) => prompt,
		});
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "a red fox",
			modelIds: ["fake/beta"],
		});
		await app.engine.idle();
		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.params.translatedPrompt).toBeUndefined();
	});

	test("a prompt plainly in English does not wait on the translator", async () => {
		let calls = 0;
		const app = boot(await tempDir(), new FakeProvider(), 4, {
			toEnglish: async (prompt) => {
				calls++;
				return prompt;
			},
		});
		await app.service.createTurn(LOCAL_USER, {
			prompt:
				"A cozy ramen shop on a rainy night, neon reflections on the street",
			modelIds: ["fake/beta"],
		});
		await app.engine.idle();
		expect(calls).toBe(0);
		expect(app.provider.submitted.at(-1)?.prompt).toBe(
			"A cozy ramen shop on a rainy night, neon reflections on the street",
		);
	});

	test("reports progress and status changes to listeners", async () => {
		const app = boot(await tempDir());
		const seen: string[] = [];
		app.engine.subscribe((userId, event) => {
			expect(userId).toBe(LOCAL_USER.userId);
			seen.push(event.type === "job.updated" ? event.job.status : "progress");
		});
		await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		expect(seen).toEqual(["running", "progress", "succeeded"]);
	});

	test("fails a job whose provider needs a key that is not configured", async () => {
		const provider = new FakeProvider();
		provider.requiresKey = true;
		const app = boot(await tempDir(), provider);
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.status).toBe("failed");
		expect(job?.error).toContain("No API key");
		// Stored with a code, so the interface can say it in any language.
		expect([job?.errorCode, job?.errorParams]).toEqual([
			"noApiKey",
			{ provider: "Fake (fake)" },
		]);

		await app.service.setProviderKey(LOCAL_USER, "fake", "secret");
		await app.service.createTurn(LOCAL_USER, {
			sessionId: session.id,
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const retried = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[1]?.jobs[0];
		expect(retried?.status).toBe("succeeded");
	});
});

describe("job engine hardening", () => {
	test("a listener that throws does not change the job's outcome", async () => {
		const app = boot(await tempDir());
		app.engine.subscribe(() => {
			throw new Error("listener bug");
		});
		const error = console.error;
		console.error = () => {};
		try {
			const { session } = await app.service.createTurn(LOCAL_USER, {
				prompt: "x",
				modelIds: ["fake/alpha"],
			});
			await app.engine.idle();
			const job = (await app.service.getSession(LOCAL_USER, session.id))
				.turns[0]?.jobs[0];
			expect(job?.status).toBe("succeeded");
			expect(job?.error).toBeNull();
		} finally {
			console.error = error;
		}
	});

	test("refuses a result URL that is not HTTPS", async () => {
		const dir = await tempDir();
		const app = boot(dir);
		await app.service.setProviderKey(LOCAL_USER, "fake", "secret");
		app.provider.outputUrl = `file://${join(dir, "auth.json")}`;
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.status).toBe("failed");
		expect(job?.error).toContain("not HTTPS");
		expect(job?.assets).toHaveLength(0);
	});
});

describe("video", () => {
	/** Answers downloads with `body`, recording what was asked for. */
	function download(body: Uint8Array, type: string) {
		const requests: { url: string; auth: string | null }[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			requests.push({
				url,
				auth: new Headers(init?.headers).get("authorization"),
			});
			return new Response(body, { headers: { "content-type": type } });
		}) as unknown as typeof fetch;
		return {
			requests,
			restore: () => {
				globalThis.fetch = original;
			},
		};
	}

	test("the length is fitted to what the model offers", () => {
		const fit = (durationSeconds?: number, model = CLIP) =>
			adaptParams(model, {
				prompt: "x",
				count: 1,
				referenceAssetIds: [],
				extras: {},
				durationSeconds,
			}).durationSeconds;

		expect(fit(6)).toBe(6);
		expect(fit(7)).toBe(6);
		expect(fit(60)).toBe(8);
		expect(fit(1)).toBe(4);
		// Unasked, the shortest: video is billed by the second.
		expect(fit()).toBe(4);

		const fixed = {
			...CLIP,
			capabilities: { ...CLIP.capabilities, durations: undefined },
		};
		expect(fit(6, fixed)).toBeUndefined();
	});

	test("a strength is kept only for a model that redraws a given picture", () => {
		const strengthOf = (
			strength: number | undefined,
			references: string[],
			asked: object = { strength: 0.4 },
		) =>
			adaptParams(
				{
					...CLIP,
					capabilities: {
						...CLIP.capabilities,
						maxReferenceImages: 1,
						strength,
						mask: 0.85,
					},
				},
				{
					prompt: "x",
					count: 1,
					referenceAssetIds: references,
					extras: {},
					...asked,
				},
			).strength;
		expect(strengthOf(0.7, ["a"])).toBe(0.4);
		expect(strengthOf(0.7, [])).toBeUndefined();
		expect(strengthOf(undefined, ["a"])).toBeUndefined();
		// Unasked, the model's own, as the stored parameters say what was used.
		expect(strengthOf(0.7, ["a"], {})).toBe(0.7);
		expect(strengthOf(0.7, ["a"], { maskAssetId: "m" })).toBe(0.85);
	});

	test("a redrawn picture keeps its reference's shape, not the ratio asked", () => {
		const ratioOf = (references: string[]) =>
			adaptParams(
				{
					...CLIP,
					capabilities: {
						...CLIP.capabilities,
						aspectRatios: ["16:9"],
						maxReferenceImages: 1,
						strength: 0.7,
					},
				},
				{
					prompt: "x",
					count: 1,
					referenceAssetIds: references,
					extras: {},
					aspectRatio: "16:9",
				},
			).aspectRatio;
		expect(ratioOf([])).toBe("16:9");
		expect(ratioOf(["a"])).toBeUndefined();
	});

	test("a video is downloaded with the provider's headers and priced by the second", async () => {
		const app = boot(await tempDir(), new FakeVideoProvider());
		// The CDN mislabels the file; the bytes decide what it is stored as.
		const cdn = download(MP4, "application/octet-stream");
		try {
			const { session, turn } = await app.service.createTurn(LOCAL_USER, {
				prompt: "a fox running",
				modelIds: ["fake/clip"],
				durationSeconds: 9,
			});
			expect(turn.jobs[0]?.params.durationSeconds).toBe(8);
			await app.engine.idle();

			const job = (await app.service.getSession(LOCAL_USER, session.id))
				.turns[0]?.jobs[0];
			expect(job?.error).toBeNull();
			expect(job?.status).toBe("succeeded");
			expect(job?.costUsd).toBeCloseTo(0.8);
			expect(job?.assets.map((a) => [a.mime, a.size])).toEqual([
				["video/mp4", MP4.byteLength],
			]);
			expect(cdn.requests).toEqual([
				{ url: "https://cdn.example/clip", auth: "Bearer k" },
			]);
		} finally {
			cdn.restore();
		}
	});

	test("a video cannot be used as a reference, nor uploaded", async () => {
		const app = boot(await tempDir(), new FakeVideoProvider());
		const cdn = download(MP4, "video/mp4");
		try {
			const { session } = await app.service.createTurn(LOCAL_USER, {
				prompt: "x",
				modelIds: ["fake/clip"],
			});
			await app.engine.idle();
			const clip = (await app.service.getSession(LOCAL_USER, session.id))
				.turns[0]?.jobs[0]?.assets[0]?.id as string;

			expect(
				app.service.createTurn(LOCAL_USER, {
					sessionId: session.id,
					prompt: "x",
					modelIds: ["fake/clip"],
					referenceAssetIds: [clip],
				}),
			).rejects.toThrow("Only images can be used as references");
			expect(app.service.uploadAsset(LOCAL_USER, MP4)).rejects.toBeInstanceOf(
				ValidationError,
			);
		} finally {
			cdn.restore();
		}
	});

	test("files are recognized by their first bytes", () => {
		const bytes = (text: string, prefix: number[] = []) =>
			new Uint8Array([...prefix, ...Buffer.from(text, "latin1")]);

		expect(sniffMime(PNG)).toBe("image/png");
		expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
			"image/jpeg",
		);
		expect(sniffMime(bytes("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
		expect(sniffMime(bytes("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
		expect(sniffMime(bytes("GIF89a"))).toBe("image/gif");
		expect(sniffMime(MP4)).toBe("video/mp4");
		expect(sniffMime(bytes("ftypqt  ", [0, 0, 0, 20]))).toBe("video/quicktime");
		expect(sniffMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe(
			"video/webm",
		);
		expect(sniffMime(bytes("<script>"))).toBeNull();
		expect(sniffMime(new Uint8Array())).toBeNull();
	});
});

describe("restart", () => {
	async function interrupted(make: () => FakeProvider) {
		const dir = await tempDir();
		const provider = make();
		const before = boot(dir, provider, 1);
		provider.gate = new Promise(() => {});
		const { session } = await before.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha", "fake/beta"],
		});
		await settle();
		before.repo.close(); // the process dies with one job running, one queued

		const next = make();
		const after = boot(dir, next, 1);
		await after.engine.start();
		await after.engine.idle();
		const jobs = (await after.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs;
		return { jobs, provider: next };
	}

	test("a job interrupted mid-run fails; a queued one runs", async () => {
		const { jobs, provider } = await interrupted(() => new FakeProvider());
		expect(jobs?.map((j) => j.status)).toEqual(["failed", "succeeded"]);
		expect(jobs?.[0]?.error).toBe("Interrupted by a restart");
		expect(provider.submitted).toHaveLength(1);
	});

	test("a resumable provider re-attaches without submitting again", async () => {
		const { jobs, provider } = await interrupted(() =>
			Object.assign(new FakeProvider(), { resumable: true }),
		);
		expect(jobs?.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
		expect(provider.submitted).toHaveLength(1);
	});

	test("a provider can say per job whether it re-attaches", async () => {
		const { jobs, provider } = await interrupted(() => new PerHandleProvider());
		expect(jobs?.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
		expect(provider.submitted).toHaveLength(1);
	});
});

describe("storage", () => {
	test("keys are stored owner-only and never listed by value", async () => {
		const dir = await tempDir();
		const app = boot(dir);
		await app.service.setProviderKey(LOCAL_USER, "fake", "secret");
		const mode = (await stat(join(dir, "auth.json"))).mode & 0o777;
		expect(mode).toBe(0o600);
		const providers = await app.service.listProviders(LOCAL_USER);
		expect(providers).toEqual([
			{ id: "fake", name: "Fake (fake)", requiresKey: false, hasKey: true },
		]);
		await app.service.deleteProviderKey(LOCAL_USER, "fake");
		expect((await app.service.listProviders(LOCAL_USER))[0]?.hasKey).toBe(
			false,
		);
	});

	test("the gallery is searchable by prompt and survives session deletion", async () => {
		const app = boot(await tempDir());
		const fox = await app.service.createTurn(LOCAL_USER, {
			prompt: "a red fox",
			modelIds: ["fake/alpha"],
		});
		await app.service.createTurn(LOCAL_USER, {
			prompt: "100% wool",
			modelIds: ["fake/alpha"],
		});
		await app.service.uploadAsset(LOCAL_USER, PNG);
		await app.engine.idle();

		const all = await app.service.listGallery(LOCAL_USER, { limit: 10 });
		expect(all).toHaveLength(2);
		const found = await app.service.listGallery(LOCAL_USER, {
			limit: 10,
			query: "fox",
		});
		expect(found.map((i) => i.prompt)).toEqual(["a red fox"]);
		const literal = await app.service.listGallery(LOCAL_USER, {
			limit: 10,
			query: "0%",
		});
		expect(literal.map((i) => i.prompt)).toEqual(["100% wool"]);

		await app.service.deleteSession(LOCAL_USER, fox.session.id);
		expect(await app.service.listSessions(LOCAL_USER)).toHaveLength(1);
		// The image keeps what produced it, so it stays searchable.
		const kept = await app.service.listGallery(LOCAL_USER, {
			limit: 10,
			query: "fox",
		});
		expect(kept.map((i) => [i.prompt, i.modelId, i.jobId])).toEqual([
			["a red fox", "fake/alpha", null],
		]);
		expect(
			await app.service.listGallery(LOCAL_USER, { limit: 10 }),
		).toHaveLength(2);
	});

	test("gallery pages do not skip images created in the same millisecond", async () => {
		const app = boot(await tempDir());
		const times = { a: 3, b: 2, c: 2, d: 1 };
		for (const [id, createdAt] of Object.entries(times)) {
			await app.repo.createAsset({
				id,
				userId: LOCAL_USER.userId,
				kind: "output",
				jobId: null,
				hash: "0".repeat(64),
				mime: "image/png",
				size: 1,
				prompt: null,
				modelId: null,
				params: null,
				createdAt,
			});
		}
		const seen: string[] = [];
		let before: { createdAt: number; id: string } | undefined;
		for (;;) {
			const page = await app.service.listGallery(LOCAL_USER, {
				limit: 2,
				before,
			});
			seen.push(...page.map((item) => item.id));
			before = page.at(-1);
			if (page.length < 2) break;
		}
		expect(seen).toEqual(["a", "c", "b", "d"]);
	});

	test("keys saved at the same time are all kept", async () => {
		const app = boot(await tempDir());
		await Promise.all(
			["one", "two", "three", "four"].map((id) =>
				app.keys.set(LOCAL_USER, id, `key-${id}`),
			),
		);
		expect((await app.keys.list(LOCAL_USER)).sort()).toEqual([
			"four",
			"one",
			"three",
			"two",
		]);
	});

	test("one user cannot read another user's data", async () => {
		const app = boot(await tempDir());
		const { session, turn } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const other = { userId: "other" };
		const assetId = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs[0]?.assets[0]?.id as string;

		expect(app.service.getSession(other, session.id)).rejects.toThrow();
		expect(app.service.getAssetFile(other, assetId)).rejects.toThrow();
		expect(
			app.service.cancelJob(other, turn.jobs[0]?.id as string),
		).rejects.toThrow();
		expect(await app.service.listGallery(other, { limit: 10 })).toHaveLength(0);
	});
});

describe("assistant conversations", () => {
	test("are kept per session and person, in order, and go with the session", async () => {
		const dir = await tempDir();
		const { repo, service } = boot(dir);
		const ana = { userId: "ana" };
		const session = await service.startSession(ana, "a fox");
		const said = (id: string, text: string, createdAt: number) => ({
			id,
			sessionId: session.id,
			createdAt,
			message: {
				role: "user" as const,
				content: [{ type: "text" as const, text }],
			},
		});
		// Written in the same millisecond, with ids in no order: kept as written.
		await repo.addEntry(said("msg_b", "first", 1), "ana");
		await repo.addEntry(said("msg_a", "second", 1), "ana");
		expect((await repo.listEntries(ana, session.id)).map((e) => e.id)).toEqual([
			"msg_b",
			"msg_a",
		]);
		// Someone else can neither read nor change them.
		expect(await repo.listEntries({ userId: "bia" }, session.id)).toEqual([]);
		const { id, sessionId, createdAt, ...body } = said("msg_a", "x", 1);
		await repo.updateEntry({ userId: "bia" }, id, {
			...body,
			note: "stopped",
		});
		await repo.updateEntry(ana, id, {
			...body,
			confirm: { arguments: {}, modelNames: ["X"], usd: 1, state: "asked" },
		});
		const first = (await repo.listEntries(ana, sessionId)).find(
			(e) => e.id === id,
		);
		expect(first).toMatchObject({ id, createdAt, confirm: { state: "asked" } });
		expect(first?.note).toBeUndefined();

		await service.deleteSession(ana, session.id);
		expect(await repo.listEntries(ana, session.id)).toEqual([]);
		repo.close();
	});
});

describe("a line shared by several people", () => {
	test("takes turns between people, not first come first served", async () => {
		const provider = new FakeProvider();
		// One at a time, as a graphics card runs them.
		provider.maxConcurrency = 1;
		const app = boot(await tempDir(), provider);
		const held = gate();
		provider.gate = held.promise;
		const places = new Map<string, number>();
		app.engine.subscribe((_, event) => {
			if (event.type === "job.progress" && event.stage === "queued") {
				places.set(event.jobId, event.position ?? 0);
			}
		});
		const ana = { userId: "ana" };
		const bia = { userId: "bia" };
		const turn = async (who: { userId: string }, prompt: string) =>
			(
				await app.service.createTurn(who, {
					prompt,
					modelIds: ["fake/alpha"],
				})
			).turn.jobs[0]?.id as string;
		// Ana asks for five pictures; the first starts at once.
		for (let i = 1; i <= 5; i++) await turn(ana, `ana ${i}`);
		await settle();
		// Then Bia asks for one.
		const biaJob = await turn(bia, "bia 1");
		await settle();
		// Bia is told she is next, not sixth.
		expect(places.get(biaJob)).toBe(1);

		held.open();
		await app.engine.idle();
		expect(provider.submitted.map((job) => job.prompt)).toEqual([
			"ana 1",
			"bia 1",
			"ana 2",
			"ana 3",
			"ana 4",
			"ana 5",
		]);
	});
});
