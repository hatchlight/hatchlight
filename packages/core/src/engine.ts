import type { AssetStore } from "./assets";
import type { JobPatch, Repository } from "./db/repository";
import {
	AccessError,
	CodedError,
	describeError,
	ValidationError,
} from "./errors";
import { newId } from "./ids";
import type { FoundKey, KeySource, KeyStore } from "./keys";
import { sniffMime } from "./mime";
import type {
	ProviderAdapter,
	ProviderOutput,
	ProviderRegistry,
	ReferenceImage,
} from "./provider";
import {
	cleanTranslation,
	plainlyEnglish,
	sameWords,
	type Translator,
} from "./translate";
import {
	type EngineEvent,
	type GenerationParams,
	type Job,
	type JobView,
	type ModelSpec,
	TERMINAL_STATUSES,
	type UserContext,
} from "./types";

const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

function isResumable(adapter: ProviderAdapter, handle: unknown): boolean {
	return adapter.isResumable?.(handle) ?? adapter.resumable;
}

/** What a job cost going by the model's list price, when it has one. */
function estimateCost(
	model: ModelSpec,
	params: GenerationParams,
	outputs: number,
): number | null {
	const { usdPerSecond, usdPerOutput } = model.pricing ?? {};
	if (usdPerSecond != null && params.durationSeconds != null) {
		return usdPerSecond * params.durationSeconds * outputs;
	}
	return usdPerOutput == null ? null : usdPerOutput * outputs;
}

/**
 * Which waiting job starts next: the oldest job of the person who has
 * waited longest since one of theirs last started (never counts as
 * longest). Ties go to the job that came first.
 */
function nextInTurn(
	queue: readonly { userId: string }[],
	lastStart: ReadonlyMap<string, number>,
): number {
	let best = 0;
	let bestStart = Number.POSITIVE_INFINITY;
	queue.forEach((job, index) => {
		const started = lastStart.get(job.userId) ?? 0;
		if (started < bestStart) {
			best = index;
			bestStart = started;
		}
	});
	return best;
}

/** What the engine needs of a job to queue it. */
type Queued = Pick<Job, "id" | "userId" | "providerId" | "modelId">;

/** A job waiting in a line, and whom to tell where it stands. */
interface Waiting {
	id: string;
	userId: string;
}

export type EngineListener = (userId: string, event: EngineEvent) => void;

export interface JobEngineDeps {
	repo: Repository;
	assets: AssetStore;
	registry: ProviderRegistry;
	keys: KeyStore;
	/**
	 * Why a person may not use models that need a key, which spend money, or
	 * null when they may. Everyone may when absent, as on a personal install.
	 */
	paidRefusal?: (userId: string, source: KeySource) => PaidRefusal | null;
	/** Jobs running at once per provider. Defaults to 4. */
	concurrencyPerProvider?: number;
	/** The wait before the first try again; it doubles each time. */
	retryDelayMs?: number;
	/**
	 * Puts prompts into English for models that read only English: the one
	 * a user has chosen and can use now, or null when none. Without one,
	 * prompts go as written.
	 */
	translator?: (
		userId: string,
	) => Translator | null | Promise<Translator | null>;
}

/** Why someone may not spend on paid models. */
export type PaidRefusal = "paidNotAllowed" | "monthlyLimitReached";

export function paidError(refusal: PaidRefusal): AccessError {
	return new AccessError(
		refusal === "paidNotAllowed"
			? "This account cannot use paid models"
			: "This month's limit for paid models is reached",
		refusal,
		403,
	);
}

/** A translation that takes longer is given up on; the prompt goes as written. */
const TRANSLATE_TIMEOUT_MS = 60_000;

/** Tries in all for a passing failure, unless the failure says otherwise. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
/** A provider asking to wait longer than this is not waited for. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Sleeps, rejecting as soon as the signal aborts. */
/**
 * Never resolves; rejects as soon as `signal` aborts. Its rejection after a
 * race is over is expected, so it is never reported as unhandled.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
	const aborted = new Promise<never>((_, reject) => {
		if (signal.aborted) return reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
	aborted.catch(() => {});
	return aborted;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		const stop = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", stop, { once: true });
	});
}

/**
 * Runs jobs against their providers: queues them per provider, follows each
 * one to completion, stores the outputs and reports progress to listeners.
 */
