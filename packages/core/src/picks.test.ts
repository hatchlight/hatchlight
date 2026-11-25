import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeProvider,
	FileKeyStore,
	FsAssetStore,
	JobEngine,
	MIGRATIONS_DIR,
	ProviderRegistry,
	ReelService,
	SqliteRepository,
	type UserContext,
} from "./index";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function boot() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-picks-"));
	dirs.push(dir);
	const repo = new SqliteRepository(join(dir, "db.sqlite"));
	const assets = new FsAssetStore(join(dir, "assets"));
	const keys = new FileKeyStore(
		join(dir, "auth.json"),
		crypto.getRandomValues(new Uint8Array(32)),
	);
	const registry = new ProviderRegistry().register(new FakeProvider());
	const engine = new JobEngine({ repo, assets, registry, keys });
	const service = new ReelService({ repo, assets, registry, keys, engine });
	return { service, engine };
}

const ana: UserContext = { userId: "ana" };
const bia: UserContext = { userId: "bia" };

async function compare(
	app: Awaited<ReturnType<typeof boot>>,
	who: UserContext,
	prompt = "a portrait of a fox",
	modelIds = ["fake/alpha", "fake/beta"],
) {
	const { session, turn } = await app.service.createTurn(who, {
		prompt,
		modelIds,
		count: 1,
	});
	await app.engine.idle();
	const done = await app.service.getSession(who, session.id);
	return done.turns.find((t) => t.id === turn.id) ?? turn;
}

describe("picking the best of a comparison", () => {
	test("is kept per turn, can change, and can be cleared", async () => {
		const app = await boot();
		const turn = await compare(app, ana);
		const [alpha, beta] = turn.jobs.map((j) => j.assets[0]?.id as string);
		expect(turn.pickedAssetId).toBeNull();

		await app.service.pickResult(ana, turn.id, alpha as string);
		let shown = await app.service.getSession(ana, turn.sessionId);
		expect(shown.turns[0]?.pickedAssetId).toBe(alpha);

		await app.service.pickResult(ana, turn.id, beta as string);
		shown = await app.service.getSession(ana, turn.sessionId);
		expect(shown.turns[0]?.pickedAssetId).toBe(beta);
		expect((await app.service.ranking(ana)).models[0]).toMatchObject({
			modelId: "fake/beta",
			wins: 1,
			comparisons: 1,
		});

		await app.service.pickResult(ana, turn.id, null);
		shown = await app.service.getSession(ana, turn.sessionId);
		expect(shown.turns[0]?.pickedAssetId).toBeNull();
		expect((await app.service.ranking(ana)).comparisons).toBe(0);
	});

	test("refuses a picture that is not one of the turn's results", async () => {
		const app = await boot();
		const turn = await compare(app, ana);
		const other = await compare(app, ana);
		const stranger = other.jobs[0]?.assets[0]?.id as string;
		await expect(
			app.service.pickResult(ana, turn.id, stranger),
		).rejects.toMatchObject({ code: "pickNotInTurn" });
		await expect(
			app.service.pickResult(ana, turn.id, "ast_nothing"),
		).rejects.toMatchObject({ code: "pickNotInTurn" });
	});

	test("needs more than one result to choose from", async () => {
		const app = await boot();
		const single = await compare(app, ana, "a fox", ["fake/alpha"]);
		await expect(
			app.service.pickResult(
				ana,
				single.id,
				single.jobs[0]?.assets[0]?.id as string,
			),
		).rejects.toMatchObject({ code: "pickNeedsComparison" });
		// Several pictures of one model say nothing about which model is liked.
		const { session, turn } = await app.service.createTurn(ana, {
			prompt: "a fox",
			modelIds: ["fake/alpha"],
			count: 2,
		});
		await app.engine.idle();
		const two = (await app.service.getSession(ana, session.id)).turns.find(
			(t) => t.id === turn.id,
		);
		expect(two?.jobs[0]?.assets).toHaveLength(2);
		await expect(
			app.service.pickResult(
				ana,
				turn.id,
				two?.jobs[0]?.assets[1]?.id as string,
			),
		).rejects.toMatchObject({ code: "pickNeedsComparison" });
	});

	test("the gallery tells which pictures await a pick between models", async () => {
		const app = await boot();
		const compared = await compare(app, ana);
		await compare(app, ana, "alone", ["fake/alpha"]);
		const unpicked = async () =>
			Object.fromEntries(
				(await app.service.listGallery(ana, { limit: 10 })).map((item) => [
					item.prompt === "alone" ? "alone" : item.modelId,
					item.unpicked,
				]),
			);
		expect(await unpicked()).toEqual({
			alone: false,
			"fake/alpha": true,
			"fake/beta": true,
		});
		await app.service.pickResult(
			ana,
			compared.id,
			compared.jobs[0]?.assets[0]?.id as string,
		);
		expect(await unpicked()).toEqual({
			alone: false,
			"fake/alpha": false,
			"fake/beta": false,
		});
	});

	test("is each person's own", async () => {
		const app = await boot();
		const turn = await compare(app, ana);
		const alpha = turn.jobs[0]?.assets[0]?.id as string;
		await expect(
			app.service.pickResult(bia, turn.id, alpha),
		).rejects.toMatchObject({ code: "turnNotFound" });
		await app.service.pickResult(ana, turn.id, alpha);
		expect((await app.service.ranking(ana)).comparisons).toBe(1);
		expect((await app.service.ranking(bia)).comparisons).toBe(0);
	});

	test("the ranking narrows by kind of prompt and by period", async () => {
		const app = await boot();
		const portrait = await compare(app, ana, "a portrait of a fox");
		const beach = await compare(app, ana, "a beach at dawn");
		await app.service.pickResult(
			ana,
			portrait.id,
			portrait.jobs[0]?.assets[0]?.id as string,
		);
		await app.service.pickResult(
			ana,
			beach.id,
			beach.jobs[1]?.assets[0]?.id as string,
		);
		const top = async (kind: "portrait" | "landscape") =>
			(await app.service.ranking(ana, { kind })).models[0]?.modelId;
		expect(await top("portrait")).toBe("fake/alpha");
		expect(await top("landscape")).toBe("fake/beta");
		expect(
			(await app.service.ranking(ana, { period: "30d", media: "image" }))
				.comparisons,
		).toBe(2);
		expect(
			(await app.service.ranking(ana, { media: "video" })).comparisons,
		).toBe(0);
	});
});

