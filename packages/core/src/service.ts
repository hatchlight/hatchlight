import type { AssetStore } from "./assets";
import { hasChoice } from "./blind";
import type { SqliteLibrary } from "./db/library";
import type { GalleryQuery, Repository } from "./db/repository";
import type { JobEngine } from "./engine";
import { NotFoundError, ValidationError } from "./errors";
import { newId } from "./ids";
import type { KeyStore } from "./keys";
import { applyLibrary } from "./library";
import { sniffMime } from "./mime";
import type { ProviderRegistry } from "./provider";
import { rankModels } from "./ranking";
import {
	type Asset,
	type CreateTurnInput,
	type GalleryItem,
	type GenerationParams,
	generationParamsSchema,
	type Job,
	type JobView,
	type LibraryEntry,
	type LibraryInput,
	type LibraryKind,
	type LoraInfo,
	libraryInputSchema,
	type ModelSpec,
	type ProviderStatus,
	type Ranking,
	type RankingQuery,
	type Session,
	type Turn,
	type TurnView,
	type UserContext,
} from "./types";

export interface ReelServiceDeps {
	repo: Repository;
	assets: AssetStore;
	registry: ProviderRegistry;
	keys: KeyStore;
	engine: JobEngine;
	/**
	 * Why a person may not add pictures now (their room is full), or null.
	 * Checked by everything that makes new ones: turns, retries, uploads.
	 */
	storageRefusal?: (userId: string) => Error | null;
	/** Each person's characters and styles; without it, none can be kept. */
	library?: Pick<
		SqliteLibrary,
		"list" | "get" | "findByName" | "put" | "delete"
	>;
	/** The LoRAs installed, which characters and styles may name. */
	loras?: () => Promise<LoraInfo[]>;
}

