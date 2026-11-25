import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyLibrary,
	FakeProvider,
	FileKeyStore,
	FsAssetStore,
	findLibraryEntry,
	type GenerationParams,
	JobEngine,
	type LibraryEntry,
	type LoraInfo,
	libraryModel,
	libraryTags,
	MIGRATIONS_DIR,
	type ModelSpec,
	ProviderRegistry,
	ReelService,
	SqliteRepository,
	type UserContext,
} from "./index";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

/** A fake whose beta takes SDXL LoRAs, as alpha follows pictures. */
class LoraFake extends FakeProvider {
	override listModels(): ModelSpec[] {
		return super
			.listModels()
			.map((m) =>
				m.id === "fake/beta"
					? { ...m, capabilities: { ...m.capabilities, loraBase: "sdxl" } }
					: m,
			);
	}
}

const lora = (id: string, trigger: string | null = null): LoraInfo => ({
	id,
	name: id,
	base: "sdxl",
	trigger,
	size: 1,
	addedAt: 1,
});

async function boot() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-library-"));
	dirs.push(dir);
	const repo = new SqliteRepository(join(dir, "db.sqlite"));
	const assets = new FsAssetStore(join(dir, "assets"));
	const keys = new FileKeyStore(
		join(dir, "auth.json"),
		crypto.getRandomValues(new Uint8Array(32)),
	);
	const provider = new LoraFake();
	const registry = new ProviderRegistry().register(provider);
	const engine = new JobEngine({ repo, assets, registry, keys });
	const loras = [lora("rexy", "rexdog"), lora("ink", "inkstyle")];
	const service = new ReelService({
		repo,
		assets,
		registry,
		keys,
		engine,
		library: repo.library(),
		loras: async () => loras,
	});
	return { service, engine, provider, loras };
}

const ana: UserContext = { userId: "ana" };
const bia: UserContext = { userId: "bia" };

/** A PNG's first bytes are enough for an upload. */
const png = () =>
	new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...crypto.getRandomValues(new Uint8Array(16)),
	]);

