import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join, resolve } from "node:path";
import {
	AccountService,
	appEnv,
	assistantChoice,
	type Captioner,
	type ChatMessage,
	type ChatModel,
	type ChatReply,
	FakeProvider,
	FileKeyStore,
	FileSettingsStore,
	FsAssetStore,
	type Hardware,
	improvePrompt,
	JobEngine,
	type LanguageModel,
	LOCAL_USER,
	type LocalEngineSpec,
	LocalEyes,
	type LocalModelSpec,
	LocalModelStore,
	LocalProvider,
	LocalTranslator,
	legacyName,
	mayUsePaid,
	newId,
	type PaidRefusal,
	type ProviderAdapter,
	ProviderRegistry,
	paidError,
	promptStyle,
	ReelService,
	SERVER_KEYS,
	type SettingsStore,
	SharedKeyStore,
	SqliteRepository,
	Trainer,
	type TrainerOptions,
	type Translator,
	type UserContext,
	ValidationError,
	writerChoice,
} from "@hatchlight/core";
import {
	builtinEngines,
	builtinLocalModels,
	builtinProviders,
	CloudChatModel,
	CloudTranslator,
	type CloudTranslatorId,
} from "@hatchlight/providers";
import { Assistant, type Reel } from "@hatchlight/tools";

export interface Runtime {
	service: ReelService;
	/** The people of a server; unused on a personal install. */
	accounts: AccountService;
	/** Why a person may not spend on paid models now; servers only. */
	paidRefusal?: (userId: string) => PaidRefusal | null;
	engine: JobEngine;
	models: LocalModelStore;
	/** Trains LoRAs on this computer. */
	trainer: Trainer;
	/** Captions training pictures, with the model that looks at pictures. */
	captioner?: Captioner;
	settings: SettingsStore;
	/** Makes and changes pictures by talking with the person. */
	assistant: Assistant;
	/** What the person's assistant thinks with now, or null. */
	assistantBrain(ctx: UserContext): Promise<AssistantBrain>;
	/** Whether the prompt translator on this computer is installed. */
	translatorReady(): boolean;
	/** A richer prompt for a short idea, written for the models named. */
	improvePrompt(
		ctx: UserContext,
		request: ImproveRequest,
		signal: AbortSignal,
	): Promise<string>;
	/** Starts moving the local models to another folder. */
	moveModels(path: string): Promise<void>;
	/** Resumes jobs left unfinished by a previous process. */
	start(): Promise<void>;
	close(): void;
}

export interface ImproveRequest {
	prompt: string;
	/** The models the prompt is for; unknown ones are left out. */
	modelIds: string[];
	/** The person is changing a picture they gave. */
	editing: boolean;
	/** The language the person reads, e.g. "pt-BR", to write the prompt in. */
	language?: string;
}

export type AssistantBrain = "local" | CloudTranslatorId | null;

/** Hatchlight as a person sees it, for the assistant in this process. */
export function localReel(service: ReelService, ctx: UserContext): Reel {
	return {
		models: async () => service.listModels(),
		providers: () => service.listProviders(ctx),
		session: (id) => service.getSession(ctx, id),
		createTurn: (input) => service.createTurn(ctx, input),
		upload: (data) => service.uploadAsset(ctx, data),
		gallery: ({ query, limit }) =>
			service.listGallery(ctx, { query, limit: limit ?? 20 }),
		async asset(id) {
			const { asset, blob } = await service.getAssetFile(ctx, id);
			return {
				data: new Uint8Array(await blob.arrayBuffer()),
				mime: asset.mime,
			};
		},
		sessionUrl: (id) => `#/s/${encodeURIComponent(id)}`,
	};
}

/**
 * Stands in for the assistant's language model when trying the app without
 * keys: makes what it is asked on the first fake model, then says so.
 */
class FakeChatModel implements ChatModel {
	readonly vision = false;
	async chat(
		_instructions: string,
		messages: ChatMessage[],
	): Promise<ChatReply> {
		await Bun.sleep(600);
		const last = messages.at(-1);
		if (last?.role === "user") {
			const text = last.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join(" ");
			return {
				text: "",
				toolCalls: [
					{
						id: `call_${messages.length}`,
						name: "generate",
						arguments: { prompt: text, models: ["fake/alpha"] },
					},
				],
			};
		}
		return { text: "Done: here it is. (A fake assistant.)", toolCalls: [] };
	}
}