const UPLOAD_MIMES = ["image/png", "image/jpeg", "image/webp"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Fits the requested parameters to what one model supports. */
export function adaptParams(
	model: ModelSpec,
	params: GenerationParams,
): GenerationParams {
	const caps = model.capabilities;
	if (params.referenceAssetIds.length > caps.maxReferenceImages) {
		throw caps.maxReferenceImages === 0
			? new ValidationError(
					`${model.name} does not accept reference images`,
					"noReferences",
					{ model: model.name },
				)
			: new ValidationError(
					`${model.name} accepts at most ${caps.maxReferenceImages} reference images`,
					"tooManyReferences",
					{ model: model.name, count: caps.maxReferenceImages },
				);
	}
	if (
		(caps.upscale != null || caps.needsReference) &&
		params.referenceAssetIds.length === 0
	) {
		throw new ValidationError(
			`${model.name} needs a picture to work on`,
			"needsPicture",
			{ model: model.name },
		);
	}
	if (params.maskAssetId != null) {
		// A mask marks one picture: with none, or several, it marks nothing.
		if (params.referenceAssetIds.length !== 1) {
			throw new ValidationError(
				"A mask needs exactly one reference image to redraw",
				"maskWithoutReference",
			);
		}
		if (caps.mask == null) {
			throw new ValidationError(
				`${model.name} cannot redraw only part of a picture`,
				"noMask",
				{ model: model.name },
			);
		}
	}
	const guide = params.guide;
	if (guide) {
		if (caps.guide == null) {
			throw new ValidationError(
				`${model.name} cannot follow a guide picture`,
				"noGuide",
				{ model: model.name },
			);
		}
		if (!caps.guide.kinds.includes(guide.kind)) {
			throw new ValidationError(
				`${model.name} cannot follow a guide of this kind`,
				"guideKindUnsupported",
				{ model: model.name },
			);
		}
		// Outlines can be found in any picture; a pose or depth map, only by
		// models that make one.
		if (!guide.ready && !caps.guide.makesMaps.includes(guide.kind)) {
			throw new ValidationError(
				`${model.name} cannot make this map itself: give a picture that already is one`,
				"guideNeedsMap",
				{ model: model.name },
			);
		}
	}
	const durations = caps.durations ?? [];
	// Always explicit, so the stored parameters say what was actually asked for.
	// Unasked, the shortest: providers bill video by the second.
	const wanted = params.durationSeconds ?? durations[0];
	return {
		...params,
		count: Math.min(params.count, caps.maxCount),
		durationSeconds:
			wanted == null || durations.length === 0
				? undefined
				: durations.reduce((best, d) =>
						Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best,
					),
		// A redrawn picture keeps its reference's shape, and a guided one its
		// guide's, whatever was asked.
		aspectRatio:
			params.aspectRatio &&
			caps.aspectRatios.includes(params.aspectRatio) &&
			!(caps.strength != null && params.referenceAssetIds.length > 0) &&
			!guide
				? params.aspectRatio
				: undefined,
		seed: caps.seed ? params.seed : undefined,
		// Only what was used, and always said: a strength means something only
		// when redrawing, and unasked it is the model's own.
		strength:
			caps.strength != null && params.referenceAssetIds.length > 0
				? (params.strength ??
					(params.maskAssetId != null ? caps.mask : undefined) ??
					caps.strength)
				: undefined,
		// Only for models that take LoRAs, so one prompt can still go to
		// models that do not; the provider checks each is of their family.
		loras: caps.loraBase && params.loras?.length ? params.loras : undefined,
		// Always said, like the strength: unasked, it is the model's own.
		guide:
			guide && caps.guide
				? { ...guide, strength: guide.strength ?? caps.guide.strength }
				: undefined,
	};
}

/** The application's operations, shared by every interface (HTTP, CLI, desktop). */
export class ReelService {
	constructor(private deps: ReelServiceDeps) {}

	listModels(): ModelSpec[] {
		return this.deps.registry.listModels();
	}

	async listProviders(ctx: UserContext): Promise<ProviderStatus[]> {
		const stored = await this.deps.keys.list(ctx);
		const sources = (await this.deps.keys.sources?.(ctx)) ?? null;
		return this.deps.registry.listAdapters().map((adapter) => ({
			id: adapter.id,
			name: adapter.name,
			requiresKey: adapter.requiresKey,
			hasKey:
				stored.includes(adapter.id) ||
				Boolean(adapter.keyEnv && process.env[adapter.keyEnv]),
			...(sources && {
				keys: {
					personal: sources.personal.includes(adapter.id),
					server:
						sources.server.includes(adapter.id) ||
						Boolean(adapter.keyEnv && process.env[adapter.keyEnv]),
				},
			}),
		}));
	}

	async setProviderKey(ctx: UserContext, providerId: string, key: string) {
		this.requireProvider(providerId);
		if (!key.trim()) {
			throw new ValidationError("The key is empty", "emptyKey");
		}
		await this.deps.keys.set(ctx, providerId, key.trim());
	}

	async deleteProviderKey(ctx: UserContext, providerId: string) {
		this.requireProvider(providerId);
		await this.deps.keys.delete(ctx, providerId);
	}

	private requireProvider(providerId: string) {
		if (!this.deps.registry.adapter(providerId)) {
			throw new NotFoundError(
				`Unknown provider: ${providerId}`,
				"unknownProvider",
				{
					provider: providerId,
				},
			);
		}
	}

	listSessions(ctx: UserContext): Promise<Session[]> {
		return this.deps.repo.listSessions(ctx);
	}

	async getSession(
		ctx: UserContext,
		id: string,
	): Promise<Session & { turns: TurnView[] }> {
		const session = await this.deps.repo.getSession(ctx, id);
		if (!session) {
			throw new NotFoundError("Session not found", "sessionNotFound");
		}
		return { ...session, turns: await this.deps.repo.listTurns(ctx, id) };
	}

	/** Whether the person has this session, without reading its turns. */
	async hasSession(ctx: UserContext, id: string): Promise<boolean> {
		return (await this.deps.repo.getSession(ctx, id)) != null;
	}

	/** An empty session, for a conversation that starts with words. */
	async startSession(ctx: UserContext, title: string): Promise<Session> {
		const now = Date.now();
		const session: Session = {
			id: newId("ses"),
			userId: ctx.userId,
			title: title.slice(0, 80),
			createdAt: now,
			updatedAt: now,
		};
		await this.deps.repo.createSession(session);
		return session;
	}

	async deleteSession(ctx: UserContext, id: string): Promise<void> {
		const session = await this.getSession(ctx, id);
		for (const job of session.turns.flatMap((turn) => turn.jobs)) {
			await this.deps.engine.cancel(job.id);
		}
		await this.deps.repo.deleteSession(ctx, id);
	}

	/** Throws when the person's pictures already take all their room. */
	private assertRoom(ctx: UserContext): void {
		const refusal = this.deps.storageRefusal?.(ctx.userId);
		if (refusal) throw refusal;
	}

	async createTurn(
		ctx: UserContext,
		input: CreateTurnInput,
	): Promise<{ session: Session; turn: TurnView }> {
		this.assertRoom(ctx);
		const { sessionId, modelIds, ...rawParams } = input;
		const parsed = generationParamsSchema.safeParse(rawParams);
		if (!parsed.success) {
			throw new ValidationError(
				parsed.error.issues[0]?.message ?? "Invalid input",
			);
		}
		const params = parsed.data;
		if (modelIds.length === 0)
			throw new ValidationError("Choose at least one model", "noModel");

		const models = [...new Set(modelIds)].map((id) => {
			const model = this.deps.registry.model(id);
			if (!model) {
				throw new ValidationError(`Unknown model: ${id}`, "unknownModel", {
					model: id,
				});
			}
			return model;
		});
		const marked = [
			...params.referenceAssetIds,
			...(params.maskAssetId != null ? [params.maskAssetId] : []),
			...(params.guide ? [params.guide.assetId] : []),
		];
		const references = await this.deps.repo.getAssets(ctx, marked);
		if (references.length !== new Set(marked).size) {
			throw new ValidationError(
				"A reference image was not found",
				"referenceNotFound",
			);
		}
		if (references.some((asset) => !asset.mime.startsWith("image/"))) {
			throw new ValidationError(
				"Only images can be used as references",
				"referenceNotImage",
			);
		}
		const used = await this.libraryUsed(ctx, params);
		const jobParams = models.map((model) =>
			adaptParams(
				model,
				used ? applyLibrary(params, model, used, used.loras) : params,
			),
		);

		const now = Date.now();
		let session: Session;
		if (sessionId) {
			const existing = await this.deps.repo.getSession(ctx, sessionId);
			if (!existing) {
				throw new NotFoundError("Session not found", "sessionNotFound");
			}
			session = { ...existing, updatedAt: now };
		} else {
			session = {
				id: newId("ses"),
				userId: ctx.userId,
				title: params.prompt.slice(0, 80),
				createdAt: now,
				updatedAt: now,
			};
			await this.deps.repo.createSession(session);
		}

		const turn: Turn = {
			id: newId("trn"),
			sessionId: session.id,
			userId: ctx.userId,
			prompt: params.prompt,
			referenceAssetIds: params.referenceAssetIds,
			createdAt: now,
		};
		const jobs: Job[] = models.map((model, index) => ({
			id: newId("job"),
			turnId: turn.id,
			position: index,
			userId: ctx.userId,
			providerId: model.providerId,
			modelId: model.id,
			params: jobParams[index] as GenerationParams,
			status: "queued",
			handle: null,
			error: null,
			errorCode: null,
			errorParams: null,
			costUsd: null,
			createdAt: now,
			startedAt: null,
			finishedAt: null,
			tokenId: ctx.tokenId ?? null,
		}));
		await this.deps.repo.createTurn(turn, jobs);
		for (const job of jobs) this.deps.engine.enqueue(job);

		return {
			session,
			turn: { ...turn, jobs: jobs.map((job) => ({ ...job, assets: [] })) },
		};
	}

	/**
	 * The character and style a generation names, each checked to be the
	 * person's, of its kind, and with its pictures and LoRAs still there.
	 */
	private async libraryUsed(ctx: UserContext, params: GenerationParams) {
		if (params.characterId == null && params.styleId == null) return null;
		const entry = (id: string | undefined, kind: LibraryKind) => {
			if (id == null) return null;
			const found = this.deps.library?.get(ctx, id);
			if (!found || found.kind !== kind) {
				throw new NotFoundError(
					`No ${kind} with id ${id}`,
					"libraryEntryNotFound",
				);
			}
			return found;
		};
		const character = entry(params.characterId, "character");
		const style = entry(params.styleId, "style");
		const loras = await this.installedLoras();
		for (const used of [character, style]) {
			if (used) await this.checkLibraryParts(ctx, used, loras);
		}
		return { character, style, loras };
	}

	private async installedLoras(): Promise<Map<string, LoraInfo>> {
		const list = (await this.deps.loras?.()) ?? [];
		return new Map(list.map((lora) => [lora.id, lora]));
	}

	/** Refuses an entry whose pictures or LoRAs are not there (any more). */
	private async checkLibraryParts(
		ctx: UserContext,
		entry: Pick<LibraryEntry, "name" | "pictureIds" | "loras">,
		loras: Map<string, LoraInfo>,
	) {
		const missing = entry.loras.find((l) => !loras.has(l.id));
		if (missing) {
			throw new ValidationError(
				`The LoRA ${missing.id} of ${entry.name} is not installed`,
				"libraryLoraMissing",
				{ name: entry.name, lora: missing.id },
			);
		}
		const ids = [...new Set(entry.pictureIds)];
		const pictures = await this.deps.repo.getAssets(ctx, ids);
		if (
			pictures.length !== ids.length ||
			pictures.some((asset) => !asset.mime.startsWith("image/"))
		) {
			throw new ValidationError(
				`A picture of ${entry.name} is not in the gallery`,
				"libraryPictureMissing",
				{ name: entry.name },
			);
		}
	}

	private get library() {
		const library = this.deps.library;
		if (!library) throw new Error("No library is kept here");
		return library;
	}

	/** The person's characters and styles, by kind and name. */
	listLibrary(ctx: UserContext): LibraryEntry[] {
		return this.deps.library?.list(ctx) ?? [];
	}

	/**
	 * Keeps a character or style, new or (with `id`) changed. Its name must
	 * be the person's only one of its kind, whatever the case; its pictures
	 * the person's own; its LoRAs and model installed.
	 */
	async saveLibraryEntry(
		ctx: UserContext,
		input: LibraryInput,
		id?: string,
	): Promise<LibraryEntry> {
		const parsed = libraryInputSchema.safeParse(input);
		if (!parsed.success) {
			throw new ValidationError(
				parsed.error.issues[0]?.message ?? "Invalid input",
			);
		}
		const fields = parsed.data;
		const before = id != null ? this.library.get(ctx, id) : null;
		if (id != null && !before) {
			throw new NotFoundError("Not in the library", "libraryEntryNotFound");
		}
		// What an entry is stays: uses of it say so.
		const kind = before?.kind ?? fields.kind;
		const same = this.library.findByName(ctx, kind, fields.name);
		if (same && same.id !== id) {
			throw new ValidationError(
				`There already is a ${kind} named ${same.name}`,
				"libraryNameTaken",
				{ name: same.name },
			);
		}
		if (fields.modelId != null && !this.deps.registry.model(fields.modelId)) {
			throw new ValidationError(
				`Unknown model: ${fields.modelId}`,
				"unknownModel",
				{ model: fields.modelId },
			);
		}
		const entry: LibraryEntry = {
			...fields,
			kind,
			pictureIds: [...new Set(fields.pictureIds)],
			loras: fields.loras.filter(
				(l, i, all) => all.findIndex((o) => o.id === l.id) === i,
			),
			id: before?.id ?? newId("lib"),
			createdAt: before?.createdAt ?? Date.now(),
			updatedAt: Date.now(),
		};
		await this.checkLibraryParts(ctx, entry, await this.installedLoras());
		try {
			this.library.put(ctx, entry);
		} catch (error) {
			// Taken meanwhile, by a save made at the same time.
			if (!/UNIQUE constraint failed/.test(String(error))) throw error;
			throw new ValidationError(
				`There already is a ${kind} named ${entry.name}`,
				"libraryNameTaken",
				{ name: entry.name },
			);
		}
		return entry;
	}

	async deleteLibraryEntry(ctx: UserContext, id: string): Promise<void> {
		if (!this.library.delete(ctx, id)) {
			throw new NotFoundError("Not in the library", "libraryEntryNotFound");
		}
	}

	async cancelJob(ctx: UserContext, jobId: string): Promise<void> {
		const job = await this.deps.repo.findJob(jobId);
		if (!job || job.userId !== ctx.userId)
			throw new NotFoundError("Job not found", "jobNotFound");
		await this.deps.engine.cancel(jobId);
	}

	/** One of the person's jobs. */
	async getJob(ctx: UserContext, jobId: string): Promise<JobView> {
		const job = await this.deps.repo.findJob(jobId);
		if (!job || job.userId !== ctx.userId)
			throw new NotFoundError("Job not found", "jobNotFound");
		return job;
	}

	/**
	 * Runs a job that failed or was canceled again. Says whether it was
	 * queued: false when it already was, as after a second click.
	 */
	async retryJob(ctx: UserContext, jobId: string): Promise<boolean> {
		this.assertRoom(ctx);
		const job = await this.getJob(ctx, jobId);
		return this.deps.engine.retry(job, ctx.tokenId ?? null);
	}

	/** The picture a running job shows as it forms. */
	jobPreview(
		ctx: UserContext,
		jobId: string,
	): { data: Uint8Array; mime: string } {
		const preview = this.deps.engine.preview(ctx.userId, jobId);
		if (!preview) throw new NotFoundError("No preview", "jobNotFound");
		return preview;
	}

	/**
	 * Deletes a picture or video of the person's. Its file goes only when no
	 * other of theirs shares it, and only then does it free room. Turns and
	 * jobs that showed it keep their place, without it.
	 */
	async deleteAsset(ctx: UserContext, id: string): Promise<void> {
		const [asset] = await this.deps.repo.getAssets(ctx, [id]);
		if (!asset) throw new NotFoundError("Asset not found", "assetNotFound");
		// A character or style keeps its pictures: taken away from it first.
		const keeper = this.listLibrary(ctx).find((e) => e.pictureIds.includes(id));
		if (keeper) {
			throw new ValidationError(
				`This picture is kept by ${keeper.name} in the library`,
				"pictureInLibrary",
				{ name: keeper.name },
			);
		}
		const { sharing } = await this.deps.repo.deleteAsset(ctx, id);
		if (sharing === 0) await this.deps.assets.remove(ctx, asset.hash);
	}

	async uploadAsset(ctx: UserContext, data: Uint8Array): Promise<Asset> {
		this.assertRoom(ctx);
		// The claimed type is ignored; the bytes decide.
		const mime = sniffMime(data);
		if (!mime || !UPLOAD_MIMES.includes(mime)) {
			throw new ValidationError(
				"Only PNG, JPEG and WebP images can be uploaded",
				"uploadType",
			);
		}
		const stored = await this.deps.assets.put(ctx, data);
		const asset: Asset = {
			id: newId("ast"),
			userId: ctx.userId,
			kind: "upload",
			jobId: null,
			hash: stored.hash,
			mime,
			size: stored.size,
			prompt: null,
			modelId: null,
			params: null,
			createdAt: Date.now(),
		};
		await this.deps.repo.createAsset(asset);
		return asset;
	}

	async getAssetFile(
		ctx: UserContext,
		id: string,
	): Promise<{ asset: Asset; blob: Blob }> {
		const [asset] = await this.deps.repo.getAssets(ctx, [id]);
		const blob = asset && (await this.deps.assets.get(ctx, asset.hash));
		if (!asset || !blob) {
			throw new NotFoundError("Asset not found", "assetNotFound");
		}
		return { asset, blob };
	}

	listGallery(ctx: UserContext, query: GalleryQuery): Promise<GalleryItem[]> {
		return this.deps.repo.listGallery(ctx, query);
	}

	/**
	 * Marks one result of a turn as the best of its comparison, replacing
	 * an earlier pick; null clears it. Only a result of that turn, and only
	 * where there was more than one to choose from.
	 */
	async pickResult(
		ctx: UserContext,
		turnId: string,
		assetId: string | null,
	): Promise<void> {
		const turn = await this.deps.repo.getTurn(ctx, turnId);
		if (!turn) throw new NotFoundError("Turn not found", "turnNotFound");
		if (assetId == null) {
			await this.deps.repo.setPick(ctx, turnId, null);
			return;
		}
		const job = turn.jobs.find((j) => j.assets.some((a) => a.id === assetId));
		if (!job) {
			throw new ValidationError(
				"That picture is not one of this turn's results",
				"pickNotInTurn",
			);
		}
		// Only a comparison between models counts toward the ranking.
		if (!hasChoice(turn)) {
			throw new ValidationError(
				"Only a comparison between models has a best result to pick",
				"pickNeedsComparison",
			);
		}
		await this.deps.repo.setPick(ctx, turnId, {
			assetId,
			modelId: job.modelId,
		});
	}

	/** How the person's picks rank the models they compared. */
	async ranking(ctx: UserContext, query: RankingQuery = {}): Promise<Ranking> {
		const since = query.period === "30d" ? Date.now() - 30 * DAY_MS : undefined;
		const picked = await this.deps.repo.listPickedTurns(ctx, since);
		return rankModels(picked, {
			media: query.media,
			kind: query.kind,
			model: (id) => this.deps.registry.model(id),
		});
	}
}