export class JobEngine {
	private listeners = new Set<EngineListener>();
	private controllers = new Map<string, AbortController>();
	/** The latest picture of each running job that shows one. */
	private previews = new Map<
		string,
		{ userId: string; data: Uint8Array; mime: string; version: number }
	>();
	/** Jobs waiting to run, by line: a provider, or a line of one. */
	private waiting = new Map<string, Waiting[]>();
	private active = new Map<string, number>();
	/**
	 * When each person's last job started, by line, as a count of starts:
	 * the line takes turns between people rather than first come, first
	 * served, so one person's long batch does not hold everyone back.
	 */
	private lastStart = new Map<string, Map<string, number>>();
	private starts = 0;
	/** Jobs queued or running here, so that none is ever run twice at once. */
	private owned = new Set<string>();
	/**
	 * Translations in progress or just made, by translator and prompt: the
	 * jobs of one turn share their prompt, and it is translated once for all
	 * of them.
	 */
	private translations = new WeakMap<
		Translator,
		Map<string, Promise<string | null>>
	>();
	private inflight = new Set<Promise<void>>();
	private limit: number;

	constructor(private deps: JobEngineDeps) {
		this.limit = deps.concurrencyPerProvider ?? 4;
	}

	subscribe(listener: EngineListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Picks up jobs left unfinished by a previous process. */
	async start(): Promise<void> {
		for (const job of await this.deps.repo.listUnfinishedJobs()) {
			const adapter = this.deps.registry.adapter(job.providerId);
			const canContinue =
				job.status === "queued" ||
				(adapter != null &&
					job.handle != null &&
					isResumable(adapter, job.handle));
			if (canContinue) {
				this.enqueue(job);
			} else {
				await this.update(job.id, {
					status: "failed",
					error: "Interrupted by a restart",
					errorCode: "interrupted",
					errorParams: null,
					finishedAt: Date.now(),
				});
			}
		}
	}

	enqueue(job: Queued): void {
		if (this.owned.has(job.id)) return;
		this.owned.add(job.id);
		this.schedule(job);
	}

	private schedule(job: Queued): void {
		const adapter = this.deps.registry.adapter(job.providerId);
		const line = adapter?.lineOf
			? `${job.providerId}#${adapter.lineOf(job.modelId)}`
			: job.providerId;
		const queue = this.waiting.get(line) ?? [];
		queue.push({ id: job.id, userId: job.userId });
		this.waiting.set(line, queue);
		this.pump(line, job.providerId);
		this.tellPlaces(line);
	}

	/**
	 * Tells each job still waiting in a line how many are before it, so a
	 * person sees why theirs has not started.
	 */
	private tellPlaces(line: string): void {
		// The order they will start in, taking turns as `pump` does.
		const queue = [...(this.waiting.get(line) ?? [])];
		const last = new Map(this.lastStart.get(line));
		let turn = this.starts;
		for (let position = 1; queue.length > 0; position++) {
			const [job] = queue.splice(nextInTurn(queue, last), 1);
			if (!job) break;
			last.set(job.userId, ++turn);
			this.emit(job.userId, {
				type: "job.progress",
				jobId: job.id,
				stage: "queued",
				position,
			});
		}
	}

	/** The latest picture of a running job, if it shows one, for its owner. */
	preview(
		userId: string,
		jobId: string,
	): { data: Uint8Array; mime: string } | undefined {
		const found = this.previews.get(jobId);
		return found?.userId === userId
			? { data: found.data, mime: found.mime }
			: undefined;
	}

	async cancel(jobId: string): Promise<void> {
		const controller = this.controllers.get(jobId);
		if (controller) {
			controller.abort();
			return;
		}
		for (const [line, queue] of this.waiting) {
			const index = queue.findIndex((job) => job.id === jobId);
			if (index === -1) continue;
			queue.splice(index, 1);
			this.owned.delete(jobId);
			await this.update(jobId, { status: "canceled", finishedAt: Date.now() });
			this.tellPlaces(line);
			return;
		}
	}

	/**
	 * Runs a job that failed or was canceled again, as it was asked: same
	 * model, same parameters (the same seed, when it had one). A job the
	 * provider took and may have finished (and charged for) is followed again
	 * rather than sent anew; it keeps its handle unless the provider said the
	 * job itself failed.
	 */
	async retry(job: Job): Promise<void> {
		if (job.status !== "failed" && job.status !== "canceled") {
			throw new ValidationError(
				"Only a job that failed or was canceled can be tried again",
				"jobNotRetryable",
			);
		}
		// A second click, or a second tab, must not run it twice.
		if (this.owned.has(job.id)) return;
		this.owned.add(job.id);
		try {
			await this.update(job.id, {
				status: "queued",
				error: null,
				errorCode: null,
				errorParams: null,
				costUsd: null,
				startedAt: null,
				finishedAt: null,
			});
		} catch (error) {
			this.owned.delete(job.id);
			throw error;
		}
		this.schedule(job);
	}

	/** Resolves once no job is queued or running. */
	async idle(): Promise<void> {
		while (this.inflight.size > 0) await Promise.all(this.inflight);
	}

	/** Starts what the line has room for; says whether any job started. */
	private pump(line: string, providerId: string): boolean {
		const queue = this.waiting.get(line) ?? [];
		const adapter = this.deps.registry.adapter(providerId);
		const limit = Math.min(this.limit, adapter?.maxConcurrency ?? this.limit);
		let moved = false;
		const last = this.lastStart.get(line) ?? new Map<string, number>();
		this.lastStart.set(line, last);
		while ((this.active.get(line) ?? 0) < limit) {
			const [next] = queue.splice(nextInTurn(queue, last), 1);
			const jobId = next?.id;
			if (!next || !jobId) break;
			last.set(next.userId, ++this.starts);
			moved = true;
			this.active.set(line, (this.active.get(line) ?? 0) + 1);
			const run = this.run(jobId)
				// run() records its own failures; this only catches a failure to record
				// one (e.g. the database is unavailable). The job is settled on restart.
				.catch((error) =>
					console.error(`Job ${jobId} could not be settled`, error),
				)
				.finally(() => {
					this.owned.delete(jobId);
					this.inflight.delete(run);
					this.active.set(line, (this.active.get(line) ?? 1) - 1);
					if (this.pump(line, providerId)) this.tellPlaces(line);
				});
			this.inflight.add(run);
		}
		return moved;
	}

	private async run(jobId: string): Promise<void> {
		const job = await this.deps.repo.findJob(jobId);
		if (!job || TERMINAL_STATUSES.includes(job.status)) return;

		const controller = new AbortController();
		this.controllers.set(jobId, controller);
		let providerFailed = false;
		// Whose key paid, for the ledger.
		let keySource: KeySource = "server";
		const { registry, keys } = this.deps;
		const adapter = registry.adapter(job.providerId);
		const ctx: UserContext = { userId: job.userId };
		let handle = job.handle;
		let pctx = {
			apiKey: undefined as string | undefined,
			signal: controller.signal,
		};

		try {
			const model = registry.model(job.modelId);
			if (!adapter || !model) {
				throw new CodedError(
					`Model is not available: ${job.modelId}`,
					"modelUnavailable",
					{ model: job.modelId },
				);
			}
			// A person's own key first; the server's, or one from the
			// environment, otherwise.
			const envKey = adapter.keyEnv ? process.env[adapter.keyEnv] : undefined;
			const found: FoundKey | undefined =
				(await keys.find(ctx, adapter.id)) ??
				(envKey ? { key: envKey, source: "server" } : undefined);
			keySource = found?.source ?? "server";
			const refusal = adapter.requiresKey
				? this.deps.paidRefusal?.(job.userId, keySource)
				: null;
			if (refusal) throw paidError(refusal);
			const apiKey = found?.key;
			if (adapter.requiresKey && !apiKey) {
				throw new CodedError(
					`No API key configured for ${adapter.name}`,
					"noApiKey",
					{ provider: adapter.name },
				);
			}
			pctx = { apiKey, signal: controller.signal };

			for (let attempt = 1; ; attempt++) {
				providerFailed = false;
				try {
					if (handle != null && attempt === 1 && job.status === "queued") {
						// Tried again by hand: the provider's job is followed again.
						await this.update(jobId, {
							status: "running",
							startedAt: Date.now(),
						});
					}
					if (handle == null) {
						await this.update(jobId, {
							status: "running",
							startedAt: Date.now(),
						});
						const references = await this.loadReferences(
							ctx,
							job.params.referenceAssetIds,
						);
						const [mask] =
							job.params.maskAssetId != null
								? await this.loadReferences(ctx, [job.params.maskAssetId])
								: [];
						const params = await this.inEnglish(job, model, controller.signal);
						handle = await adapter.submit(
							{
								model,
								params,
								references,
								...(mask && { mask }),
							},
							pctx,
						);
						// Only a resumable handle is worth storing; others can embed whole images.
						if (isResumable(adapter, handle))
							await this.update(jobId, { handle });
					}

					for await (const event of adapter.events(handle, pctx)) {
						if (event.type === "progress") {
							let preview: number | undefined;
							if (event.preview) {
								preview = (this.previews.get(jobId)?.version ?? 0) + 1;
								this.previews.set(jobId, {
									userId: job.userId,
									...event.preview,
									version: preview,
								});
							}
							this.emit(job.userId, {
								type: "job.progress",
								jobId,
								fraction: event.fraction,
								message: event.message,
								stage: event.stage,
								position: event.position,
								step: event.step,
								steps: event.steps,
								...(preview != null && { preview }),
							});
						} else if (event.type === "failed") {
							// Losing sight of the job is not the job failing.
							providerFailed = event.code !== "connectionLost";
							throw new CodedError(
								event.error,
								event.code,
								event.params,
								event.retry,
							);
						} else {
							for (const output of event.outputs) {
								await this.storeOutput(ctx, job, output, controller.signal);
							}
							const costUsd =
								event.costUsd ??
								estimateCost(model, job.params, event.outputs.length);
							await this.update(jobId, {
								status: "succeeded",
								error: null,
								errorCode: null,
								errorParams: null,
								finishedAt: Date.now(),
								costUsd,
							});
							// Kept apart from the job, which can be deleted.
							if (costUsd != null && costUsd > 0) {
								await this.deps.repo.addSpending({
									id: newId("spd"),
									userId: job.userId,
									kind: "generation",
									keySource,
									jobId,
									costUsd,
									createdAt: Date.now(),
								});
							}
							return;
						}
					}
					throw new CodedError(
						"The provider ended without a result",
						"noResult",
					);
				} catch (error) {
					// A passing failure (a provider refusing for now, a connection
					// never made, a local engine that crashed) is tried again.
					const retry = error instanceof CodedError ? error.retry : undefined;
					if (
						!retry ||
						controller.signal.aborted ||
						attempt >= (retry.attempts ?? ATTEMPTS) ||
						(retry.afterMs ?? 0) > MAX_RETRY_AFTER_MS
					) {
						throw error;
					}
					this.emit(job.userId, {
						type: "job.progress",
						jobId,
						message: "Trying again",
						stage: "retrying",
					});
					await sleep(
						retry.afterMs ??
							(this.deps.retryDelayMs ?? RETRY_DELAY_MS) * 2 ** (attempt - 1),
						controller.signal,
					);
				}
			}
		} catch (error) {
			if (controller.signal.aborted) {
				if (handle != null) {
					// The job is canceled locally either way; this only saves provider-side work.
					await adapter
						?.cancel?.(handle, {
							...pctx,
							signal: new AbortController().signal,
						})
						.catch(() => {});
				}
				await this.update(jobId, {
					status: "canceled",
					finishedAt: Date.now(),
				});
			} else {
				const { message, code, params } = describeError(error);
				await this.update(jobId, {
					status: "failed",
					error: message,
					errorCode: code,
					errorParams: params,
					finishedAt: Date.now(),
					// Trying a job again follows its handle, so the result of work
					// already paid for is collected. Only once the provider says the
					// job itself failed is there nothing left to follow.
					...(providerFailed && { handle: null }),
				});
			}
		} finally {
			// Only this run's: a job tried again may already have its own.
			if (this.controllers.get(jobId) === controller) {
				this.controllers.delete(jobId);
				this.previews.delete(jobId);
			}
		}
	}

	/**
	 * The parameters to send: for a model that reads only English, with the
	 * prompt in English. The translation is kept with the job, which shows
	 * it; the prompt as written stays. When nothing can translate, or the
	 * translation fails, the prompt goes as written.
	 */
	private async inEnglish(
		job: Job,
		model: ModelSpec,
		signal: AbortSignal,
	): Promise<GenerationParams> {
		if (!model.capabilities.englishPrompts) return job.params;
		if (job.params.translatedPrompt) {
			return { ...job.params, prompt: job.params.translatedPrompt };
		}
		const { prompt } = job.params;
		// Asking a model whether English is English costs seconds.
		if (plainlyEnglish(prompt)) return job.params;
		const translator = await this.deps.translator?.(job.userId);
		if (!translator) return job.params;
		this.emit(job.userId, {
			type: "job.progress",
			jobId: job.id,
			message: "Translating the prompt",
			stage: "translating",
		});
		let made = this.translations.get(translator);
		if (!made) {
			made = new Map();
			this.translations.set(translator, made);
		}
		const translations = made;
		let pending = translations.get(prompt);
		if (!pending) {
			// Not tied to this job: the others of its turn wait on it too.
			pending = translator
				.toEnglish(prompt, AbortSignal.timeout(TRANSLATE_TIMEOUT_MS))
				.then(
					(text) => cleanTranslation(text) || null,
					(error) => {
						console.error("Could not translate a prompt", error);
						return null;
					},
				);
			translations.set(prompt, pending);
			const forget = () => translations.delete(prompt);
			void pending.then((english) => {
				// A failure is not kept: trying again translates again.
				if (!english) forget();
				// A translation is, for a moment, for the other jobs of the turn.
				else setTimeout(forget, 60_000).unref?.();
			});
		}
		// The translation goes on for the turn's other jobs; this one stops
		// waiting as soon as it is canceled.
		const english = await Promise.race([pending, rejectOnAbort(signal)]);
		signal.throwIfAborted();
		if (!english || sameWords(english, prompt)) return job.params;
		const params = { ...job.params, translatedPrompt: english };
		await this.update(job.id, { params });
		return { ...params, prompt: english };
	}

	private async loadReferences(
		ctx: UserContext,
		assetIds: string[],
	): Promise<ReferenceImage[]> {
		const assets = await this.deps.repo.getAssets(ctx, assetIds);
		return Promise.all(
			assetIds.map(async (id) => {
				const asset = assets.find((a) => a.id === id);
				const blob = asset && (await this.deps.assets.get(ctx, asset.hash));
				if (!asset || !blob)
					throw new Error(`Reference image is missing: ${id}`);
				return { data: await blob.bytes(), mime: asset.mime };
			}),
		);
	}

	private async storeOutput(
		ctx: UserContext,
		job: JobView,
		output: ProviderOutput,
		signal: AbortSignal,
	): Promise<void> {
		let data: Uint8Array;
		let mime = output.mime;
		if ("url" in output) {
			// A provider's response must not be able to make us read local files.
			if (!output.url.startsWith("https://")) {
				throw new CodedError(
					"The provider returned a result URL that is not HTTPS",
					"resultNotHttps",
				);
			}
			const response = await fetch(output.url, {
				headers: output.headers,
				signal,
			});
			if (!response.ok) {
				throw new CodedError(
					`Could not download the result (HTTP ${response.status})`,
					"resultDownloadFailed",
					{ status: response.status },
				);
			}
			if (Number(response.headers.get("content-length")) > MAX_OUTPUT_BYTES) {
				throw new CodedError(
					"The result is too large to store",
					"resultTooLarge",
				);
			}
			data = await response.bytes();
			mime ??= response.headers.get("content-type")?.split(";")[0];
		} else {
			data = output.data;
		}
		if (data.byteLength > MAX_OUTPUT_BYTES) {
			throw new CodedError(
				"The result is too large to store",
				"resultTooLarge",
			);
		}
		const stored = await this.deps.assets.put(ctx, data);
		// Collected again when a job is tried again after storing part of it.
		if (job.assets.some((asset) => asset.hash === stored.hash)) return;
		await this.deps.repo.createAsset({
			id: newId("ast"),
			userId: ctx.userId,
			kind: "output",
			jobId: job.id,
			prompt: job.params.prompt,
			modelId: job.modelId,
			params: job.params,
			hash: stored.hash,
			// Providers and their CDNs mislabel files often enough to check.
			mime: sniffMime(data) ?? mime ?? "application/octet-stream",
			size: stored.size,
			createdAt: Date.now(),
		});
	}

	private async update(jobId: string, patch: JobPatch): Promise<void> {
		await this.deps.repo.updateJob(jobId, patch);
		const job = await this.deps.repo.findJob(jobId);
		if (job) this.emit(job.userId, { type: "job.updated", job });
	}

	private emit(userId: string, event: EngineEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(userId, event);
			} catch (error) {
				// A broken listener must not change the outcome of a job.
				console.error("A job event listener failed", error);
			}
		}
	}
}