/**
 * What one call to a cloud language model counts as against a monthly
 * limit: more than a translation or a prompt costs, and about what a long
 * assistant step costs on the larger models.
 */
export const LANGUAGE_CALL_USD = 0.01;

/** Another Hatchlight process is already using the data directory. */
export class DataDirInUseError extends Error {}

/**
 * Two processes on one data directory would each run the other's jobs, so the
 * directory is claimed with a lock file saying which process owns it.
 */
function lockDataDir(dataDir: string): () => void {
	const name = "hatchlight.lock";
	const path = resolve(dataDir, name);
	const replaced = takeLock(path, JSON.stringify(lockOwner()));
	// A version from before the rename locks the directory under the old
	// name, and only looks there: both are held, so neither starts beside
	// the other. That file keeps the bare process id older versions read.
	const legacy = resolve(dataDir, legacyName(name));
	try {
		takeLock(legacy, String(process.pid), replaced);
	} catch (error) {
		releaseLock(path);
		throw error;
	}
	return () => {
		releaseLock(legacy);
		releaseLock(path);
	};
}

/** Who holds a lock: older versions wrote only the process id. */
interface LockOwner {
	pid: number;
	/** The machine's name: containers get a new one when recreated. */
	host?: string;
	/** Changes each time the machine starts; Linux only. */
	bootId?: string;
	startedAt?: string;
}

/** Lock files this process holds, which its own id cannot tell apart. */
const heldLocks = new Set<string>();

function lockOwner(): LockOwner {
	return {
		pid: process.pid,
		host: osHostname(),
		bootId: bootId(),
		startedAt: new Date().toISOString(),
	};
}

function bootId(): string | undefined {
	try {
		return (
			readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ||
			undefined
		);
	} catch {
		return undefined;
	}
}

function readOwner(text: string): LockOwner {
	try {
		const owner = JSON.parse(text) as Partial<LockOwner> | null;
		if (typeof owner?.pid === "number") {
			return {
				pid: owner.pid,
				host: typeof owner.host === "string" ? owner.host : undefined,
				bootId: typeof owner.bootId === "string" ? owner.bootId : undefined,
			};
		}
	} catch {
		// A bare process id, from before.
	}
	return { pid: Number(text) };
}

/**
 * Whether the owner of a lock is gone. In a container a process gets the
 * same id every time it starts, so a lock left by a crash would otherwise
 * look alive for ever; this process's own locks are in `heldLocks`.
 */
function isStale(owner: LockOwner, replaced: LockOwner | null): boolean {
	if (owner.pid === process.pid) return true;
	// The same machine, started again since.
	const boot = bootId();
	if (
		owner.host === osHostname() &&
		owner.bootId &&
		boot &&
		owner.bootId !== boot
	) {
		return true;
	}
	// The old-style twin of a lock already found stale.
	if (replaced && owner.host === undefined && owner.pid === replaced.pid) {
		return true;
	}
	return !isRunning(owner.pid);
}

/**
 * Creates the lock file at `path`, unless a live process holds it. Returns
 * the owner of a stale lock it replaced.
 */
function takeLock(
	path: string,
	content: string,
	replaced: LockOwner | null = null,
): LockOwner | null {
	if (heldLocks.has(path)) {
		throw new DataDirInUseError(
			`Hatchlight is already running on this data directory (process ${process.pid})`,
		);
	}
	let stale: LockOwner | null = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, content, { flag: "wx" });
			heldLocks.add(path);
			return stale;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = readOwner(readFileSync(path, "utf8"));
			if (!isStale(owner, replaced)) {
				const where =
					owner.host && owner.host !== osHostname() ? ` on ${owner.host}` : "";
				throw new DataDirInUseError(
					`Hatchlight is already running on this data directory (process ${owner.pid}${where})`,
				);
			}
			stale = owner;
			rmSync(path, { force: true }); // left behind by a process that died
		}
	}
	throw new DataDirInUseError("Could not lock the data directory");
}

function releaseLock(path: string): void {
	heldLocks.delete(path);
	rmSync(path, { force: true });
}

function isRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface RuntimeOptions {
	dataDir: string;
	/** Where models and engines go. Defaults to `models` in the data directory. */
	modelsDir?: string;
	/**
	 * Where another models folder, chosen in the app, is written down.
	 * Without it the folder cannot be changed from the app.
	 */
	modelsLocationFile?: string;
	/** Defaults to the built-in providers. */
	providers?: ProviderAdapter[];
	/** Models that can be downloaded. Defaults to the built-in catalog. */
	localModels?: LocalModelSpec[];
	/** Engines that run them. Defaults to the built-in ones. */
	engines?: LocalEngineSpec[];
	/** Defaults to looking at this machine. */
	hardware?: () => Promise<Hardware>;
	/** Used to download models and their demos. */
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Database migrations. Defaults to the ones in the source tree. */
	migrationsDir?: string;
	/** What the assistant thinks with, in place of the person's choice. */
	assistantModel?: ChatModel;
	/** Tries a freshly installed engine. Defaults to running it. */
	checkEngine?: (executable: string) => Promise<string | null>;
	/** Where the LoRA trainer is installed. Defaults to `trainer` in the data directory. */
	trainerDir?: string;
	/**
	 * Several people share this server: keys become the server's, and only
	 * those allowed may spend them.
	 */
	server?: boolean;
	/** Stand-ins for the trainer's downloads and programs, in tests. */
	trainerOptions?: Partial<
		Pick<TrainerOptions, "fetch" | "run" | "freeMemory">
	>;
}

/**
 * The gallery's database in a data directory: the one under the old name
 * while only that one is there, so pictures made before the rename stay.
 */
