import {
	AccessError,
	type AccountService,
	type Asset,
	findLibraryEntry,
	type JobEngine,
	type JobView,
	type KeySource,
	type LibraryKind,
	type LocalModelStore,
	libraryTags,
	MAX_LORAS,
	type ModelSpec,
	mayUsePaid,
	NotFoundError,
	nearestRatio,
	type PaidRefusal,
	type ProviderStatus,
	paidError,
	type ReelService,
	type Settings,
	type SettingsStore,
	TERMINAL_STATUSES,
	type UserContext,
	ValidationError,
} from "@hatchlight/core";
import { bestLocalModel } from "@hatchlight/tools";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { matchedRoutes } from "hono/route";
import { routeAccess, routeScope } from "./access";
import { allows } from "./auth";
import type { Limiter } from "./limiter";
import { assertPictureSize, hatchlightMask } from "./masks";
import type { ServerTransport } from "./transport";

/** The largest picture one may give, as for uploads in the app. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Requests that bring pictures, as files or base64 in JSON: a few each. */
const MAX_PICTURES_BYTES = 80 * 1024 * 1024;
/** A request to make pictures is a few lines of JSON. */
const MAX_ASK_BYTES = 1024 * 1024;
/** More than any prompt a model reads. */
const MAX_PROMPT_LENGTH = 32_000;
/** As many as a turn makes in the app. */
const MAX_COUNT = 8;
/** OpenAI takes up to 16 pictures to edit. */
const MAX_PICTURES = 16;
/** Requests one API token may have waiting at once, on a server. */
const MAX_WAITING = 4;
/** On a personal install every app asks as the one person: room for several. */
const MAX_WAITING_PERSONAL = 16;
/** Apps that get a session of their own; more share the generic one. */
const MAX_APP_SESSIONS = 20;
/** Seeds are 32-bit: one past the last wraps around to 0. */
const SEEDS = 2 ** 32;
/** A video model takes minutes; a picture should never take this long. */
const WAIT_MS = 15 * 60_000;

export interface ImageApiOptions {
	service: ReelService;
	engine: JobEngine;
	models: LocalModelStore;
	settings?: SettingsStore;
	/** The people of a server: then every call needs one of their tokens. */
	accounts?: AccountService;
	server?: ServerTransport;
	user: (c: Context) => UserContext;
	/** Why the person asking may not spend now, on a server. */
	paidRefusal: (c: Context, source: KeySource) => PaidRefusal | null;
	/** Wrong tokens, counted per address with those sent to /mcp. */
	failures: Limiter;
	address: (c: Context) => string;
	waitMs?: number;
}

/** A model, and the provider that runs it as the person asking sees it. */
interface Entry {
	model: ModelSpec;
	provider: ProviderStatus;
}

/** What other apps ask for, in Hatchlight's terms. */
interface Ask {
	prompt: string;
	/** The model as the app named it, if it did. */
	model?: string;
	count: number;
	width?: number;
	height?: number;
	seed?: number;
	pictures: Uint8Array[];
	/** White is redrawn, already in Hatchlight's convention. */
	mask?: Uint8Array;
	strength?: number;
}

interface Made {
	model: ModelSpec;
	assets: { asset: Asset; revisedPrompt?: string }[];
	costUsd: number;
}

const isTerminal = (status: string) =>
	(TERMINAL_STATUSES as readonly string[]).includes(status);

const ready = (provider: ProviderStatus) =>
	!provider.requiresKey || provider.hasKey;

/** Whether a model can do this: make from words, or start from pictures. */
const fits = (model: ModelSpec, pictures: number) =>
	pictures > 0
		? model.capabilities.maxReferenceImages >= pictures
		: model.operations.includes("generate");

/**
 * The model an app names: its id, or without its provider (`sdxl-turbo` for
 * `local/sdxl-turbo`) or by its name when only one matches.
 */
function named(entries: Entry[], name: string): Entry | undefined {
	// AUTOMATIC1111 titles end with the file's hash in brackets.
	const wanted = name
		.replace(/\s*\[[^\]]*\]$/, "")
		.trim()
		.toLowerCase();
	if (!wanted) return undefined;
	const exact = entries.find((e) => e.model.id.toLowerCase() === wanted);
	if (exact) return exact;
	const loose = entries.filter(
		(e) =>
			e.model.id.toLowerCase().endsWith(`/${wanted}`) ||
			e.model.name.toLowerCase() === wanted,
	);
	return loose.length === 1 ? loose[0] : undefined;
}

/** A `<lora:name:weight>` tag, as AUTOMATIC1111 prompts carry them. */
const LORA_TAG = /<lora:([^:<>]{1,100})(?::([^:<>]{0,20}))?>/gi;

/**
 * What sessions made through these APIs are called: a product label, like
 * an app's name, and so the same in every language, as the session titles
 * people write are.
 */
const SESSION_TITLE = "Image API";