describe("the library", () => {
	test("keeps each person's own, with names unique per kind whatever the case", async () => {
		const { service } = await boot();
		const picture = await service.uploadAsset(ana, png());
		const rex = await service.saveLibraryEntry(ana, {
			kind: "character",
			name: "Rex",
			pictureIds: [picture.id, picture.id],
			loras: [{ id: "rexy", weight: 0.8, trigger: "rexdog" }],
			prompt: "a corgi with a red scarf",
			seed: 7,
		});
		expect(rex).toMatchObject({
			kind: "character",
			name: "Rex",
			pictureIds: [picture.id],
			seed: 7,
			aspectRatio: null,
		});
		expect(service.listLibrary(ana).map((e) => e.name)).toEqual(["Rex"]);
		expect(service.listLibrary(bia)).toEqual([]);
		expect(service.listLibrary(bia)).toEqual([]);

		await expect(
			service.saveLibraryEntry(ana, { kind: "character", name: " rex " }),
		).rejects.toMatchObject({ code: "libraryNameTaken" });
		// Accents, their encoding and spaces do not make another name.
		await service.saveLibraryEntry(ana, {
			kind: "character",
			name: "José  Dog",
		});
		for (const name of ["jose dog", "Jose\u0301 Dog".normalize("NFD")]) {
			await expect(
				service.saveLibraryEntry(ana, { kind: "character", name }),
			).rejects.toMatchObject({ code: "libraryNameTaken" });
		}
		// Another kind, or another person, may have the same name.
		await service.saveLibraryEntry(ana, { kind: "style", name: "Rex" });
		await service.saveLibraryEntry(bia, { kind: "character", name: "Rex" });

		const changed = await service.saveLibraryEntry(
			ana,
			{ kind: "style", name: "Rex the dog", seed: null },
			rex.id,
		);
		// Its kind stays what it was.
		expect(changed).toMatchObject({
			id: rex.id,
			kind: "character",
			name: "Rex the dog",
			seed: null,
			createdAt: rex.createdAt,
		});
		await expect(
			service.saveLibraryEntry(bia, { kind: "character", name: "x" }, rex.id),
		).rejects.toMatchObject({ code: "libraryEntryNotFound" });
		await expect(service.deleteLibraryEntry(bia, rex.id)).rejects.toMatchObject(
			{ code: "libraryEntryNotFound" },
		);
		await service.deleteLibraryEntry(ana, rex.id);
		expect(service.listLibrary(ana).map((e) => e.name)).toEqual([
			"José  Dog",
			"Rex",
		]);
	});

	test("a name taken by a save at the same time is refused, not a failure", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hatchlight-library-"));
		dirs.push(dir);
		const repo = new SqliteRepository(join(dir, "db.sqlite"));
		const library = repo.library();
		const registry = new ProviderRegistry().register(new FakeProvider());
		const keys = new FileKeyStore(
			join(dir, "auth.json"),
			crypto.getRandomValues(new Uint8Array(32)),
		);
		const assets = new FsAssetStore(join(dir, "assets"));
		// The other save lands between the check and the write.
		const racing = new ReelService({
			repo,
			assets,
			registry,
			keys,
			engine: new JobEngine({ repo, assets, registry, keys }),
			library: {
				list: (ctx) => library.list(ctx),
				get: (ctx, id) => library.get(ctx, id),
				findByName: () => null,
				put: (ctx, e) => library.put(ctx, e),
				delete: (ctx, id) => library.delete(ctx, id),
			},
		});
		library.put(ana, entry({ id: "lib_first", kind: "style", name: "Ink" }));
		await expect(
			racing.saveLibraryEntry(ana, { kind: "style", name: "ink" }),
		).rejects.toMatchObject({ code: "libraryNameTaken" });
		repo.close();
	});

	test("refuses pictures not the person's, missing LoRAs and odd values", async () => {
		const { service } = await boot();
		const hers = await service.uploadAsset(bia, png());
		await expect(
			service.saveLibraryEntry(ana, {
				kind: "character",
				name: "Rex",
				pictureIds: [hers.id],
			}),
		).rejects.toMatchObject({ code: "libraryPictureMissing" });
		await expect(
			service.saveLibraryEntry(ana, {
				kind: "style",
				name: "Ink",
				loras: [{ id: "gone", weight: 1, trigger: null }],
			}),
		).rejects.toMatchObject({
			code: "libraryLoraMissing",
			params: { name: "Ink", lora: "gone" },
		});
		await expect(
			service.saveLibraryEntry(ana, {
				kind: "style",
				name: "Ink",
				loras: [{ id: "ink", weight: 3, trigger: null }],
			}),
		).rejects.toThrow();
		await expect(
			service.saveLibraryEntry(ana, { kind: "style", name: "<style:x>" }),
		).rejects.toThrow();
		await expect(
			service.saveLibraryEntry(ana, {
				kind: "style",
				name: "Ink",
				modelId: "fake/none",
			}),
		).rejects.toMatchObject({ code: "unknownModel" });
		await expect(
			service.saveLibraryEntry(ana, {
				kind: "character",
				name: "Many",
				pictureIds: ["a", "b", "c", "d", "e"],
			}),
		).rejects.toThrow();
	});

	test("a picture kept by an entry is not deleted until it is taken out", async () => {
		const { service } = await boot();
		const picture = await service.uploadAsset(ana, png());
		const rex = await service.saveLibraryEntry(ana, {
			kind: "character",
			name: "Rex",
			pictureIds: [picture.id],
		});
		await expect(service.deleteAsset(ana, picture.id)).rejects.toMatchObject({
			code: "pictureInLibrary",
			params: { name: "Rex" },
		});
		await service.saveLibraryEntry(
			ana,
			{ kind: "character", name: "Rex", pictureIds: [] },
			rex.id,
		);
		await service.deleteAsset(ana, picture.id);
		expect(
			await service.getAssetFile(ana, picture.id).catch((e) => e.code),
		).toBe("assetNotFound");
	});

	test("a generation names a character and a style, recorded on its results", async () => {
		const { service, engine, provider } = await boot();
		const picture = await service.uploadAsset(ana, png());
		const rex = await service.saveLibraryEntry(ana, {
			kind: "character",
			name: "Rex",
			pictureIds: [picture.id],
			loras: [{ id: "rexy", weight: 0.8, trigger: "rexdog" }],
			seed: 7,
		});
		const ink = await service.saveLibraryEntry(ana, {
			kind: "style",
			name: "Watercolor",
			prompt: "soft watercolor",
			loras: [{ id: "ink", weight: 0.5, trigger: "inkstyle" }],
			aspectRatio: "16:9",
		});
		const { turn } = await service.createTurn(ana, {
			prompt: "Rex on the beach",
			modelIds: ["fake/alpha", "fake/beta"],
			characterId: rex.id,
			styleId: ink.id,
		});
		// The turn says what was written; each job what its model was sent.
		expect(turn.prompt).toBe("Rex on the beach");
		expect(turn.referenceAssetIds).toEqual([]);
		const [alpha, beta] = turn.jobs.map((j) => j.params);
		expect(alpha).toMatchObject({
			prompt: "the person in picture 1 on the beach, soft watercolor",
			referenceAssetIds: [picture.id],
			seed: 7,
			aspectRatio: "16:9",
			characterId: rex.id,
			styleId: ink.id,
			library: {
				prompt: "Rex on the beach",
				character: "Rex",
				style: "Watercolor",
			},
		});
		expect(alpha?.loras).toBeUndefined();
		// The installed LoRAs' own trigger words are the engine's to add.
		expect(beta).toMatchObject({
			prompt: "Rex on the beach, soft watercolor",
			referenceAssetIds: [],
			loras: [
				{ id: "rexy", weight: 0.8 },
				{ id: "ink", weight: 0.5 },
			],
		});
		await engine.idle();
		expect(provider.submitted.map((s) => s.prompt)).toContain(
			"Rex on the beach, soft watercolor",
		);
		const [made] = await service.listGallery(ana, { limit: 1 });
		expect(made?.params?.library?.character).toBe("Rex");
	});

	test("refuses another's entry, the wrong kind, and parts gone since", async () => {
		const { service, loras } = await boot();
		const picture = await service.uploadAsset(ana, png());
		const rex = await service.saveLibraryEntry(ana, {
			kind: "character",
			name: "Rex",
			pictureIds: [picture.id],
			loras: [{ id: "rexy", weight: 1, trigger: null }],
		});
		const ask = (who: UserContext, extra: object) =>
			service.createTurn(who, {
				prompt: "Rex",
				modelIds: ["fake/alpha"],
				...extra,
			});
		await expect(ask(bia, { characterId: rex.id })).rejects.toMatchObject({
			code: "libraryEntryNotFound",
		});
		await expect(ask(ana, { styleId: rex.id })).rejects.toMatchObject({
			code: "libraryEntryNotFound",
		});
		loras.splice(0, 1);
		await expect(ask(ana, { characterId: rex.id })).rejects.toMatchObject({
			code: "libraryLoraMissing",
			params: { name: "Rex", lora: "rexy" },
		});
	});
});