test("the picks table is added to a database made before it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-picks-"));
	dirs.push(dir);
	const before = join(dir, "drizzle");
	await cp(MIGRATIONS_DIR, before, { recursive: true });
	const journal = Bun.file(join(before, "meta", "_journal.json"));
	const entries = await journal.json();
	entries.entries = entries.entries.filter(
		(e: { tag: string }) => e.tag < "0013",
	);
	await Bun.write(journal, JSON.stringify(entries));

	const path = join(dir, "db.sqlite");
	const old = new SqliteRepository(path, before);
	await old.createSession({
		id: "ses_1",
		userId: "ana",
		title: "t",
		createdAt: 1,
		updatedAt: 1,
	});
	old.close();
	const raw = new Database(path);
	raw.run(
		"insert into turns (id, session_id, user_id, prompt, reference_asset_ids, created_at) values ('trn_1', 'ses_1', 'ana', 'x', '[]', 1)",
	);
	raw.close();

	const repo = new SqliteRepository(path);
	expect((await repo.listTurns(ana, "ses_1"))[0]?.pickedAssetId).toBeNull();
	await repo.setPick(ana, "trn_1", { assetId: "ast_1", modelId: "m" });
	expect((await repo.listTurns(ana, "ses_1"))[0]?.pickedAssetId).toBe("ast_1");
	// Deleting the session takes its picks with it.
	await repo.deleteSession(ana, "ses_1");
	expect(await repo.listPickedTurns(ana)).toEqual([]);
	repo.close();
});