/** The session pictures from an app land in, named after the app. */
function sessionTitle(agent: string | undefined): string {
	const app = agent?.match(/^[A-Za-z][\w.-]{0,39}/)?.[0];
	return app ? `${SESSION_TITLE}: ${app}` : SESSION_TITLE;
}

const openAiError = (status: number, message: string, code: string | null) => ({
	error: {
		message,
		type:
			status === 401
				? "authentication_error"
				: status === 403
					? "permission_error"
					: status === 429
						? "rate_limit_error"
						: status >= 500
							? "server_error"
							: "invalid_request_error",
		param: null,
		code,
	},
});

/** An error answered here, in Hatchlight's shape until it is reshaped. */
const failure = (status: number, error: string, code?: string | null) =>
	new Response(JSON.stringify({ error, ...(code && { code }) }), {
		status,
		headers: { "content-type": "application/json" },
	});

/** Another app's picture, base64 with or without a data: prefix. */
function decoded(text: unknown, what: string): Uint8Array {
	if (typeof text !== "string" || !text) {
		throw new ValidationError(`${what} must be a base64 picture`);
	}
	const data = Buffer.from(text.replace(/^data:[^,]*,/, ""), "base64");
	if (data.byteLength === 0) {
		throw new ValidationError(`${what} must be a base64 picture`);
	}
	return new Uint8Array(data);
}

/** Whether base64 text holds more than one picture may be. */
const tooLargeText = (text: unknown) =>
	typeof text === "string" && (text.length * 3) / 4 > MAX_UPLOAD_BYTES + 4;

const tooLarge = () => failure(413, "A picture is larger than 20 MB");

/** An integer from a field, or the fallback when it is left out. */
function whole(
	value: unknown,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	if (value === undefined || value === null || value === "") return fallback;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
		throw new ValidationError(
			`${name} must be a whole number from ${min} to ${max}`,
		);
	}
	return n;
}

/**
 * Answers the image APIs other apps already speak: OpenAI's (`/v1`), and
 * AUTOMATIC1111's (`/sdapi/v1`). What they make lands in the gallery, in a
 * session for each app, and paid models are off for them unless the person
 * turned them on.
 */