export function databaseFile(dataDir: string): string {
	const name = "hatchlight.sqlite";
	const current = join(dataDir, name);
	const legacy = join(dataDir, legacyName(name));
	return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** Wires the core on a data directory. Call `start()` once ready to run jobs. */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
	const providers = options.providers ?? builtinProviders();
	const fake = appEnv(process.env, "FAKE") === "1";
	if (fake) {
		const fakeProvider = new FakeProvider();
		fakeProvider.delayMs = 1500;
		providers.push(fakeProvider);
	}
	const catalog = options.localModels ?? builtinLocalModels();
	const models = new LocalModelStore({
		root: options.modelsDir ?? join(options.dataDir, "models"),
		catalog,
		engines: options.engines ?? builtinEngines(),
		fetch: options.fetch,
		hardware: options.hardware,
		checkEngine: options.checkEngine,
		locationFile: options.modelsLocationFile,
		// Engines a Docker image comes with, used instead of downloading them.
		enginesDir: appEnv(process.env, "ENGINES_DIR"),
	});
	const trainer = new Trainer({
		dir: options.trainerDir ?? join(options.dataDir, "trainer"),
		gpu: models.gpu,
		loras: models.loras,
		// LoRAs are trained on SDXL, the model installed from the catalog.
		baseModel: async () => {
			const runtime = await models.runtime("sdxl-base").catch(() => null);
			const file = runtime?.files.model;
			if (!runtime || !file) {
				throw new ValidationError(
					"Install Stable Diffusion XL in Models first: LoRAs are trained on it",
					"trainingNeedsBase",
				);
			}
			return { file, scratch: runtime.scratch };
		},
		// Declared below; only called once a training has the GPU.
		letGo: async () => {
			await local.unloadIdle();
			await translator.stopAndWait();
		},
		...options.trainerOptions,
	});
	// Installed local models are offered next to the remote ones.
	const local = new LocalProvider({ store: models, catalog });
	await local.load();
	const registry = new ProviderRegistry();
	for (const provider of [...providers, local]) registry.register(provider);
	local.onChange = () => registry.refresh(local.id);

	// Generated images and keys are private to the owner.
	await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
	const unlock = lockDataDir(options.dataDir);
	const repo = new SqliteRepository(
		databaseFile(options.dataDir),
		options.migrationsDir,
	);
	const assets = new FsAssetStore(join(options.dataDir, "assets"));
	const fileKeys = new FileKeyStore(join(options.dataDir, "auth.json"));
	const settings = new FileSettingsStore(
		join(options.dataDir, "settings.json"),
	);
	const accounts = new AccountService(repo.accounts(), {
		// What the install had becomes the first owner's; its keys, the server's.
		adoptLocal: async (ownerId) => {
			await settings.moveUser(LOCAL_USER.userId, ownerId);
			await assets.moveUser(LOCAL_USER.userId, ownerId);
			await fileKeys.moveUser(LOCAL_USER.userId, SERVER_KEYS.userId);
		},
	});
	// A setup cut short by a crash is finished now.
	if (options.server) await accounts.resumeAdoption();
	// On a server, spending is for those allowed, up to their monthly limit.
	const paidRefusal = (userId: string): PaidRefusal | null => {
		const user = accounts.getUser(userId);
		if (!user || user.disabledAt != null || !mayUsePaid(user)) {
			return "paidNotAllowed";
		}
		return user.monthlyLimitUsd != null &&
			accounts.spentThisMonth(userId) >= user.monthlyLimitUsd
			? "monthlyLimitReached"
			: null;
	};
	const refusePaid = options.server ? paidRefusal : undefined;
	const mayPay = (userId: string) => !refusePaid?.(userId);
	const keys = options.server ? new SharedKeyStore(fileKeys, mayPay) : fileKeys;
	// Puts prompts into English for the models that read only English, once
	// its model is installed.
	const translatorModel = catalog.find((m) =>
		m.tasks.includes("prompt-translation"),
	);
	const translator = new LocalTranslator({
		store: models,
		model: translatorModel?.id ?? "",
	});
	let translatorReady = translatorModel ? await translator.ready() : false;
	// Checks overlap (an install says it changed several times); only the
	// latest one counts.
	let check = 0;
	models.subscribe((event) => {
		if (event.type !== "models.changed") return;
		const mine = ++check;
		void translator.ready().then((ready) => {
			if (mine !== check) return;
			translatorReady = ready;
			if (!ready) translator.stop();
		});
	});
	// Models kept loaded let go of their files before files are deleted or
	// moved: Windows does neither to an open file.
	models.onLetGo(() => local.unloadIdle());
	models.onLetGo(() => translator.stopAndWait());
	// One per service and key, so the jobs of a turn share a translation.
	const clouds = new Map<string, CloudTranslator>();
	const keyFor = async (ctx: UserContext, service: CloudTranslatorId) => {
		const adapter = registry.adapter(service);
		// A key from the environment is the server's too.
		if (!mayPay(ctx.userId)) return undefined;
		return (
			(await keys.get(ctx, service)) ??
			(adapter?.keyEnv ? process.env[adapter.keyEnv] : undefined)
		);
	};
	/**
	 * On a server, a call to a language service with the server's key is
	 * checked against the person's limit first, and counted after. The
	 * services do not all report usage, so each call counts as a
	 * conservative estimate of what one costs.
	 */
	const metered = async <T>(userId: string, call: () => Promise<T>) => {
		if (!refusePaid) return call();
		const refusal = refusePaid(userId);
		if (refusal) throw paidError(refusal);
		const result = await call();
		await repo.addSpending({
			id: newId("spd"),
			userId,
			kind: "language",
			jobId: null,
			costUsd: LANGUAGE_CALL_USD,
			createdAt: Date.now(),
		});
		return result;
	};
	const cloudFor = async (
		ctx: UserContext,
		service: CloudTranslatorId,
	): Promise<(Translator & LanguageModel) | null> => {
		const key = await keyFor(ctx, service);
		if (!key) return null;
		const id = `${service}:${key}`;
		let cloud = clouds.get(id);
		if (!cloud) {
			cloud = new CloudTranslator(service, key, options.fetch);
			clouds.set(id, cloud);
		}
		const model = cloud;
		return {
			toEnglish: (prompt, signal) =>
				metered(ctx.userId, () => model.toEnglish(prompt, signal)),
			reply: (instructions, text, signal, replyOptions) =>
				metered(ctx.userId, () =>
					model.reply(instructions, text, signal, replyOptions),
				),
		};
	};
	const translatorFor = async (userId: string) => {
		const ctx = { userId };
		const { translateWith } = await settings.get(ctx);
		if (translateWith === "off") return null;
		if (translateWith === "local") return translatorReady ? translator : null;
		return cloudFor(ctx, translateWith);
	};
	const writerFor = async (ctx: UserContext): Promise<LanguageModel | null> => {
		const reachable = await reachableServices(ctx);
		const choice = writerChoice(
			await settings.get(ctx),
			translatorReady,
			(service) => reachable.has(service),
		);
		if (choice === "local") return translator;
		return choice ? cloudFor(ctx, choice) : null;
	};
	const services = ["openai", "google", "openrouter"] as const;
	const reachableServices = async (ctx: UserContext) => {
		const reachable = new Set<CloudTranslatorId>();
		for (const service of services) {
			if (await keyFor(ctx, service)) reachable.add(service);
		}
		return reachable;
	};
	const brainChoice = async (ctx: UserContext): Promise<AssistantBrain> => {
		const reachable = await reachableServices(ctx);
		return assistantChoice(await settings.get(ctx), translatorReady, (s) =>
			reachable.has(s),
		);
	};
	// One per service and key: each keeps the model name that answered.
	const brains = new Map<string, CloudChatModel>();
	const brainFor = async (ctx: UserContext): Promise<ChatModel | null> => {
		const choice = await brainChoice(ctx);
		if (choice === "local") return translator;
		if (!choice) return null;
		const key = await keyFor(ctx, choice);
		if (!key) return null;
		const id = `${choice}:${key}`;
		let brain = brains.get(id);
		if (!brain) {
			brain = new CloudChatModel(choice, key, options.fetch);
			brains.set(id, brain);
		}
		const model = brain;
		return {
			vision: model.vision,
			chat: (instructions, messages, tools, signal) =>
				metered(ctx.userId, () =>
					model.chat(instructions, messages, tools, signal),
				),
		};
	};
	const engine = new JobEngine({
		repo,
		assets,
		registry,
		keys,
		paidRefusal: refusePaid,
		translator: translatorFor,
	});
	const service = new ReelService({ repo, assets, registry, keys, engine });
	// Looks at pictures for an assistant whose brain cannot, once installed.
	const eyesModel = catalog.find((m) =>
		m.tasks.includes("picture-description"),
	);
	const eyes = eyesModel
		? new LocalEyes({ store: models, model: eyesModel.id })
		: null;
	const assistant = new Assistant({
		store: {
			add: (ctx, entry) => repo.addEntry(entry, ctx.userId),
			update: (ctx, id, body) => repo.updateEntry(ctx, id, body),
			list: (ctx, sessionId) => repo.listEntries(ctx, sessionId),
		},
		reel: (ctx) => localReel(service, ctx),
		eyes: async () => (eyes && (await eyes.ready()) ? eyes : null),
		brain: async (ctx) =>
			options.assistantModel ??
			(await brainFor(ctx)) ??
			(fake ? new FakeChatModel() : null),
		startSession: (ctx, title) => service.startSession(ctx, title),
	});
	return {
		service,
		accounts,
		paidRefusal: refusePaid,
		engine,
		models,
		trainer,
		captioner: eyes ?? undefined,
		settings,
		assistant,
		// A model standing in (tests, trying the app) shows as this computer's.
		assistantBrain: async (ctx) =>
			(await brainChoice(ctx)) ??
			(options.assistantModel || fake ? "local" : null),
		translatorReady: () => translatorReady,
		improvePrompt: async (ctx, request, signal) => {
			const writer = await writerFor(ctx);
			if (!writer) {
				throw new ValidationError(
					"No language model to write with: install the one for this computer or add a key",
					"noLanguageModel",
				);
			}
			const byId = new Map(service.listModels().map((m) => [m.id, m]));
			const models = request.modelIds.flatMap((id) => byId.get(id) ?? []);
			return improvePrompt(
				writer,
				request.prompt,
				promptStyle(models, request.editing, request.language),
				signal,
			);
		},
		moveModels: (path) => models.relocate(path),
		start: () => engine.start(),
		close: () => {
			// Downloads stop with the process; what they fetched is resumed later.
			trainer.cancelTraining();
			trainer.cancelInstall();
			void models.close();
			local.close();
			translator.stop();
			repo.close();
			unlock();
		},
	};
}