const model = (caps: Partial<ModelSpec["capabilities"]>): ModelSpec => ({
	id: "m",
	providerId: "p",
	providerModelId: "m",
	name: "Model",
	media: "image",
	operations: ["generate"],
	capabilities: {
		aspectRatios: ["1:1"],
		seed: true,
		maxCount: 1,
		maxReferenceImages: 0,
		...caps,
	},
});

const entry = (fields: Partial<LibraryEntry>): LibraryEntry => ({
	id: "lib_1",
	kind: "character",
	name: "Rex",
	pictureIds: [],
	loras: [],
	prompt: null,
	notes: null,
	seed: null,
	aspectRatio: null,
	modelId: null,
	createdAt: 1,
	updatedAt: 1,
	...fields,
});

const params = (fields: Partial<GenerationParams>): GenerationParams => ({
	prompt: "Rex on the beach",
	count: 1,
	referenceAssetIds: [],
	extras: {},
	...fields,
});

const installed = new Map([
	["rexy", lora("rexy", "rexdog")],
	["ink", lora("ink", "inkstyle")],
	["a1", lora("a1")],
	["a2", lora("a2")],
	["a3", lora("a3")],
	["fluxy", { ...lora("fluxy", "fx"), base: "flux" as const }],
]);

describe("adding a character and a style", () => {
	const follows = model({ maxReferenceImages: 3 });
	const takesLoras = model({ loraBase: "sdxl" });

	test("puts the character's pictures first and names it by them", () => {
		const out = applyLibrary(
			params({ referenceAssetIds: ["ast_mine"] }),
			follows,
			{
				character: entry({ pictureIds: ["ast_a", "ast_b", "ast_mine"] }),
				style: entry({ kind: "style", name: "Ink", pictureIds: ["ast_s"] }),
			},
			installed,
		);
		// Within the three the model takes, the person's own kept.
		expect(out.referenceAssetIds).toEqual(["ast_a", "ast_b", "ast_mine"]);
		expect(out.prompt).toBe("the person in pictures 1, 2 and 3 on the beach");
		const unnamed = applyLibrary(
			params({ prompt: "sitting on a rock" }),
			follows,
			{ character: entry({ pictureIds: ["ast_a"] }) },
			installed,
		);
		expect(unnamed.prompt).toBe("The person in picture 1, sitting on a rock");
	});

	test("uses only LoRAs of the model's family, once, the person's weight first", () => {
		const out = applyLibrary(
			params({ loras: [{ id: "rexy", weight: 0.3 }] }),
			takesLoras,
			{
				character: entry({
					pictureIds: ["ast_a"],
					loras: [
						{ id: "rexy", weight: 1, trigger: "rexdog" },
						{ id: "fluxy", weight: 1, trigger: "fx" },
					],
				}),
				style: entry({
					kind: "style",
					name: "Ink",
					prompt: "ink lines",
					loras: [{ id: "rexy", weight: 0.9, trigger: "rexdog" }],
				}),
			},
			installed,
		);
		expect(out.loras).toEqual([{ id: "rexy", weight: 0.3 }]);
		expect(out.referenceAssetIds).toEqual([]);
		expect(out.prompt).toBe("Rex on the beach, ink lines");
	});

	test("adds words and its own trigger words only once, so using it again adds nothing", () => {
		const used = {
			character: entry({
				loras: [
					// A word of its own: the engine adds only the LoRA's.
					{ id: "rexy", weight: 1, trigger: "rexcorgi" },
					// Turned off: no word for it.
					{ id: "ink", weight: 0, trigger: "inky" },
				],
				prompt: "a corgi",
			}),
		};
		const once = applyLibrary(params({}), takesLoras, used, installed);
		expect(once.prompt).toBe("rexcorgi, Rex on the beach, a corgi");
		expect(applyLibrary(once, takesLoras, used, installed)).toMatchObject({
			prompt: once.prompt,
			loras: once.loras,
			library: { prompt: "Rex on the beach" },
		});
	});

	test("names the character by its saved name only, once, and never as a word", () => {
		const cat = entry({ name: "Cat", pictureIds: ["ast_a"] });
		expect(
			applyLibrary(
				params({ prompt: "a cat chasing a dog, cat food" }),
				follows,
				{ character: cat },
				installed,
			).prompt,
		).toBe("The person in picture 1, a cat chasing a dog, cat food");
		expect(
			applyLibrary(
				params({ prompt: "Cat on a roof, Cat asleep" }),
				follows,
				{ character: cat },
				installed,
			).prompt,
		).toBe("the person in picture 1 on a roof, Cat asleep");
		// A prompt that already names the picture, in any language, keeps it.
		for (const prompt of [
			"a pessoa na imagem 1 na praia",
			"the person in picture 1 at night",
			"o gato da foto 1",
		]) {
			expect(
				applyLibrary(params({ prompt }), follows, { character: cat }, installed)
					.prompt,
			).toBe(prompt);
		}
	});

	test("refuses more LoRAs of one family than the engine takes", () => {
		const style = entry({
			kind: "style",
			name: "Busy",
			loras: ["a1", "a2", "a3"].map((id) => ({ id, weight: 1, trigger: null })),
		});
		expect(() =>
			applyLibrary(
				params({
					loras: [
						{ id: "rexy", weight: 1 },
						{ id: "ink", weight: 1 },
					],
				}),
				takesLoras,
				{ style },
				installed,
			),
		).toThrow(expect.objectContaining({ code: "tooManyLoras" }));
		expect(
			applyLibrary(params({}), takesLoras, { style }, installed).loras,
		).toHaveLength(3);
	});

	test("fills the seed and ratio only when none was asked for", () => {
		const used = {
			character: entry({ seed: 3, aspectRatio: "1:1" }),
			style: entry({ kind: "style", name: "Ink", aspectRatio: "16:9" }),
		};
		expect(applyLibrary(params({}), follows, used, installed)).toMatchObject({
			seed: 3,
			aspectRatio: "16:9",
		});
		expect(
			applyLibrary(
				params({ seed: 9, aspectRatio: "4:3" }),
				follows,
				used,
				installed,
			),
		).toMatchObject({ seed: 9, aspectRatio: "4:3" });
	});

	test("refuses a character a model can use nothing of", () => {
		const character = entry({
			pictureIds: ["ast_a"],
			loras: [{ id: "fluxy", weight: 1, trigger: null }],
		});
		expect(() =>
			applyLibrary(params({}), takesLoras, { character }, installed),
		).toThrow(expect.objectContaining({ code: "characterNotUsable" }));
		// A redrawing model, or a mask, takes no other picture.
		const cases: [
			Partial<ModelSpec["capabilities"]>,
			Partial<GenerationParams>,
		][] = [
			[{ maxReferenceImages: 1, strength: 0.7 }, {}],
			[
				{ maxReferenceImages: 2 },
				{ maskAssetId: "ast_m", referenceAssetIds: ["ast_r"] },
			],
		];
		for (const [caps, extra] of cases) {
			expect(() =>
				applyLibrary(params(extra), model(caps), { character }, installed),
			).toThrow(expect.objectContaining({ code: "characterNotUsable" }));
		}
		// A style is only words where nothing else fits.
		expect(
			applyLibrary(
				params({}),
				model({}),
				{
					style: entry({ kind: "style", pictureIds: ["ast_s"], prompt: "ink" }),
				},
				installed,
			),
		).toMatchObject({ prompt: "Rex on the beach, ink", referenceAssetIds: [] });
	});
});