export function mountImageApi(app: Hono, options: ImageApiOptions): void {
	const { service, engine, models, accounts, user } = options;
	const waitMs = options.waitMs ?? WAIT_MS;

	// Errors in the shape each API's clients read.
	for (const [prefix, openAi] of [
		["/v1/*", true],
		["/sdapi/*", false],
	] as const) {
		app.use(prefix, async (c, next) => {
			await next();
			const res = c.res;
			if (
				res.status < 400 ||
				!res.headers.get("content-type")?.includes("application/json")
			) {
				return;
			}
			const body = (await res
				.clone()
				.json()
				.catch(() => null)) as { error?: unknown; code?: unknown } | null;
			if (typeof body?.error !== "string") return;
			const code = typeof body.code === "string" ? body.code : null;
			const headers = new Headers(res.headers);
			headers.delete("content-length");
			c.res = new Response(
				JSON.stringify(
					openAi
						? openAiError(res.status, body.error, code)
						: {
								error: code ?? "error",
								detail: body.error,
								errors: body.error,
							},
				),
				{ status: res.status, headers },
			);
		});
		app.use(prefix, async (c, next) => {
			// A web page never calls these; only programs do. Origins are
			// checked for every route already: this also stops pages that
			// send none.
			const site = c.req.header("sec-fetch-site");
			if (site && site !== "same-origin" && site !== "none") {
				return failure(403, "Forbidden origin");
			}
			await next();
		});
		// On a server, an API token, the same as agents use on /mcp, with its
		// scopes and its person's role. A cookie never opens these.
		if (accounts) app.use(prefix, signIn(accounts, options));
	}

	const settingsOf = async (ctx: UserContext): Promise<Partial<Settings>> =>
		(await options.settings?.get(ctx)) ?? {};

	/** Every image model, and its provider as the person asking sees it. */
	async function entries(ctx: UserContext): Promise<Entry[]> {
		const providers = new Map(
			(await service.listProviders(ctx)).map((p) => [p.id, p]),
		);
		return service.listModels().flatMap((model) => {
			const provider = providers.get(model.providerId);
			return provider &&
				model.media === "image" &&
				model.capabilities.upscale == null
				? [{ model, provider }]
				: [];
		});
	}

	/** Whether other apps may use paid models for the person asking. */
	async function paidAllowed(c: Context, ctx: UserContext) {
		if (!(await settingsOf(ctx)).otherAppsPaid) return false;
		if (!accounts) return true;
		const { user, apiToken } = c.get("viewer");
		return !!apiToken?.scopes.includes("paid") && mayUsePaid(user);
	}

	/** Models other apps can use now: ready, and paid only when allowed. */
	async function usable(c: Context, ctx: UserContext) {
		const paid = await paidAllowed(c, ctx);
		return (await entries(ctx)).filter(
			(e) => ready(e.provider) && (paid || !e.provider.requiresKey),
		);
	}

	/** The model named, among those usable first: a short name may fit more. */
	async function find(
		c: Context,
		ctx: UserContext,
		all: Entry[],
		name: string,
	) {
		return named(await usable(c, ctx), name) ?? named(all, name);
	}

	/** Throws when this model costs money the person asking may not spend. */
	async function assertMayPay(c: Context, ctx: UserContext, entry: Entry) {
		if (!entry.provider.requiresKey) return;
		if (!(await settingsOf(ctx)).otherAppsPaid) {
			throw new AccessError(
				"Other apps may use only free models. Turn on paid models for them in Hatchlight's settings",
				"otherAppsPaidOff",
				403,
			);
		}
		const refusal = options.paidRefusal(
			c,
			entry.provider.keys?.personal ? "personal" : "server",
		);
		if (refusal) throw paidError(refusal);
		if (accounts && !(await paidAllowed(c, ctx))) {
			throw paidError("tokenNotPaid");
		}
	}

	/**
	 * The model to use: the one named, if Hatchlight has it; else the one
	 * chosen for other apps, if it is free; else the best free one installed
	 * that can. A paid model is used only when the request names it.
	 */
	async function choose(
		c: Context,
		ctx: UserContext,
		name: string | undefined,
		pictures: number,
		masked: boolean,
	): Promise<ModelSpec> {
		const all = await entries(ctx);
		const asked = name ? await find(c, ctx, all, name) : undefined;
		if (asked) {
			if (!ready(asked.provider)) {
				throw new ValidationError(
					`Add your ${asked.provider.name} key in Hatchlight's settings to use this model`,
					"noApiKey",
					{ provider: asked.provider.name },
				);
			}
			await assertMayPay(c, ctx, asked);
			return asked.model;
		}
		const can = (m: ModelSpec) =>
			fits(m, pictures) && (!masked || m.capabilities.mask != null);
		// Unnamed, only free models: Open WebUI, for one, sends "dall-e-3"
		// whatever the person meant, and must never spend by it.
		const free = all
			.filter((e) => ready(e.provider) && !e.provider.requiresKey)
			.map((e) => e.model);
		const saved = (await settingsOf(ctx)).otherAppsModel;
		const kept = saved ? free.find((m) => m.id === saved) : undefined;
		if (kept && can(kept)) return kept;
		const fitting = free.filter(can);
		const best = bestLocalModel(fitting, pictures) ?? fitting[0];
		if (!best) {
			throw new ValidationError(
				masked
					? "No installed model can redraw only part of a picture. Install one in Hatchlight"
					: pictures > 0
						? "No installed model can start from a picture. Install one in Hatchlight"
						: "No model is installed. Install one in Hatchlight's Models",
				"noModel",
			);
		}
		return best;
	}

	/** LoRAs named in the prompt, AUTOMATIC1111's way, that Hatchlight has. */
	async function withLoras(prompt: string, model: ModelSpec) {
		const base = model.capabilities.loraBase;
		const loras: { id: string; weight: number }[] = [];
		if (!base || !prompt.includes("<lora:")) return { prompt, loras };
		const known = (await models.loras.list()).filter((l) => l.base === base);
		const text = prompt.replace(LORA_TAG, (tag, name: string, weight) => {
			const wanted = name.trim().toLowerCase();
			const lora = known.find(
				(l) => l.id === wanted || l.name.toLowerCase() === wanted,
			);
			if (
				!lora ||
				loras.length >= MAX_LORAS ||
				loras.some((l) => l.id === lora.id)
			) {
				return tag;
			}
			const strength = weight ? Number(weight) : 1;
			loras.push({
				id: lora.id,
				weight: Number.isFinite(strength)
					? Math.min(2, Math.max(-2, strength))
					: 1,
			});
			return " ";
		});
		return { prompt: text.replace(/\s{2,}/g, " ").trim(), loras };
	}

	/**
	 * The id of the character or style a prompt names as `<style:name>`,
	 * mirroring `<lora:…>`; refused when the name means none, or several.
	 */
	function libraryId(
		ctx: UserContext,
		kind: LibraryKind,
		name: string | undefined,
	): string | undefined {
		if (!name) return undefined;
		const found = findLibraryEntry(service.listLibrary(ctx), kind, name);
		if (found.entry) return found.entry.id;
		throw new NotFoundError(
			found.matches.length > 0
				? `"${name}" could be ${found.matches.map((e) => e.name).join(" or ")}: give the whole name`
				: `No ${kind} named ${name} in Hatchlight's library`,
			"libraryEntryNotFound",
		);
	}

	/** Each app's session, by person and title, once found or made. */
	const sessions = new Map<string, Promise<string>>();
	async function sessionFor(c: Context, ctx: UserContext): Promise<string> {
		const wanted = sessionTitle(c.req.header("user-agent"));
		const key = `${ctx.userId}\n${wanted}`;
		const known = sessions.get(key);
		if (known) {
			const id = await known.catch(() => null);
			// The person may have deleted it since.
			if (id && (await service.hasSession(ctx, id))) return id;
		}
		const found = (async () => {
			const all = await service.listSessions(ctx);
			const old = all.find((s) => s.title === wanted);
			if (old) return old.id;
			// Any program can call itself anything: past so many apps, the
			// rest share one session instead of filling the list.
			const apps = all.filter((s) =>
				s.title.startsWith(`${SESSION_TITLE}: `),
			).length;
			const title =
				wanted !== SESSION_TITLE && apps >= MAX_APP_SESSIONS
					? SESSION_TITLE
					: wanted;
			const shared = all.find((s) => s.title === title);
			return shared?.id ?? (await service.startSession(ctx, title)).id;
		})();
		sessions.set(key, found);
		return found;
	}

	/** Jobs under way for each caller, and how many requests wait on them. */
	const working = new Map<string, { jobs: Set<string>; waiting: number }>();
	const callerOf = (ctx: UserContext) => `${ctx.userId}\n${ctx.tokenId ?? ""}`;

	/** Waits until these jobs end, the client goes away, or too long passes. */
	function settled(
		ctx: UserContext,
		jobIds: string[],
		signal: AbortSignal,
	): Promise<JobView[] | "aborted" | "timeout"> {
		return new Promise((resolve, reject) => {
			// Each job as last seen, from its events.
			const seen = new Map<string, JobView>();
			let over = false;
			const stop = () => {
				over = true;
				clearTimeout(timer);
				unsubscribe();
				signal.removeEventListener("abort", onAbort);
			};
			const end = (value: JobView[] | "aborted" | "timeout") => {
				if (over) return;
				stop();
				resolve(value);
			};
			const check = () => {
				const jobs = jobIds.flatMap((id) => seen.get(id) ?? []);
				if (
					jobs.length === jobIds.length &&
					jobs.every((j) => isTerminal(j.status))
				) {
					end(jobs);
				}
			};
			const unsubscribe = engine.subscribe((target, event) => {
				if (
					target === ctx.userId &&
					event.type === "job.updated" &&
					jobIds.includes(event.job.id)
				) {
					seen.set(event.job.id, event.job);
					check();
				}
			});
			const onAbort = () => end("aborted");
			signal.addEventListener("abort", onAbort);
			const timer = setTimeout(() => end("timeout"), waitMs);
			if (signal.aborted) {
				onAbort();
				return;
			}
			// What ended before the subscription is seen here, once.
			void Promise.all(jobIds.map((id) => service.getJob(ctx, id))).then(
				(jobs) => {
					for (const job of jobs) {
						const later = seen.get(job.id);
						if (!later || !isTerminal(later.status)) seen.set(job.id, job);
					}
					check();
				},
				(error) => {
					if (over) return;
					stop();
					reject(error);
				},
			);
		});
	}

	/** Makes what an app asks for, waits for it, and says what came of it. */
	async function make(c: Context, ask: Ask): Promise<Made | Response> {
		const ctx = user(c);
		const caller = callerOf(ctx);
		// Counted before anything waits, so requests at once see each other.
		const mine = working.get(caller) ?? { jobs: new Set<string>(), waiting: 0 };
		if (mine.waiting >= (accounts ? MAX_WAITING : MAX_WAITING_PERSONAL)) {
			throw new AccessError(
				"Too many pictures under way for this app. Try again shortly",
				"tooManyAttempts",
				429,
				{ seconds: 5 },
			);
		}
		mine.waiting++;
		working.set(caller, mine);
		const jobIds: string[] = [];
		try {
			return await makeCounted(c, ctx, ask, mine, jobIds);
		} finally {
			mine.waiting--;
			for (const id of jobIds) mine.jobs.delete(id);
			if (mine.waiting === 0 && working.get(caller) === mine) {
				working.delete(caller);
			}
		}
	}

	async function makeCounted(
		c: Context,
		ctx: UserContext,
		ask: Ask,
		mine: { jobs: Set<string> },
		jobIds: string[],
	): Promise<Made | Response> {
		const model = await choose(
			c,
			ctx,
			ask.model,
			ask.pictures.length,
			ask.mask != null,
		);
		// A mask marks one picture, for a model that redraws only part.
		if (ask.mask && model.capabilities.mask == null) {
			throw new ValidationError(
				`${model.name} cannot redraw only part of a picture`,
				"noMask",
				{ model: model.name },
			);
		}
		if (ask.mask && ask.pictures.length !== 1) {
			throw new ValidationError(
				"A mask needs exactly one reference image to redraw",
				"maskWithoutReference",
			);
		}
		const tagged = libraryTags(ask.prompt);
		const { prompt: words, loras } = await withLoras(tagged.prompt, model);
		const character = libraryId(ctx, "character", tagged.character);
		const style = libraryId(ctx, "style", tagged.style);
		// A character alone is a prompt: it says who to draw.
		const prompt = words || tagged.character || "";
		if (!prompt) throw new ValidationError("prompt must be some words");
		for (const picture of ask.pictures) await assertPictureSize(picture);

		const uploaded: string[] = [];
		const upload = async (data: Uint8Array) => {
			const full = accounts?.storageRefusal(ctx.userId, data.byteLength);
			if (full) throw full;
			const { id } = await service.uploadAsset(ctx, data);
			uploaded.push(id);
			return id;
		};
		const cancel = () =>
			Promise.all(
				jobIds.map((id) => service.cancelJob(ctx, id).catch(() => {})),
			);
		const aspectRatio = nearestRatio(
			model.capabilities.aspectRatios,
			ask.width,
			ask.height,
		);
		// A model makes so many at once; more come in more turns.
		const per = Math.max(1, model.capabilities.maxCount);
		try {
			const references: string[] = [];
			for (const picture of ask.pictures) {
				references.push(await upload(picture));
			}
			const mask = ask.mask ? await upload(ask.mask) : undefined;
			const sessionId = await sessionFor(c, ctx);
			for (let made = 0; made < ask.count; made += per) {
				const { turn } = await service.createTurn(ctx, {
					sessionId,
					modelIds: [model.id],
					prompt,
					count: Math.min(per, ask.count - made),
					referenceAssetIds: references,
					...(aspectRatio && { aspectRatio }),
					...(ask.seed != null && { seed: (ask.seed + made) % SEEDS }),
					...(mask && { maskAssetId: mask }),
					...(ask.strength != null && { strength: ask.strength }),
					...(loras.length > 0 && { loras }),
					...(character && { characterId: character }),
					...(style && { styleId: style }),
				});
				for (const job of turn.jobs) {
					jobIds.push(job.id);
					mine.jobs.add(job.id);
				}
			}
		} catch (error) {
			await cancel();
			// Pictures given for a turn never made would only fill the gallery.
			if (jobIds.length === 0) {
				await Promise.all(
					uploaded.map((id) => service.deleteAsset(ctx, id).catch(() => {})),
				);
			}
			throw error;
		}
		const jobs = await settled(ctx, jobIds, c.req.raw.signal);
		if (jobs === "aborted") {
			// The app gave up: nobody would see what it asked for.
			await cancel();
			return new Response(null, { status: 499 });
		}
		if (jobs === "timeout") {
			return failure(
				504,
				"It is taking too long to wait for. It goes on, and lands in Hatchlight's gallery",
			);
		}
		const assets = jobs.flatMap((job) =>
			job.status === "succeeded"
				? job.assets
						.filter((a) => a.mime.startsWith("image/"))
						.map((asset) => ({
							asset,
							...(job.params.translatedPrompt && {
								revisedPrompt: job.params.translatedPrompt,
							}),
						}))
				: [],
		);
		if (assets.length === 0) {
			const failed = jobs.find((j) => j.status === "failed");
			return failure(
				502,
				failed?.error ?? "Nothing was made",
				failed?.errorCode,
			);
		}
		return {
			model,
			assets,
			costUsd: jobs.reduce((sum, j) => sum + (j.costUsd ?? 0), 0),
		};
	}

	/** A picture made, as PNG: what both APIs' clients expect. */
	async function png(ctx: UserContext, asset: Asset): Promise<string> {
		const { blob } = await service.getAssetFile(ctx, asset.id);
		const data = new Uint8Array(await blob.arrayBuffer());
		const out =
			asset.mime === "image/png"
				? data
				: await new Bun.Image(data).png().bytes();
		return Buffer.from(out).toString("base64");
	}

	const json = async (c: Context): Promise<Record<string, unknown>> => {
		const body = await c.req.json().catch(() => null);
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new ValidationError("Expected a JSON object");
		}
		return body;
	};
	const limit = (maxSize: number) =>
		bodyLimit({
			maxSize,
			onError: () => failure(413, "The request is too large"),
		});
	const text = (value: unknown, name: string): string | undefined => {
		if (value === undefined || value === null) return undefined;
		if (typeof value !== "string") {
			throw new ValidationError(`${name} must be text`);
		}
		return value;
	};
	const promptOf = (value: unknown, required: boolean) => {
		const prompt = text(value, "prompt") ?? "";
		if (required && !prompt.trim()) {
			throw new ValidationError("prompt must be some words");
		}
		if (prompt.length > MAX_PROMPT_LENGTH) {
			throw new ValidationError(
				`prompt must be at most ${MAX_PROMPT_LENGTH} characters`,
			);
		}
		return prompt;
	};

	// OpenAI's image API.

	/** `1024x1024` as a width and height; `auto` or nothing, neither. */
	const sizeOf = (value: unknown) => {
		const size = text(value, "size");
		if (!size || size === "auto") return {};
		const match = size.match(/^(\d{1,5})x(\d{1,5})$/);
		if (!match) {
			throw new ValidationError('size must be such as "1024x1024", or "auto"');
		}
		return { width: Number(match[1]), height: Number(match[2]) };
	};
	const formatOf = (value: unknown) => {
		const format = text(value, "response_format") ?? "b64_json";
		if (format !== "b64_json" && format !== "url") {
			throw new ValidationError('response_format must be "b64_json" or "url"');
		}
		return format;
	};
	const answerOpenAi = async (
		c: Context,
		made: Made | Response,
		format: "b64_json" | "url",
	) => {
		if (made instanceof Response) return made;
		const ctx = user(c);
		const origin = options.server?.publicOrigin ?? new URL(c.req.url).origin;
		const data = [];
		for (const { asset, revisedPrompt } of made.assets) {
			data.push({
				...(format === "url"
					? { url: `${origin}/api/assets/${asset.id}` }
					: { b64_json: await png(ctx, asset) }),
				...(revisedPrompt && { revised_prompt: revisedPrompt }),
			});
		}
		return c.json({ created: Math.floor(Date.now() / 1000), data });
	};

	app.get("/v1/models", async (c) =>
		c.json({
			object: "list",
			data: (await usable(c, user(c))).map(({ model }) => ({
				id: model.id,
				object: "model",
				created: 0,
				owned_by: model.providerId,
			})),
		}),
	);

	app.post("/v1/images/generations", limit(MAX_ASK_BYTES), async (c) => {
		const body = await json(c);
		const format = formatOf(body.response_format);
		const made = await make(c, {
			prompt: promptOf(body.prompt, true),
			model: text(body.model, "model"),
			count: whole(body.n, "n", 1, 1, MAX_COUNT),
			...sizeOf(body.size),
			...(body.seed != null && {
				seed: whole(body.seed, "seed", 0, 0, 2 ** 32 - 1),
			}),
			pictures: [],
		});
		return answerOpenAi(c, made, format);
	});

	app.post("/v1/images/edits", limit(MAX_PICTURES_BYTES), async (c) => {
		const form = await c.req.formData().catch(() => null);
		if (!form) {
			throw new ValidationError(
				"Send the pictures as multipart/form-data, as image and mask",
			);
		}
		const files = [...form.getAll("image"), ...form.getAll("image[]")].filter(
			(value): value is File => value instanceof Blob,
		);
		const maskFile = form.get("mask");
		if (files.length === 0) {
			throw new ValidationError("image must be one or more picture files");
		}
		if (files.length > MAX_PICTURES) {
			throw new ValidationError(`Give at most ${MAX_PICTURES} pictures`);
		}
		if (
			files.some((f) => f.size > MAX_UPLOAD_BYTES) ||
			(maskFile instanceof Blob && maskFile.size > MAX_UPLOAD_BYTES)
		) {
			return tooLarge();
		}
		const field = (name: string) => {
			const value = form.get(name);
			return typeof value === "string" ? value : undefined;
		};
		const format = formatOf(field("response_format"));
		const pictures = await Promise.all(
			files.map(async (f) => new Uint8Array(await f.arrayBuffer())),
		);
		const made = await make(c, {
			prompt: promptOf(field("prompt"), true),
			model: field("model"),
			count: whole(field("n"), "n", 1, 1, MAX_COUNT),
			...sizeOf(field("size")),
			...(field("seed") && {
				seed: whole(field("seed"), "seed", 0, 0, 2 ** 32 - 1),
			}),
			pictures,
			...(maskFile instanceof Blob && {
				mask: await hatchlightMask(
					new Uint8Array(await maskFile.arrayBuffer()),
					"transparent",
				),
			}),
		});
		return answerOpenAi(c, made, format);
	});

	app.all("/v1/*", () =>
		failure(404, "Not found: this server answers images and models only"),
	);

	// AUTOMATIC1111's API.

	/** Its answer: the pictures, what was asked, and what was used. */
	const answerA1111 = async (
		c: Context,
		made: Made | Response,
		body: Record<string, unknown>,
		seed: number | undefined,
	) => {
		if (made instanceof Response) return made;
		const ctx = user(c);
		const images: string[] = [];
		for (const { asset } of made.assets) images.push(await png(ctx, asset));
		const used = made.model.capabilities.seed ? (seed ?? -1) : -1;
		const seeds = images.map((_, i) => (used >= 0 ? (used + i) % SEEDS : -1));
		// The size made, which is the model's nearest to the one asked.
		const size = await (async () => {
			const first = made.assets[0];
			if (!first) return null;
			const { blob } = await service.getAssetFile(ctx, first.asset.id);
			return new Bun.Image(await blob.arrayBuffer())
				.metadata()
				.catch(() => null);
		})();
		const prompt = typeof body.prompt === "string" ? body.prompt : "";
		return c.json({
			images,
			parameters: { ...body, init_images: null, mask: null },
			info: JSON.stringify({
				prompt,
				all_prompts: images.map(() => prompt),
				negative_prompt: body.negative_prompt ?? "",
				seed: used,
				all_seeds: seeds,
				subseed: -1,
				all_subseeds: seeds.map(() => -1),
				width: size?.width ?? null,
				height: size?.height ?? null,
				// Each model runs with its own: what was asked is not used.
				sampler_name: null,
				cfg_scale: null,
				steps: null,
				batch_size: body.batch_size ?? 1,
				denoising_strength: body.denoising_strength ?? null,
				sd_model_name: made.model.id,
				sd_model_hash: null,
				infotexts: images.map(
					() => `${prompt}\nSeed: ${used}, Model: ${made.model.id}`,
				),
				cost_usd: made.costUsd,
			}),
		});
	};

	/** What AUTOMATIC1111's txt2img and img2img share. */
	const a1111Ask = (body: Record<string, unknown>) => {
		const overrides = body.override_settings;
		const checkpoint =
			overrides && typeof overrides === "object"
				? (overrides as Record<string, unknown>).sd_model_checkpoint
				: undefined;
		const seed = whole(body.seed, "seed", -1, -1, 2 ** 32 - 1);
		const count =
			whole(body.batch_size, "batch_size", 1, 1, MAX_COUNT) *
			whole(body.n_iter, "n_iter", 1, 1, MAX_COUNT);
		if (count > MAX_COUNT) {
			throw new ValidationError(
				`batch_size times n_iter must be at most ${MAX_COUNT}`,
			);
		}
		const size = (value: unknown, name: string) =>
			whole(value, name, 512, 64, 16_384);
		return {
			// Hatchlight has no negative prompt: it is left out.
			prompt: promptOf(body.prompt, false),
			model: text(checkpoint, "sd_model_checkpoint"),
			count,
			width: size(body.width, "width"),
			height: size(body.height, "height"),
			// -1 is a new seed each time; it is told back.
			seed: seed >= 0 ? seed : Math.floor(Math.random() * 2 ** 32),
		};
	};

	app.post("/sdapi/v1/txt2img", limit(MAX_ASK_BYTES), async (c) => {
		const body = await json(c);
		const ask = a1111Ask(body);
		return answerA1111(
			c,
			await make(c, { ...ask, pictures: [] }),
			body,
			ask.seed,
		);
	});

	app.post("/sdapi/v1/img2img", limit(MAX_PICTURES_BYTES), async (c) => {
		const body = await json(c);
		const given = body.init_images;
		if (!Array.isArray(given) || given.length === 0) {
			throw new ValidationError("init_images must be a list of pictures");
		}
		if (given.length > MAX_PICTURES) {
			throw new ValidationError(`Give at most ${MAX_PICTURES} pictures`);
		}
		if (given.some(tooLargeText) || tooLargeText(body.mask)) return tooLarge();
		const strength = body.denoising_strength;
		if (
			strength != null &&
			(typeof strength !== "number" || !(strength >= 0 && strength <= 1))
		) {
			throw new ValidationError("denoising_strength must be from 0 to 1");
		}
		const ask = a1111Ask(body);
		const mask =
			body.mask == null || body.mask === ""
				? undefined
				: body.inpainting_mask_invert === 1 ||
						body.inpainting_mask_invert === true
					? await hatchlightMask(decoded(body.mask, "mask"), "black")
					: // White is redrawn, as in Hatchlight.
						decoded(body.mask, "mask");
		const made = await make(c, {
			...ask,
			pictures: given.map((g, i) => decoded(g, `init_images[${i}]`)),
			...(mask && { mask }),
			...(typeof strength === "number" && {
				strength: Math.max(0.05, strength),
			}),
		});
		return answerA1111(c, made, body, ask.seed);
	});

	app.get("/sdapi/v1/sd-models", async (c) =>
		c.json(
			(await usable(c, user(c))).map(({ model }) => ({
				title: model.id,
				model_name: model.name,
				hash: null,
				sha256: null,
				filename: model.id,
				config: null,
			})),
		),
	);

	/** The model this API uses when an app names none. */
	const currentModel = async (c: Context) =>
		(await choose(c, user(c), undefined, 0, false).catch(() => null))?.id ?? "";

	app.get("/sdapi/v1/options", async (c) =>
		c.json({
			sd_model_checkpoint: await currentModel(c),
			sd_checkpoint_hash: null,
			sd_vae: "Automatic",
			samples_format: "png",
			CLIP_stop_at_last_layers: 1,
		}),
	);
	app.post("/sdapi/v1/options", limit(MAX_ASK_BYTES), async (c) => {
		const body = await json(c);
		// The model is the one option Hatchlight keeps; others are ignored.
		const checkpoint = text(body.sd_model_checkpoint, "sd_model_checkpoint");
		if (checkpoint !== undefined) {
			if (!options.settings) throw new ValidationError("No settings here");
			const ctx = user(c);
			const entry = await find(c, ctx, await entries(ctx), checkpoint);
			if (!entry) {
				throw new ValidationError(
					`Unknown model: ${checkpoint}`,
					"unknownModel",
					{ model: checkpoint },
				);
			}
			// Kept for requests that name no model, which never spend.
			if (entry.provider.requiresKey) {
				throw new ValidationError(
					"A paid model cannot be the default: name it in each request, in override_settings.sd_model_checkpoint",
				);
			}
			await options.settings.set(ctx, { otherAppsModel: entry.model.id });
		}
		return c.json(null);
	});

	// Asked by clients before they start; Hatchlight chooses these itself.
	app.get("/sdapi/v1/samplers", (c) =>
		c.json([
			{ name: "Euler a", aliases: ["k_euler_a"], options: {} },
			{ name: "Euler", aliases: ["k_euler"], options: {} },
		]),
	);
	app.get("/sdapi/v1/schedulers", (c) =>
		c.json([{ name: "automatic", label: "Automatic", aliases: null }]),
	);
	app.get("/sdapi/v1/upscalers", (c) => c.json([]));
	app.get("/sdapi/v1/sd-vae", (c) => c.json([]));
	app.get("/sdapi/v1/loras", async (c) =>
		c.json(
			(await models.loras.list()).map((lora) => ({
				name: lora.id,
				alias: lora.name,
				path: `${lora.id}.safetensors`,
				metadata: {},
			})),
		),
	);
	app.get("/sdapi/v1/progress", (c) => {
		const jobs = working.get(callerOf(user(c)))?.jobs.size ?? 0;
		return c.json({
			progress: 0,
			eta_relative: 0,
			state: {
				skipped: false,
				interrupted: false,
				job: "",
				job_count: jobs,
				job_timestamp: "0",
				job_no: 0,
				sampling_step: 0,
				sampling_steps: 0,
			},
			current_image: null,
			textinfo: null,
		});
	});
	app.post("/sdapi/v1/interrupt", async (c) => {
		const ctx = user(c);
		const jobs = working.get(callerOf(ctx))?.jobs ?? new Set<string>();
		await Promise.all(
			[...jobs].map((id) => service.cancelJob(ctx, id).catch(() => {})),
		);
		return c.json({});
	});

	app.all("/sdapi/*", () => failure(404, "Not found"));
}

