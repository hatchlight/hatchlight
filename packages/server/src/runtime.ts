import {
	existsSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { hostname as osHostname, uptime as osUptime } from "node:os";
import { join, resolve } from "node:path";
import {
	AccountService,
	appEnv,
	appHomes,
	assistantChoice,
	type Captioner,
	ChatJudge,
	type ChatMessage,
	type ChatModel,
	type ChatReply,
	type CompareOptions,
	chooseLocalModel,
	DEFAULT_PAID_ESTIMATE_USD,
	FakeProvider,
	FileKeyStore,
	FileSettingsStore,
	type FoundKey,
	FsAssetStore,
	type Hardware,
	improvePrompt,
	installPlaces,
	JobEngine,
	type Judge,
	type KeySource,
	keysSecret,
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
	NotFoundError,
	newId,
	type PaidRefusal,
	type PasswordHasher,
	type ProviderAdapter,
	ProviderRegistry,
	paidError,
	promptStyle,
	ReelService,
	SERVER_KEYS,
	type SettingsStore,
	SharedKeyStore,
	SqliteRepository,
	type SqliteVisitors,
	Trainer,
	type TrainerOptions,
	type Translator,
	tryFileLock,
	type UnreadableKeys,
	type UserContext,
	ValidationError,
	verdictOf,
	writerChoice,
} from "@hatchlight/core";
import type {
	ConsistencyCheck,
	ConsistencyResult,
} from "@hatchlight/core/types";
import {
	builtinEngines,
	builtinLocalModels,
	builtinProviders,
	CloudChatModel,
	CloudTranslator,
	type CloudTranslatorId,
} from "@hatchlight/providers";
import { Assistant, type Reel, shrinkPicture } from "@hatchlight/tools";
import { deviceKey } from "./devices";

export interface Runtime {
	service: ReelService;
	/** The people of a server; unused on a personal install. */
	accounts: AccountService;
	/** Signs device cookies; servers only. */
	deviceKey?: Uint8Array;
	/**
	 * Whether keys the person relied on were set aside at start, because the
	 * secret could not open them: theirs, or for an owner the server's. Until
	 * they say they saw it.
	 */
	keysLost(user: { userId: string; owner: boolean }): boolean;
	/** The person saw that their keys were lost. */
	dismissKeysLost(userId: string): void;
	/**
	 * Why a person, and the API token they ask with, may not spend on paid
	 * models now; servers only.
	 */
	paidRefusal?: (who: UserContext, source: KeySource) => PaidRefusal | null;
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
	/**
	 * The models on this computer that translate, write and think for a
	 * person, and that look at pictures for them, now: the ones they chose
	 * while installed, else the first installed. Null where none is.
	 */
	languageModels(
		ctx: UserContext,
	): Promise<{ writer: string | null; eyes: string | null }>;
	/** A richer prompt for a short idea, written for the models named. */
	improvePrompt(
		ctx: UserContext,
		request: ImproveRequest,
		signal: AbortSignal,
	): Promise<string>;
	/**
	 * Whether a picture shows the same character as pictures of it, by a
	 * model that sees: the one on this computer, else the person's cloud one.
	 */
	checkConsistency(
		ctx: UserContext,
		check: ConsistencyCheck,
		signal: AbortSignal,
	): Promise<ConsistencyResult>;
	/** Starts moving the local models to another folder. */
	moveModels(path: string): Promise<void>;
	/** The anonymous visitors of a public demo. */
	visitors: SqliteVisitors;
	/**
	 * Deletes visitors' sessions and pictures from before `before`, and
	 * forgets visitors not seen since: a public demo keeps nothing for long.
	 */
	sweepVisitors(before: number): Promise<VisitorSweep>;
	/** Resumes jobs left unfinished by a previous process. */
	start(): Promise<void>;
	close(): void;
}

/** What one sweep of a demo deleted. */
export interface VisitorSweep {
	sessions: number;
	assets: number;
	visitors: number;
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
export function localReel(
	service: ReelService,
	ctx: UserContext,
	settings?: SettingsStore,
	checkConsistency?: Runtime["checkConsistency"],
): Reel {
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
		ranking: (query) => service.ranking(ctx, query),
		library: async () => service.listLibrary(ctx),
		...(settings && { settings: () => settings.get(ctx) }),
		...(checkConsistency && {
			checkConsistency: (check, signal) =>
				checkConsistency(ctx, check, signal ?? new AbortController().signal),
		}),
	};
}

/**
 * Stands in for the assistant's language model when trying the app without
 * keys: asks once which fake model and shape, then makes what it was asked
 * with the answer, and says so.
 */
export class FakeChatModel implements ChatModel {
	readonly vision = false;
	delayMs = 600;
	async chat(
		_instructions: string,
		messages: ChatMessage[],
	): Promise<ChatReply> {
		await Bun.sleep(this.delayMs);
		const last = messages.at(-1);
		if (last?.role !== "user") return this.afterTool(messages);
		const said = (message: ChatMessage | undefined) =>
			message?.role === "user"
				? message.content
						.map((part) => (part.type === "text" ? part.text : ""))
						.join(" ")
				: "";
		// Asked once since the last picture: the person's message answers it.
		const lastMade = messages.findLastIndex(
			(m) => m.role === "tool" && m.name === "generate",
		);
		const asked = messages.findLastIndex(
			(m) => m.role === "tool" && m.name === "ask_user",
		);
		if (asked <= lastMade) {
			return {
				text: "",
				toolCalls: [
					{
						id: `call_${messages.length}`,
						name: "ask_user",
						arguments: {
							question: "Which model, and what shape? (A fake assistant.)",
							options: [
								"Fake alpha, square",
								"Fake alpha, wide",
								"Fake beta, wide",
							],
						},
					},
				],
			};
		}
		// Named in the answer, so the model is the person's choice.
		const answer = said(last).toLowerCase();
		const model = answer.includes("beta") ? "fake/beta" : "fake/alpha";
		const ratio = answer.includes("wide") ? "16:9" : "1:1";
		const idea = messages.slice(0, asked).findLast((m) => m.role === "user");
		return {
			text: "",
			toolCalls: [
				{
					id: `call_${messages.length}`,
					name: "generate",
					arguments: {
						prompt: said(idea) || said(last),
						models: [model],
						aspect_ratio: ratio,
					},
				},
			],
		};
	}

	/** After a tool: a character check once there are two pictures, else done. */
	private afterTool(messages: ChatMessage[]): ChatReply {
		const last = messages.at(-1);
		// Once a session has an earlier picture, the new one is checked
		// against the first, to show the character check.
		const ids = messages.flatMap((m) =>
			m.role === "tool" && m.name === "generate"
				? m.content.flatMap((p) =>
						p.type === "text" ? (p.text.match(/ast_[A-Za-z0-9]+/g) ?? []) : [],
					)
				: [],
		);
		const first = ids[0];
		const newest = ids.at(-1);
		if (
			last?.role === "tool" &&
			last.name === "generate" &&
			first &&
			newest &&
			first !== newest
		) {
			return {
				text: "",
				toolCalls: [
					{
						id: `call_${messages.length}`,
						name: "check_consistency",
						arguments: { image: newest, like: [first] },
					},
				],
			};
		}
		const checked =
			last?.role === "tool" && last.name === "check_consistency"
				? ` ${last.content.map((p) => (p.type === "text" ? p.text : "")).join(" ")}`
				: "";
		return {
			text: `Done: here it is.${checked} (A fake assistant.)`,
			toolCalls: [],
		};
	}
}

/**
 * Stands in for the model that compares characters when trying the app:
 * a score that depends on the pictures, and the same differences each time.
 */
class FakeJudge implements Judge {
	async compare(
		references: { data: string }[],
		candidate: { data: string },
	): Promise<ConsistencyResult> {
		await Bun.sleep(800);
		const hash = new Bun.CryptoHasher("sha256")
			.update(references.map((r) => r.data).join() + candidate.data)
			.digest();
		const score = 50 + ((hash[0] ?? 0) % 50);
		return {
			score,
			differences:
				score >= 85
					? []
					: ["coat is blue, should be green", "hair is shorter"].slice(
							0,
							score >= 70 ? 1 : 2,
						),
			verdict: verdictOf(score),
		};
	}
}

/**
 * What one call to a cloud language model counts as against a monthly
 * limit: more than a translation or a prompt costs, and about what a long
 * assistant step costs on the larger models.
 */
export const LANGUAGE_CALL_USD = DEFAULT_PAID_ESTIMATE_USD;

/** The side pictures are made as small as to compare a character. */
const COMPARED_SIDE = 640;

/** Another Hatchlight process is already using the data directory. */
export class DataDirInUseError extends Error {}

/**
 * Two processes on one data directory would each run the other's jobs, so the
 * directory is claimed with a lock file the owner rewrites every few seconds:
 * one not rewritten for 30 seconds, on the folder's own clock, belongs to a
 * process that died. Process ids say nothing in containers, where every
 * server is process 1, nor across machines sharing a volume.
 */
export function lockDataDir(
	dataDir: string,
	options: {
		staleMs?: number;
		heartbeatMs?: number;
		/** Whether every process that could use this folder shows here. */
		seesEveryProcess?: boolean;
	} = {},
): () => void {
	const { seesEveryProcess = seesAllProcesses(), ...timing } = options;
	const name = "hatchlight.lock";
	const path = resolve(dataDir, name);
	if (heldLocks.has(path)) {
		throw new DataDirInUseError(
			`Hatchlight is already running on this data directory (process ${process.pid})`,
		);
	}
	// A lock from a version without the heartbeat is judged as it would be.
	const previous = readLock(path);
	let replaced: LockOwner | null = null;
	if (previous && !previous.heartbeat) {
		const verdict = oldLockVerdict(path, previous, null, seesEveryProcess);
		if (!verdict.stale) throw verdict.error;
		rmSync(path, { force: true });
		replaced = previous;
	}
	const release = tryFileLock(path, {
		owner: JSON.stringify({
			...lockOwner(),
			heartbeat: true,
			token: crypto.randomUUID(),
		}),
		...timing,
	});
	if (!release) {
		const owner = readLock(path);
		throw inUse(owner ?? { pid: Number.NaN });
	}
	heldLocks.add(path);
	// The old twin of a heartbeat lock that went stale is stale too.
	replaced ??= previous;
	// A version from before the rename locks the directory under the old
	// name, and only looks there: both are held, so neither starts beside
	// the other. That file keeps the bare process id older versions read.
	const legacy = resolve(dataDir, legacyName(name));
	try {
		takeLock(legacy, String(process.pid), replaced, seesEveryProcess);
	} catch (error) {
		heldLocks.delete(path);
		release();
		throw error;
	}
	return () => {
		releaseLock(legacy);
		heldLocks.delete(path);
		release();
	};
}

function readLock(path: string): (LockOwner & { heartbeat?: boolean }) | null {
	try {
		const text = readFileSync(path, "utf8");
		const owner = readOwner(text);
		try {
			const parsed = JSON.parse(text) as { heartbeat?: unknown };
			return { ...owner, heartbeat: parsed?.heartbeat === true };
		} catch {
			return owner;
		}
	} catch {
		return null;
	}
}

function inUse(owner: LockOwner): DataDirInUseError {
	const where =
		owner.host && owner.host !== osHostname() ? ` on ${owner.host}` : "";
	const who = Number.isFinite(owner.pid)
		? ` (process ${owner.pid}${where})`
		: "";
	return new DataDirInUseError(
		`Hatchlight is already running on this data directory${who}. If it stopped, start again in 30 seconds`,
	);
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
/**
 * Whether a lock in the old format (no heartbeat) belongs to a process that
 * is gone; when it cannot be told, the error says what to do.
 */
function oldLockVerdict(
	path: string,
	owner: LockOwner,
	replaced: LockOwner | null,
	seesEveryProcess: boolean,
): { stale: true } | { stale: false; error: DataDirInUseError } {
	// The old-style twin of a lock already found stale.
	if (replaced && owner.host === undefined && owner.pid === replaced.pid) {
		return { stale: true };
	}
	if (owner.host !== undefined) {
		if (owner.host !== osHostname()) {
			return {
				stale: false,
				error: new DataDirInUseError(
					`Another Hatchlight (process ${owner.pid} on ${owner.host}) holds this data directory. Stop that container or server; if it is gone, delete ${path}`,
				),
			};
		}
		// This machine: its process ids mean something here.
		const boot = bootId();
		if (
			owner.pid === process.pid ||
			(owner.bootId && boot && owner.bootId !== boot) ||
			!isRunning(owner.pid)
		) {
			return { stale: true };
		}
		return { stale: false, error: inUse(owner) };
	}
	// A bare process id was written by a version from before the Docker
	// image, a desktop app or the command line on the computer itself. Where
	// this process sees that computer's processes, one gone from here is
	// gone. A container or WSL does not see the host's, nor the host theirs
	// through a shared folder; and this process's own id may be another
	// container's process 1.
	if (writtenBeforeBoot(path)) return { stale: true };
	if (seesEveryProcess && owner.pid !== process.pid && !isRunning(owner.pid)) {
		return { stale: true };
	}
	return {
		stale: false,
		error: new DataDirInUseError(
			`An older Hatchlight (process ${owner.pid}) holds this data directory. If no other Hatchlight uses it, delete ${path}`,
		),
	};
}

/**
 * Whether this process sees the processes of the computer it runs on: not
 * inside a container, nor in WSL, whose folders Windows programs share. On
 * Windows and macOS it does. Two cases are accepted as too rare: an older
 * server in WSL started by hand on a Windows folder, which Windows cannot
 * see, and an older app on another computer sharing a network folder.
 */
function seesAllProcesses(): boolean {
	if (process.platform !== "linux") return true;
	// Docker, Podman, Flatpak, and runtimes that say so in the environment.
	if (
		["/.dockerenv", "/run/.containerenv", "/.flatpak-info"].some((path) =>
			existsSync(path),
		) ||
		process.env.container ||
		process.env.KUBERNETES_SERVICE_HOST
	) {
		return false;
	}
	try {
		if (/microsoft/i.test(readFileSync("/proc/version", "utf8"))) return false;
		// A machine's first process is its init; a container's is its program
		// (Kubernetes, containerd, LXC say nothing else). Anything unknown
		// counts as a container, which keeps the old answer.
		const first = readFileSync("/proc/1/comm", "utf8").trim();
		return first === "systemd" || first === "init";
	} catch {
		return false;
	}
}

function writtenBeforeBoot(path: string): boolean {
	try {
		return statSync(path).mtimeMs < Date.now() - osUptime() * 1000;
	} catch {
		return false;
	}
}

/**
 * Creates the lock file at `path`, unless a live process holds it. Returns
 * the owner of a stale lock it replaced.
 */
function takeLock(
	path: string,
	content: string,
	replaced: LockOwner | null,
	seesEveryProcess: boolean,
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
			const verdict = oldLockVerdict(path, owner, replaced, seesEveryProcess);
			if (!verdict.stale) throw verdict.error;
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
	/**
	 * Where other apps are often installed, to suggest their models folders.
	 * Defaults to the usual places on this computer.
	 */
	modelFolderPlaces?: () => Promise<string[]>;
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
	/** What compares characters, in place of the installed or cloud model. */
	judge?: Judge;
	/** Tries a freshly installed engine. Defaults to running it. */
	checkEngine?: (executable: string) => Promise<string | null>;
	/** Where the LoRA trainer is installed. Defaults to `trainer` in the data directory. */
	trainerDir?: string;
	/**
	 * Several people share this server: keys become the server's, and only
	 * those allowed may spend them.
	 */
	server?: boolean;
	/** The most a member's pictures and videos may take on a server; unset, no limit. */
	assetQuotaBytes?: number | null;
	/**
	 * A public demo: only models that need no key are offered, whatever
	 * keys the environment holds.
	 */
	demo?: boolean;
	/** How passwords are hashed; argon2id with its default cost unless a test says. */
	passwordHasher?: PasswordHasher;
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

/**
 * Makes the data directory, or makes one that exists, readable by its owner
 * only: it holds password hashes, two-step secrets, keys and everyone's
 * pictures, and a folder shared with the host (a bind mount, a NAS share)
 * would otherwise let any user or container there read them.
 */
export async function privateDataDir(
	dataDir: string,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	// Windows keeps who may read a folder elsewhere than in these bits.
	if (platform !== "win32") await chmod(dataDir, 0o700);
}

/**
 * Creates the database file readable by its owner only, or makes it so.
 * SQLite gives its -wal and -shm files the database's permissions; those
 * left by an older version are made private too.
 */
export async function privateDatabase(
	file: string,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	await (await open(file, "a", 0o600)).close();
	if (platform === "win32") return;
	for (const path of [file, `${file}-wal`, `${file}-shm`]) {
		await chmod(path, 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

/** Wires the core on a data directory. Call `start()` once ready to run jobs. */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
	const fake = appEnv(process.env, "FAKE") === "1";
	const offered = [...(options.providers ?? builtinProviders())];
	if (fake) {
		const fakeProvider = new FakeProvider();
		fakeProvider.delayMs = 1500;
		// One that needs a key (any will do), to try paid models, their
		// permissions and limits without paying.
		const fakePaid = new FakeProvider("fake-paid", ["gamma"]);
		fakePaid.requiresKey = true;
		fakePaid.delayMs = 1500;
		offered.push(fakeProvider, fakePaid);
	}
	// A demo spends nobody's money: cloud models are not even registered.
	const providers = options.demo
		? offered.filter((provider) => !provider.requiresKey)
		: offered;
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
		// Other apps' folders are this machine's, whoever signs in.
		modelFolders: {
			file: join(options.dataDir, "model-folders.json"),
			places:
				options.modelFolderPlaces ??
				(async () => {
					const { homes, drives } = await appHomes();
					return installPlaces(homes, drives, join);
				}),
		},
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
			await Promise.all([...translators.values()].map((t) => t.stopAndWait()));
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
	await privateDataDir(options.dataDir);
	const unlock = lockDataDir(options.dataDir);
	await privateDatabase(databaseFile(options.dataDir));
	const repo = new SqliteRepository(
		databaseFile(options.dataDir),
		options.migrationsDir,
	);
	const accountsRepo = repo.accounts();
	const visitors = repo.visitors();
	// Each new file is counted as it is written, for storage quotas.
	const assets = new FsAssetStore(
		join(options.dataDir, "assets"),
		(userId, bytes) => accountsRepo.addAssetBytes(userId, bytes),
	);
	// Keys are encrypted at rest; those saved before are encrypted now.
	// Keys the secret cannot open are set aside, never lost, and the app
	// starts without them.
	let unreadableKeys: UnreadableKeys | null = null;
	const fileKeys = await (async () => {
		try {
			const store = new FileKeyStore(
				join(options.dataDir, "auth.json"),
				keysSecret(options.dataDir),
			);
			unreadableKeys = await store.prepare();
			return store;
		} catch (error) {
			repo.close();
			unlock();
			throw error;
		}
	})();
	if (unreadableKeys) {
		console.warn(
			`The saved API keys could not be read with this secret, so Hatchlight starts without them. They are kept in ${(unreadableKeys as UnreadableKeys).file}: to use them again, stop Hatchlight, put back the secret they were saved with (HATCHLIGHT_SECRET_FILE, or secret.key in the data directory) and move that file back to auth.json. Otherwise, enter the keys again.`,
		);
	}
	/** People told their keys were lost, who need not be told again. */
	const toldOfKeys = new Set<string>();
	const settings = new FileSettingsStore(
		join(options.dataDir, "settings.json"),
	);
	const accounts = new AccountService(accountsRepo, {
		hasher: options.passwordHasher,
		assetQuotaBytes: options.server ? options.assetQuotaBytes : null,
		// What the install had becomes the first owner's; its keys, the server's.
		adoptLocal: async (ownerId) => {
			await settings.moveUser(LOCAL_USER.userId, ownerId);
			await assets.moveUser(LOCAL_USER.userId, ownerId);
			await fileKeys.moveUser(LOCAL_USER.userId, SERVER_KEYS.userId);
		},
	});
	// A setup cut short by a crash is finished now.
	if (options.server) await accounts.resumeAdoption();
	// On a server, spending is for those allowed; on the server's keys, up
	// to their monthly limit. Their own keys are their own money.
	const paidRefusal = (
		{ userId, tokenId }: UserContext,
		source: KeySource,
	): PaidRefusal | null => {
		const user = accounts.getUser(userId);
		if (!user || user.disabledAt != null || !mayUsePaid(user)) {
			return "paidNotAllowed";
		}
		// Asked with an API token: it must be allowed paid models, still
		// valid (a revoked one's jobs spend no more), and within its limit,
		// whoever's key pays.
		if (tokenId) {
			const token = accounts.liveToken(tokenId);
			if (!token || token.userId !== userId || !token.scopes.includes("paid")) {
				return "tokenNotPaid";
			}
			if (
				token.spendLimitUsd != null &&
				accounts.spentByToken(tokenId) >= token.spendLimitUsd
			) {
				return "tokenLimitReached";
			}
		}
		return source === "server" &&
			user.monthlyLimitUsd != null &&
			accounts.spentThisMonth(userId) >= user.monthlyLimitUsd
			? "monthlyLimitReached"
			: null;
	};
	const refusePaid = options.server ? paidRefusal : undefined;
	const allowedToPay = (userId: string) =>
		refusePaid?.({ userId }, "personal") !== "paidNotAllowed";
	const keys = options.server
		? new SharedKeyStore(fileKeys, allowedToPay)
		: fileKeys;
	// Put prompts into English for the models that read only English, write
	// prompts and think for the assistant: one of these, as the person
	// chose, once installed. Each keeps its own server while used.
	const writerIds = catalog
		.filter((m) => m.tasks.includes("prompt-translation"))
		.map((m) => m.id);
	const translators = new Map(
		writerIds.map((id) => [
			id,
			new LocalTranslator({ store: models, model: id }),
		]),
	);
	// Look at pictures for an assistant whose brain cannot, and caption
	// training pictures: run once per picture, so nothing stays loaded.
	const eyesIds = catalog
		.filter((m) => m.tasks.includes("picture-description"))
		.map((m) => m.id);
	const allEyes = new Map(
		eyesIds.map((id) => [id, new LocalEyes({ store: models, model: id })]),
	);
	/** The models installed with their engine, as of the last change. */
	const installedNow = async () => {
		const view = await models.list().catch(() => null);
		return new Set(view?.models.filter((m) => m.ready).map((m) => m.id));
	};
	let ready = await installedNow();
	// Checks overlap (an install says it changed several times); only the
	// latest one counts.
	let check = 0;
	models.subscribe((event) => {
		if (event.type !== "models.changed") return;
		const mine = ++check;
		void installedNow().then((now) => {
			if (mine !== check) return;
			ready = now;
			for (const [id, translator] of translators) {
				if (!ready.has(id)) translator.stop();
			}
		});
	});
	/** The models on this computer that write and see for a person now. */
	const languageModels = async (ctx: UserContext) => {
		const { writerModel, eyesModel } = await settings.get(ctx);
		const installed = (id: string) => ready.has(id);
		return {
			writer: chooseLocalModel(writerIds, writerModel, installed),
			eyes: chooseLocalModel(eyesIds, eyesModel, installed),
		};
	};
	/** The writer that served last: one model in memory at a time. */
	let lastWriter: LocalTranslator | null = null;
	/** The person's writer on this computer, or null when none is installed. */
	const localWriter = async (ctx: UserContext) => {
		const { writer } = await languageModels(ctx);
		const translator = writer ? (translators.get(writer) ?? null) : null;
		// Another one chosen: the one before lets go of its memory.
		if (translator && lastWriter && lastWriter !== translator) {
			lastWriter.stop();
		}
		if (translator) lastWriter = translator;
		return translator;
	};
	/** The person's eyes on this computer, or null when none is installed. */
	const localEyes = async (ctx: UserContext) => {
		const { eyes } = await languageModels(ctx);
		return eyes ? (allEyes.get(eyes) ?? null) : null;
	};
	// Models kept loaded let go of their files before files are deleted or
	// moved: Windows does neither to an open file.
	models.onLetGo(() => local.unloadIdle());
	models.onLetGo(async () => {
		await Promise.all([...translators.values()].map((t) => t.stopAndWait()));
	});
	// One per service and key, so the jobs of a turn share a translation.
	const clouds = new Map<string, CloudTranslator>();
	/**
	 * The key a person's calls to a language service use, and whose it is:
	 * their own, or the server's (one from the environment is the server's
	 * too) while their monthly limit allows.
	 */
	const keyFor = async (
		ctx: UserContext,
		service: CloudTranslatorId,
	): Promise<FoundKey | undefined> => {
		const adapter = registry.adapter(service);
		const envKey = adapter?.keyEnv ? process.env[adapter.keyEnv] : undefined;
		const found: FoundKey | undefined =
			(await keys.find(ctx, service)) ??
			(envKey ? { key: envKey, source: "server" } : undefined);
		if (!found || refusePaid?.(ctx, found.source)) return undefined;
		return found;
	};
	/**
	 * On a server, a call to a language service is checked against what the
	 * person may spend first, and counted after. The services do not all
	 * report usage, so each call counts as a conservative estimate of what
	 * one costs.
	 */
	const metered = async <T>(
		who: UserContext,
		source: KeySource,
		call: () => Promise<T>,
	) => {
		if (!refusePaid) return call();
		const refusal = refusePaid(who, source);
		if (refusal) throw paidError(refusal);
		// Held before the call, so calls made together see each other.
		const id = newId("spd");
		await repo.addSpending({
			id,
			userId: who.userId,
			tokenId: who.tokenId ?? null,
			kind: "language",
			keySource: source,
			jobId: null,
			costUsd: LANGUAGE_CALL_USD,
			pending: true,
			createdAt: Date.now(),
		});
		try {
			const result = await call();
			await repo.settleSpending(id, LANGUAGE_CALL_USD);
			return result;
		} catch (error) {
			await repo.releaseSpending(id);
			throw error;
		}
	};
	const cloudFor = async (
		ctx: UserContext,
		service: CloudTranslatorId,
	): Promise<(Translator & LanguageModel) | null> => {
		const found = await keyFor(ctx, service);
		if (!found) return null;
		const id = `${service}:${found.key}`;
		let cloud = clouds.get(id);
		if (!cloud) {
			cloud = new CloudTranslator(service, found.key, options.fetch);
			clouds.set(id, cloud);
		}
		const model = cloud;
		return {
			toEnglish: (prompt, signal) =>
				metered(ctx, found.source, () => model.toEnglish(prompt, signal)),
			reply: (instructions, text, signal, replyOptions) =>
				metered(ctx, found.source, () =>
					model.reply(instructions, text, signal, replyOptions),
				),
		};
	};
	const translatorFor = async (ctx: UserContext) => {
		const { translateWith } = await settings.get(ctx);
		if (translateWith === "off") return null;
		if (translateWith === "local") return localWriter(ctx);
		return cloudFor(ctx, translateWith);
	};
	const writerFor = async (ctx: UserContext): Promise<LanguageModel | null> => {
		const reachable = await reachableServices(ctx);
		const local = await localWriter(ctx);
		const choice = writerChoice(
			await settings.get(ctx),
			local != null,
			(service) => reachable.has(service),
		);
		if (choice === "local") return local;
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
		const { writer } = await languageModels(ctx);
		return assistantChoice(await settings.get(ctx), writer != null, (s) =>
			reachable.has(s),
		);
	};
	// One per service and key: each keeps the model name that answered.
	const brains = new Map<string, CloudChatModel>();
	const brainFor = async (ctx: UserContext): Promise<ChatModel | null> => {
		const choice = await brainChoice(ctx);
		if (choice === "local") return localWriter(ctx);
		if (!choice) return null;
		const found = await keyFor(ctx, choice);
		if (!found) return null;
		const id = `${choice}:${found.key}`;
		let brain = brains.get(id);
		if (!brain) {
			brain = new CloudChatModel(choice, found.key, options.fetch);
			brains.set(id, brain);
		}
		const model = brain;
		return {
			vision: model.vision,
			chat: (instructions, messages, tools, signal) =>
				metered(ctx, found.source, () =>
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
	const service = new ReelService({
		repo,
		assets,
		registry,
		keys,
		engine,
		library: repo.library(),
		loras: () => models.loras.list(),
		// On a server, a member whose room is full adds no new pictures.
		storageRefusal: options.server
			? (userId) => accounts.storageRefusal(userId)
			: undefined,
	});
	/**
	 * What compares characters: the model on this computer that sees, for
	 * free; else the person's cloud brain, which sees too.
	 */
	const judgeFor = async (ctx: UserContext): Promise<Judge | null> => {
		if (options.judge) return options.judge;
		// The person's chosen eyes, else another one installed.
		const eyes = await localEyes(ctx);
		if (eyes) return eyes;
		const brain = await brainFor(ctx);
		if (brain?.vision) return new ChatJudge(brain);
		return fake ? new FakeJudge() : null;
	};
	const checkConsistency = async (
		ctx: UserContext,
		check: ConsistencyCheck,
		signal: AbortSignal,
	): Promise<ConsistencyResult> => {
		// Small JPEG copies: enough to tell a character, and llama.cpp reads no WebP.
		const seen = async (id: string) => {
			const { asset, blob } = await service.getAssetFile(ctx, id);
			if (!asset.mime.startsWith("image/")) {
				throw new ValidationError(
					"Only pictures can be compared",
					"referenceNotImage",
				);
			}
			const small = await shrinkPicture(
				new Uint8Array(await blob.arrayBuffer()),
				COMPARED_SIDE,
			);
			if (!small) {
				throw new ValidationError(
					`The picture ${id} cannot be read`,
					"referenceUnreadable",
				);
			}
			return small.image;
		};
		const references = [];
		for (const id of check.referenceAssetIds) references.push(await seen(id));
		const candidate = await seen(check.assetId);
		// Chosen once the pictures are known to be the person's.
		const judge = await judgeFor(ctx);
		if (!judge) {
			throw new ValidationError(
				"No model can compare pictures: install one that looks at pictures in Settings, under Language models on this computer, or add a key for the assistant",
				"noJudge",
			);
		}
		const compareOptions: CompareOptions = {
			...(check.traits && { traits: check.traits }),
			...(check.language && { language: check.language }),
		};
		return judge.compare(references, candidate, signal, compareOptions);
	};
	// Captions training pictures with the eyes the person chose.
	const captioner: Captioner = {
		ready: async (ctx = LOCAL_USER) => (await localEyes(ctx)) != null,
		caption: async (picture, signal, ctx = LOCAL_USER) => {
			const eyes = await localEyes(ctx);
			if (!eyes)
				throw new Error("No model that looks at pictures is installed");
			return eyes.caption(picture, signal);
		},
	};
	const assistant = new Assistant({
		store: {
			add: (ctx, entry) => repo.addEntry(entry, ctx.userId),
			update: (ctx, id, body) => repo.updateEntry(ctx, id, body),
			list: (ctx, sessionId) => repo.listEntries(ctx, sessionId),
		},
		reel: (ctx) => localReel(service, ctx, settings, checkConsistency),
		eyes: localEyes,
		brain: async (ctx) =>
			options.assistantModel ??
			(await brainFor(ctx)) ??
			(fake ? new FakeChatModel() : null),
		startSession: (ctx, title) => service.startSession(ctx, title),
	});
	return {
		service,
		accounts,
		deviceKey: options.server
			? deviceKey(join(options.dataDir, "device.key"))
			: undefined,
		paidRefusal: refusePaid,
		keysLost: ({ userId, owner }) => {
			const lost = unreadableKeys as UnreadableKeys | null;
			if (!lost || toldOfKeys.has(userId)) return false;
			return (
				lost.owners.includes(userId) ||
				(owner && lost.owners.includes(SERVER_KEYS.userId))
			);
		},
		dismissKeysLost: (userId) => {
			toldOfKeys.add(userId);
		},
		engine,
		models,
		trainer,
		captioner: eyesIds.length > 0 ? captioner : undefined,
		settings,
		assistant,
		// A model standing in (tests, trying the app) shows as this computer's.
		assistantBrain: async (ctx) =>
			(await brainChoice(ctx)) ??
			(options.assistantModel || fake ? "local" : null),
		translatorReady: () => writerIds.some((id) => ready.has(id)),
		languageModels,
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
		checkConsistency,
		moveModels: (path) => models.relocate(path),
		visitors,
		sweepVisitors: async (before) => {
			const gone = (error: unknown) => {
				// Deleted meanwhile, as by its visitor: nothing left to do. A
				// picture a library keeps is left for next time.
				if (
					!(error instanceof NotFoundError) &&
					!(
						error instanceof ValidationError &&
						error.code === "pictureInLibrary"
					)
				) {
					throw error;
				}
			};
			const sessions = visitors.staleSessions(before);
			for (const { id, userId } of sessions) {
				assistant.forget({ userId }, id);
				await service.deleteSession({ userId }, id).catch(gone);
			}
			const stale = visitors.staleAssets(before);
			for (const { id, userId } of stale) {
				await service.deleteAsset({ userId }, id).catch(gone);
			}
			const forgotten = visitors.forgetIdle(before);
			// The folders of visitors with nothing left, so none pile up.
			const owners = new Set([
				...forgotten,
				...stale.map((asset) => asset.userId),
			]);
			for (const userId of owners) {
				if (
					!/^vis_[\w-]+$/.test(userId) ||
					visitors.known(userId) ||
					visitors.hasAssets(userId)
				) {
					continue;
				}
				await rm(join(options.dataDir, "assets", userId), {
					recursive: true,
					force: true,
				});
			}
			return {
				sessions: sessions.length,
				assets: stale.length,
				visitors: forgotten.length,
			};
		},
		start: async () => {
			// What changed in other apps' folders while Hatchlight was closed.
			void models.folders.rescan().catch((error) => {
				console.error("Could not look in the linked model folders", error);
			});
			await engine.start();
		},
		close: () => {
			// The assistant's work stops before the database it writes to closes.
			assistant.close();
			// Downloads stop with the process; what they fetched is resumed later.
			trainer.cancelTraining();
			trainer.cancelInstall();
			void models.close();
			local.close();
			for (const translator of translators.values()) translator.stop();
			repo.close();
			unlock();
		},
	};
}