describe("finding entries by name", () => {
	const entries = [
		entry({ id: "1", name: "Rex" }),
		entry({ id: "2", name: "Rexona" }),
		entry({ id: "3", name: "Ana Júlia" }),
		entry({ id: "4", kind: "style", name: "Watercolor" }),
		entry({ id: "5", kind: "style", name: "Watercolor night" }),
	];
	test("the same name first, then the only one starting with it or containing it", () => {
		expect(findLibraryEntry(entries, "character", "rex").entry?.id).toBe("1");
		expect(findLibraryEntry(entries, "character", "ana julia").entry?.id).toBe(
			"3",
		);
		expect(findLibraryEntry(entries, "character", "júlia").entry?.id).toBe("3");
		expect(findLibraryEntry(entries, "style", "my watercolor").entry?.id).toBe(
			"4",
		);
	});
	test("says which ones a name could mean, or that none", () => {
		const several = findLibraryEntry(entries, "style", "water");
		expect(several.entry).toBeNull();
		expect("matches" in several && several.matches.map((e) => e.id)).toEqual([
			"4",
			"5",
		]);
		expect(findLibraryEntry(entries, "style", "rex")).toEqual({
			entry: null,
			matches: [],
		});
	});
	test("reads names from tags and prefers the character's model", () => {
		expect(libraryTags("<character:Rex> on a beach <style:Ink>")).toEqual({
			prompt: "on a beach",
			character: "Rex",
			style: "Ink",
		});
		expect(libraryTags("a <lora:x:1> fox")).toEqual({
			prompt: "a <lora:x:1> fox",
		});
		const a = { ...model({}), id: "a" };
		const b = { ...model({}), id: "b" };
		expect(
			libraryModel(
				[a, b],
				[entry({ modelId: "gone" }), entry({ kind: "style", modelId: "b" })],
			)?.id,
		).toBe("b");
		expect(libraryModel([a], [null, undefined])).toBeNull();
		// Not when it cannot take the pictures or the guide asked for.
		const picky = { ...model({ maxReferenceImages: 1 }), id: "p" };
		const style = entry({ kind: "style", modelId: "p" });
		expect(libraryModel([picky], [style], { references: 1 })?.id).toBe("p");
		expect(libraryModel([picky], [style], { references: 2 })).toBeNull();
		expect(
			libraryModel([picky], [style], {
				references: 0,
				guide: { kind: "pose", ready: true },
			}),
		).toBeNull();
		// One that needs a picture fits when the character brings one.
		const needs = {
			...model({ maxReferenceImages: 2, needsReference: true }),
			id: "n",
		};
		expect(
			libraryModel([needs], [entry({ modelId: "n" })], { references: 0 }),
		).toBeNull();
		expect(
			libraryModel([needs], [entry({ modelId: "n", pictureIds: ["ast_a"] })], {
				references: 0,
			})?.id,
		).toBe("n");
	});
});

test("the library table is added to a database made before it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-library-"));
	dirs.push(dir);
	const before = join(dir, "drizzle");
	await cp(MIGRATIONS_DIR, before, { recursive: true });
	const journal = Bun.file(join(before, "meta", "_journal.json"));
	const entries = await journal.json();
	entries.entries = entries.entries.filter(
		(e: { tag: string }) => e.tag < "0014",
	);
	await Bun.write(journal, JSON.stringify(entries));

	const path = join(dir, "db.sqlite");
	const old = new SqliteRepository(path, before);
	await old.createSession({
		id: "ses_1",
		userId: "ana",
		title: "kept",
		createdAt: 1,
		updatedAt: 1,
	});
	old.close();
	const raw = new Database(path);
	expect(
		raw.query("select name from sqlite_master where name = 'library'").all(),
	).toEqual([]);
	raw.close();

	const repo = new SqliteRepository(path);
	expect((await repo.listSessions(ana)).map((s) => s.title)).toEqual(["kept"]);
	const library = repo.library();
	library.put(ana, entry({ id: "lib_1", name: "Rex" }));
	expect(library.findByName(ana, "character", "REX")?.id).toBe("lib_1");
	expect(library.list(bia)).toEqual([]);
	repo.close();
});