/** The route a request reached, as the access maps name it. */
function routeOf(c: Context): { method: string; path: string } | null {
	const route = matchedRoutes(c).find(
		(r) =>
			r.method !== "ALL" &&
			(r.path.startsWith("/v1/") || r.path.startsWith("/sdapi/")),
	);
	const method = c.req.method === "HEAD" ? "GET" : c.req.method;
	return route ? { method, path: route.path } : null;
}

/** Lets in a token that may call the route, as /mcp does. */
function signIn(
	accounts: AccountService,
	options: ImageApiOptions,
): MiddlewareHandler {
	return async (c, next) => {
		const route = routeOf(c);
		// Nothing answers here: the catch-all says so.
		if (!route) return next();
		const address = options.address(c);
		const wait = options.failures.wait(address);
		if (wait > 0) {
			throw new AccessError(
				"Too many wrong tokens. Try again later",
				"tooManyAttempts",
				429,
				{ seconds: Math.ceil(wait / 1000) },
			);
		}
		const token = c.req
			.header("authorization")
			?.match(/^Bearer\s+(\S+)$/i)?.[1];
		const seen = token ? accounts.resolveApiToken(token) : null;
		if (!seen?.apiToken) {
			// Only a token sent counts against the address: guessing is what
			// slows down, not a client yet to be given one.
			if (token) options.failures.fail(address);
			c.header("www-authenticate", 'Bearer realm="hatchlight"');
			throw new AccessError(
				"An API token is needed: Authorization: Bearer <token>. Make one in Hatchlight's settings",
				"signInRequired",
				401,
			);
		}
		if (seen.user.mustChangePassword) {
			throw new AccessError(
				"Choose a new password before going on",
				"passwordChangeRequired",
				403,
			);
		}
		const scope = routeScope(route.method, route.path);
		if (!scope || !seen.apiToken.scopes.includes(scope)) {
			throw new AccessError(
				scope
					? `This API token needs the ${scope} scope`
					: "API tokens cannot do this",
				"tokenScope",
				403,
				{ scope: scope ?? "" },
			);
		}
		if (!allows(routeAccess(route.method, route.path), seen.user)) {
			throw new AccessError("Your account cannot do this", "forbidden", 403);
		}
		c.set("viewer", {
			user: seen.user,
			sessionId: null,
			apiToken: seen.apiToken,
		});
		await next();
	};
}
