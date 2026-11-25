import {
	chmod,
	mkdir,
	open,
	readdir,
	rename,
	rm,
	stat,
	statfs,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	CodedError,
	describeError,
	NotFoundError,
	ValidationError,
} from "../errors";
import type { HubChoice, HubTarget } from "../hugging-face";
import { sniffMime } from "../mime";
import { pathHere, portablePath } from "../paths";
import type {
	CheckpointInfo,
	EngineBuild,
	Fit,
	Hardware,
	LocalEngineSpec,
	LocalEngineStatus,
	LocalModelEvent,
	LocalModelFile,
	LocalModelSpec,
	LocalModelState,
	LocalModelStatus,
	LocalModelsView,
	LocalModelVariant,
	LoraInfo,
} from "../types";
import { CheckpointShelf } from "./checkpoints";
import { type BuildChoice, chooseBuild, chooseVariant, fitOf } from "./engines";
import { isLocked, tryFileLock, withFileLock } from "./file-lock";
import { GpuLock } from "./gpu";
import { detectHardware, type GpuMemory, readGpuMemory } from "./hardware";
import {
	HUB_REVISION,
	hubFetch,
	hubFileUrl,
	inspectHubFile,
	resolveHub,
} from "./hub";
import { LinkedFolders } from "./linked";
import { LoraShelf } from "./loras";
import { cleanUp, type Mirror, mirrorInto, treeSize, undo } from "./move";
import { extractTarGz } from "./tar";
import { extractZip } from "./zip";

/** What moves with the models folder; the rest only matters for a moment. */
const MOVED_ENTRIES = [
	"blobs",
	"installed",
	"engines",
	"demos",
	"loras",
	"checkpoints",
	"broken-engines.json",
];

/** Whether two paths name one folder (Windows ignores case). */
function samePath(a: string, b: string): boolean {
	const norm = (path: string) => {
		const plain = resolve(path);
		return process.platform === "win32" || plain.startsWith("/mnt/")
			? plain.toLowerCase()
			: plain;
	};
	return norm(a) === norm(b);
}

/**
 * Whether `path` is below the folder `outer` (as `stat` saw it), going up
 * its parents on disk: as text, one folder has many names.
 */
async function inside(
	path: string,
	outer: { dev: bigint; ino: bigint },
): Promise<boolean> {
	// Up to the root of the disk, which counts too.
	for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) {
		const info = await stat(dir, { bigint: true }).catch(() => null);
		if (info && info.dev === outer.dev && info.ino === outer.ino) return true;
		if (dir === dirname(dir)) return false;
	}
}

function movingError(): ValidationError {
	return new ValidationError(
		"Models are moving to another folder; try again once they are there",
		"modelsMoving",
	);
}

const MAX_DEMO_BYTES = 64 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const ID = /^[a-z0-9][a-z0-9.-]*$/;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type LocalModelListener = (event: LocalModelEvent) => void;

export interface LocalModelStoreOptions {
	/** Directory models and engines are kept in. */
	root: string;
	catalog: LocalModelSpec[];
	engines: LocalEngineSpec[];
	fetch?: Fetch;
	/** Defaults to looking at this machine. */
	hardware?: () => Promise<Hardware>;
	/** Reads the GPU's free memory; defaults to asking the driver. */
	gpuMemory?: () => Promise<GpuMemory | null>;
	/**
	 * Tries an engine's program right after it is installed. Resolves with why
	 * it does not run, or null when it does. Defaults to running it with
	 * `--help`, which catches missing libraries and blocked programs.
	 */
	checkEngine?: (executable: string) => Promise<string | null>;
	/**
	 * Where a folder chosen by hand is written down (see
	 * `modelsLocationFile`). Without it the folder cannot be changed, as when
	 * it was set from outside.
	 */
	locationFile?: string;
	/**
	 * A folder of engine builds already extracted, as
	 * `<build>/<executable>`, such as the ones a Docker image comes with
	 * (HATCHLIGHT_ENGINES_DIR). A build there counts as installed and runs
	 * from there: it is never downloaded, and nothing is written to or
	 * removed from the folder.
	 */
	enginesDir?: string;
	/** Folders of other apps whose models are used where they are. */
	modelFolders?: {
		/** Where the folders, and what was read in them, are kept. */
		file?: string;
		/** Where other apps are often installed, for suggestions. */
		places?: () => Promise<string[]>;
	};
}

/** An engine build that was installed but does not run on this machine. */
class EngineCheckFailed extends Error {}

const CHECK_TIMEOUT_MS = 30_000;

async function runsWithHelp(executable: string): Promise<string | null> {
	try {
		const child = Bun.spawn([executable, "--help"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const timer = setTimeout(() => child.kill(), CHECK_TIMEOUT_MS);
		const [code, errors] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		clearTimeout(timer);
		if (code === 0) return null;
		const reason = errors.trim().split(/\r?\n/).at(-1);
		return reason || `it stopped with code ${code}`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** What it takes to run an installed model. */
export interface LocalRuntime {
	model: LocalModelSpec;
	variant: LocalModelVariant;
	build: EngineBuild;
	/** Absolute path of the engine's program. */
	executable: string;
	/** Run from WSL as a Windows program. */
	throughWindows: boolean;
	/** How it runs here: `offload` keeps part of the model in system memory. */
	fit: Fit;
	/** Memory of the GPU it runs on, in bytes; absent on the CPU. */
	gpuMemoryBytes?: number;
	/** Absolute paths of the variant's files, by role (or name, without one). */
	files: Record<string, string>;
	/** A folder on the same disk for the engine's output. */
	scratch: string;
}

interface Install {
	state: Exclude<LocalModelState, "available" | "installed">;
	controller: AbortController;
	variant: LocalModelVariant;
	/** Bytes of the file being downloaded that are on disk so far. */
	current: { sha256: string; bytes: number } | null;
	startedAt: number;
	/** Bytes received by this install, for the download speed. */
	transferred: number;
	lastProgress: number;
}

/** Sizes in the decimal units disks and download pages use. */
export function formatBytes(bytes: number): string {
	// Under a kilobyte, "0 kB" would say there is nothing.
	if (bytes < 1e3) return `${bytes} B`;
	if (bytes < 1e6) return `${Math.round(bytes / 1e3)} kB`;
	if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
	return `${(bytes / 1e9).toFixed(bytes < 1e10 ? 2 : 1)} GB`;
}

function assertFiles(files: LocalModelFile[], owner: string): void {
	if (files.length === 0) throw new Error(`${owner} has no files`);
	if (new Set(files.map((f) => f.name)).size !== files.length) {
		throw new Error(`Repeated file name in ${owner}`);
	}
	for (const file of files) {
		if (!file.url.startsWith("https://")) {
			throw new Error(`Not an HTTPS URL: ${file.url}`);
		}
		if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
			throw new Error(`Invalid hash for ${file.name} of ${owner}`);
		}
		if (!Number.isInteger(file.size) || file.size <= 0) {
			throw new Error(`Invalid size for ${file.name} of ${owner}`);
		}
	}
}

function assertCatalog(
	catalog: LocalModelSpec[],
	engines: LocalEngineSpec[],
): void {
	const sizes = new Map<string, number>();
	const sized = (files: LocalModelFile[], owner: string) => {
		for (const file of files) {
			if ((sizes.get(file.sha256) ?? file.size) !== file.size) {
				throw new Error(`One hash, two sizes: ${file.name} of ${owner}`);
			}
			sizes.set(file.sha256, file.size);
		}
	};
	const builds = new Set<string>();
	for (const engine of engines) {
		for (const build of engine.builds) {
			if (!ID.test(build.id) || builds.has(build.id)) {
				throw new Error(`Invalid or repeated engine build id: ${build.id}`);
			}
			builds.add(build.id);
			if (build.engine !== engine.id) {
				throw new Error(`Build ${build.id} belongs to another engine`);
			}
			const parts = build.executable.split(/[\\/]/);
			if (build.executable.startsWith("/") || parts.includes("..")) {
				throw new Error(`Unsafe executable path in build ${build.id}`);
			}
			assertFiles(build.files, `build ${build.id}`);
			sized(build.files, `build ${build.id}`);
		}
	}
	const ids = new Set<string>();
	for (const model of catalog) {
		if (!ID.test(model.id) || ids.has(model.id)) {
			throw new Error(`Invalid or repeated local model id: ${model.id}`);
		}
		ids.add(model.id);
		if (model.variants.length === 0) {
			throw new Error(`Local model without variants: ${model.id}`);
		}
		const variantIds = new Set<string>();
		for (const variant of model.variants) {
			const owner = `${model.id} (${variant.id})`;
			if (!ID.test(variant.id) || variantIds.has(variant.id)) {
				throw new Error(`Invalid or repeated variant id: ${owner}`);
			}
			variantIds.add(variant.id);
			if (!engines.some((engine) => engine.id === variant.engine)) {
				throw new Error(`Unknown engine ${variant.engine} for ${owner}`);
			}
			assertFiles(variant.files, owner);
			sized(variant.files, owner);
		}
		for (const demo of model.demos) {
			if (!demo.url.startsWith("https://")) {
				throw new Error(`Not an HTTPS URL: ${demo.url}`);
			}
		}
	}
}

/** The sizes a demo picture is served at, besides the one its authors made. */
export type DemoSize = "original" | "card" | "large";

/** Longest side, in pixels: a card is ~400 CSS pixels wide on a 2x screen. */
const DEMO_SIDES: Record<Exclude<DemoSize, "original">, number> = {
	card: 960,
	large: 2560,
};

export const isDemoSize = (value: string): value is DemoSize =>
	value === "original" || Object.hasOwn(DEMO_SIDES, value);

/** Writes a smaller WebP copy of a demo picture; false if it cannot. */
async function shrinkDemo(
	from: string,
	to: string,
	side: number,
): Promise<boolean> {
	const data = await new Bun.Image(Bun.file(from))
		.resize(side, side, { fit: "inside", withoutEnlargement: true })
		.webp({ quality: 82 })
		.bytes();
	const tmp = `${to}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(tmp, data);
		await rename(tmp, to);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
	return true;
}

const sizeOf = (path: string) =>
	stat(path).then(
		(info) => info.size,
		() => 0,
	);

/** What a folder takes, counting every file below it. */
async function folderSize(path: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(path, { withFileTypes: true }).catch(
		() => [],
	)) {
		const child = join(path, entry.name);
		total += entry.isDirectory()
			? await folderSize(child)
			: await sizeOf(child);
	}
	return total;
}

const unique = (files: LocalModelFile[]) => [
	...new Map(files.map((file) => [file.sha256, file])).values(),
];
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/**
 * Downloads, keeps and deletes the models that run on this machine, and the
 * engines that run them. Each model comes in variants (precisions, engines);
 * the one installed is the best this machine's hardware runs well, unless
 * another is asked for.
 *
 * Files are stored once under their hash, so models that share a file (a text
 * encoder, a VAE) share its space on disk:
 *
 *   <root>/blobs/<sha256>        a complete, verified file
 *   <root>/blobs/<sha256>.part   a download in progress, kept to resume it
 *   <root>/installed/<id>        marks a model as installed, naming its variant
 *   <root>/engines/<build>/      an extracted engine build
 *   <root>/demos/<sha256(url)>   a downloaded demo
 *   <root>/demos/<sha256(url)>.<size>.webp   a demo picture made smaller
 */
/** The part of the GPU's memory local models may plan on using together. */
const GPU_SHARE = 0.9;
/** How long a reading of the GPU's free memory is reused. */
const MEMORY_CACHE_MS = 3_000;

export class LocalModelStore {
	private root: string;
	private catalog: LocalModelSpec[];
	private engines: LocalEngineSpec[];
	private fetch: Fetch;
	private detect: () => Promise<Hardware>;
	private gpuMemory: () => Promise<GpuMemory | null>;
	private memoryRead: { at: number; memory: Promise<GpuMemory | null> } | null =
		null;
	private hardware: Promise<Hardware> | null = null;
	private checkEngine: (executable: string) => Promise<string | null>;
	/** Builds that were installed here and did not run. */
	private broken = new Set<string>();
	/** Builds that came with the system and did not run, never saved. */
	private providedBroken = new Set<string>();
	/** The models ready when the store last looked, to notice outside changes. */
	private lastReady: string | null = null;
	private listeners = new Set<LocalModelListener>();
	private installs = new Map<string, Install>();
	private errors = new Map<string, ReturnType<typeof describeError>>();
	private demos = new Map<string, Promise<unknown>>();
	/** Demo pictures, at a size, that could not be made smaller. */
	private unshrinkable = new Set<string>();
	/** One download at a time: they all compete for the same connection. */
	private queue: Promise<void> = Promise.resolve();
	/** Shares the GPU's memory between jobs, with other Hatchlights too. */
	readonly gpu: GpuLock;
	/** LoRAs, kept in the models folder so they move with it. */
	readonly loras: LoraShelf;
	/** Whole models added by hand, kept and moved like the LoRAs. */
	readonly checkpoints: CheckpointShelf;
	/** Other apps' folders, whose models the two shelves show too. */
	readonly folders: LinkedFolders;
	private locationFile: string | null;
	/** Builds that came with the system, read-only. */
	private enginesDir: string | null;
	private moving: LocalModelsView["disk"]["moving"] = null;
	private moveTask: Promise<void> = Promise.resolve();
	/** A move is being checked, before it starts. */
	private relocating = false;
	/** What keeps model files open (a model kept loaded), to let go of them. */
	private holders = new Set<() => Promise<void>>();
	/** Why the last move to another folder failed, until the next one. */
	private moveError: LocalModelsView["disk"]["moveError"] = null;
	/** Files being downloaded from Hugging Face, as "repo/file". */
	private hubDownloads = new Set<string>();

	constructor(options: LocalModelStoreOptions) {
		assertCatalog(options.catalog, options.engines);
		this.root = options.root;
		this.locationFile = options.locationFile ?? null;
		this.enginesDir = options.enginesDir ? resolve(options.enginesDir) : null;
		this.catalog = options.catalog;
		this.engines = options.engines;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.detect = options.hardware ?? (() => detectHardware());
		// Given hardware stands for a machine that is not this one.
		this.gpuMemory =
			options.gpuMemory ??
			(options.hardware ? async () => null : () => readGpuMemory());
		this.checkEngine = options.checkEngine ?? runsWithHelp;
		this.folders = new LinkedFolders({
			...options.modelFolders,
			root: () => this.root,
			ownIds: {
				lora: () => this.loras.ownIds(),
				checkpoint: () => this.checkpoints.ownIds(),
			},
			changed: (kind) =>
				this.emit({
					type: kind === "lora" ? "loras.changed" : "models.changed",
				}),
		});
		this.loras = new LoraShelf({
			root: () => this.root,
			check: () => this.notMoving(),
			changed: () => this.emit({ type: "loras.changed" }),
			linked: this.folders.loras,
		});
		this.checkpoints = new CheckpointShelf({
			root: () => this.root,
			check: () => this.notMoving(),
			// A checkpoint is a model: the composer and Models offer it.
			changed: () => this.emit({ type: "models.changed" }),
			release: () => this.letGo(),
			linked: this.folders.checkpoints,
		});
		this.gpu = new GpuLock({
			root: this.root,
			capacity: async () => {
				const { gpus } = await this.machine();
				// The desktop and other programs keep some of it for themselves.
				return gpus.length > 0
					? Math.max(...gpus.map((gpu) => gpu.memoryBytes)) * GPU_SHARE
					: null;
			},
		});
	}

	subscribe(listener: LocalModelListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: LocalModelEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				console.error("A local model listener failed", error);
			}
		}
	}

	/** Looked at once: the hardware does not change while the app runs. */
	private machine(): Promise<Hardware> {
		// What was learned about engines that do not run here comes with it.
		this.hardware ??= Promise.all([
			this.detect(),
			this.loadBroken(),
			this.checkProvided(),
		]).then(([hardware]) => hardware);
		return this.hardware;
	}

	/**
	 * The free memory of the first NVIDIA card, read at most once every few
	 * seconds and never twice at once: each read starts nvidia-smi.
	 */
	private freeMemory(): Promise<GpuMemory | null> {
		const now = Date.now();
		if (!this.memoryRead || now - this.memoryRead.at > MEMORY_CACHE_MS) {
			this.memoryRead = {
				at: now,
				memory: this.gpuMemory().catch(() => null),
			};
		}
		return this.memoryRead.memory;
	}

	/**
	 * What `list` says, with the first NVIDIA card's free memory. Kept apart
	 * from `list`, which install progress and every assistant turn call.
	 */
	async listWithMemory(): Promise<LocalModelsView> {
		const view = await this.list();
		const first = view.hardware.gpus[0];
		if (first?.vendor !== "nvidia") return view;
		const memory = await this.freeMemory();
		if (!memory) return view;
		return {
			...view,
			hardware: {
				...view.hardware,
				gpus: [
					{ ...first, freeBytes: memory.freeBytes },
					...view.hardware.gpus.slice(1),
				],
			},
		};
	}

	/**
	 * Tries the builds that came with the system, once per process: one that
	 * does not run (no driver for the card, say) is set aside for the next
	 * best. Only in memory, as the folder and the machine may change.
	 */
	private async checkProvided(): Promise<void> {
		for (const build of this.engines.flatMap((engine) => engine.builds)) {
			const dir = await this.providedEngineDir(build);
			if (!dir) continue;
			const problem = await this.checkEngine(
				join(dir, ...build.executable.split(/[\\/]/)),
			);
			if (problem) {
				console.warn(
					`${build.id} from ${this.enginesDir} does not run: ${problem}`,
				);
				this.providedBroken.add(build.id);
			}
		}
	}

	/** Builds that were tried here and did not run, kept across restarts. */
	private brokenFile(): string {
		return join(this.root, "broken-engines.json");
	}

	private async loadBroken(): Promise<void> {
		const saved = await Bun.file(this.brokenFile())
			.json()
			.catch(() => []);
		if (Array.isArray(saved)) {
			for (const id of saved) if (typeof id === "string") this.broken.add(id);
		}
	}

	private async markBroken(buildId: string): Promise<void> {
		this.broken.add(buildId);
		await mkdir(this.root, { recursive: true });
		await Bun.write(this.brokenFile(), JSON.stringify([...this.broken]));
	}

	private spec(id: string): LocalModelSpec {
		const model = this.catalog.find((m) => m.id === id);
		if (!model) {
			throw new NotFoundError(
				`Unknown local model: ${id}`,
				"unknownLocalModel",
				{
					model: id,
				},
			);
		}
		return model;
	}

	private blob(sha256: string): string {
		return join(this.root, "blobs", sha256);
	}

	private marker(id: string): string {
		return join(this.root, "installed", id);
	}

	private engineDir(buildId: string): string {
		return join(this.root, "engines", buildId);
	}

	/** Where a build that came with the system is, when it did. */
	private async providedEngineDir(build: EngineBuild): Promise<string | null> {
		if (!this.enginesDir || this.providedBroken.has(build.id)) return null;
		const dir = join(this.enginesDir, build.id);
		const info = await stat(
			join(dir, ...build.executable.split(/[\\/]/)),
		).catch(() => null);
		return info?.isFile() ? dir : null;
	}

	/** Where an installed build runs from: the one that came with the system first. */
	private async installedEngineDir(build: EngineBuild): Promise<string> {
		return (await this.providedEngineDir(build)) ?? this.engineDir(build.id);
	}

	private chooser(hardware: Hardware) {
		const cache = new Map<string, BuildChoice<EngineBuild> | null>();
		return (engine: string) => {
			if (!cache.has(engine)) {
				const builds = (
					this.engines.find((spec) => spec.id === engine)?.builds ?? []
				).filter(
					(build) =>
						!this.broken.has(build.id) && !this.providedBroken.has(build.id),
				);
				cache.set(engine, chooseBuild(engine, builds, hardware));
			}
			return cache.get(engine) ?? null;
		};
	}

	/** Bytes on disk per hash: complete files, and what interrupted ones have. */
	private async onDisk(): Promise<{
		complete: Set<string>;
		partial: Map<string, number>;
	}> {
		const complete = new Set<string>();
		const partial = new Map<string, number>();
		const dir = join(this.root, "blobs");
		for (const name of await readdir(dir).catch(() => [])) {
			if (/^[a-f0-9]{64}$/.test(name)) complete.add(name);
			else if (/^[a-f0-9]{64}\.part$/.test(name)) {
				partial.set(name.slice(0, 64), await sizeOf(join(dir, name)));
			}
		}
		return { complete, partial };
	}

	/** Installed models and the variant each has. */
	private async installedVariants(
		complete: Set<string>,
	): Promise<Map<string, LocalModelVariant>> {
		const found = new Map<string, LocalModelVariant>();
		for (const id of await readdir(join(this.root, "installed")).catch(
			() => [],
		)) {
			const model = this.catalog.find((m) => m.id === id);
			if (!model) continue;
			const text = await Bun.file(this.marker(id))
				.text()
				.catch(() => "");
			let wanted: string | undefined;
			try {
				wanted = (JSON.parse(text) as { variant?: string }).variant;
			} catch {
				// Written before models had variants: the one whose files are here.
			}
			const variant =
				model.variants.find((v) => v.id === wanted) ??
				model.variants.find((v) =>
					v.files.every((file) => complete.has(file.sha256)),
				);
			if (variant) found.set(id, variant);
		}
		return found;
	}

	private async installedBuilds(): Promise<Set<string>> {
		const builds = this.engines.flatMap((engine) => engine.builds);
		const known = new Set(builds.map((build) => build.id));
		// Anything else is a leftover, such as an interrupted extraction.
		const names = await readdir(join(this.root, "engines")).catch(() => []);
		const installed = new Set(names.filter((name) => known.has(name)));
		for (const build of builds) {
			if (await this.providedEngineDir(build)) installed.add(build.id);
		}
		return installed;
	}

	/** Every file that installed and installing models need. */
	private async neededHashes(): Promise<Set<string>> {
		const disk = await this.onDisk();
		const needed = new Set<string>();
		const variants = [
			...(await this.installedVariants(disk.complete)).values(),
			...[...this.installs.values()].map((install) => install.variant),
		];
		// Being installed by another Hatchlight on the folder, in a variant this
		// one cannot tell: every one of them.
		const dir = join(this.root, "installed");
		for (const name of await readdir(dir).catch(() => [])) {
			if (!name.endsWith(".lock") || !isLocked(join(dir, name))) continue;
			const model = this.catalog.find((m) => `${m.id}.lock` === name);
			if (model) variants.push(...model.variants);
		}
		for (const variant of variants) {
			for (const file of variant.files) needed.add(file.sha256);
		}
		return needed;
	}

	async list(): Promise<LocalModelsView> {
		await this.follow();
		const hardware = await this.machine();
		const disk = await this.onDisk();
		const [installed, builds] = await Promise.all([
			this.installedVariants(disk.complete),
			this.installedBuilds(),
		]);
		const choose = this.chooser(hardware);
		const held = (file: LocalModelFile) => {
			if (disk.complete.has(file.sha256)) return file.size;
			for (const install of this.installs.values()) {
				if (install.current?.sha256 === file.sha256) {
					return install.current.bytes;
				}
			}
			return Math.min(disk.partial.get(file.sha256) ?? 0, file.size);
		};
		const engineSizes = new Map<string, number>();
		for (const build of builds) {
			engineSizes.set(build, await folderSize(this.engineDir(build)));
		}
		/** Models, other than `id`, that keep an engine installed. */
		const users = (engine: string, except?: string) =>
			[
				...installed,
				...[...this.installs].map(([id, i]) => [id, i.variant] as const),
			]
				.filter(([id, variant]) => id !== except && variant.engine === engine)
				.map(([id]) => id);

		/**
		 * The variant an install would get: the one that runs best here, or
		 * one whose files are already on disk (another model shares them)
		 * when it runs as well.
		 */
		const propose = (variants: LocalModelVariant[]) => {
			const best = chooseVariant(variants, hardware, choose);
			const there = chooseVariant(
				variants.filter((v) =>
					v.files.every((file) => disk.complete.has(file.sha256)),
				),
				hardware,
				choose,
			);
			return (there && there.fit === best?.fit ? there : best)?.variant;
		};
		const models = this.catalog.map((model): LocalModelStatus => {
			const { variants, demos, defaults: _, ...rest } = model;
			const install = this.installs.get(model.id);
			const own = install?.variant ?? installed.get(model.id);
			const variant = own ?? propose(variants) ?? null;
			const build = variant ? choose(variant.engine)?.build : undefined;
			const engineMissing = build != null && !builds.has(build.id);
			const files = variant ? unique(variant.files) : [];
			const engineFiles = engineMissing && build ? unique(build.files) : [];

			const others = new Set<string>();
			for (const [id, v] of installed) {
				if (id !== model.id) for (const f of v.files) others.add(f.sha256);
			}
			for (const [id, i] of this.installs) {
				if (id !== model.id)
					for (const f of i.variant.files) others.add(f.sha256);
			}
			// Every variant's files count: an abandoned download of one is freed too.
			const mine = unique(variants.flatMap((v) => v.files)).filter(
				(file) => !others.has(file.sha256),
			);
			const freesEngine =
				own != null &&
				build != null &&
				builds.has(build.id) &&
				users(own.engine, model.id).length === 0;
			const error = this.errors.get(model.id);

			return {
				...rest,
				state:
					install?.state ??
					(installed.has(model.id) ? "installed" : "available"),
				variants: variants.map(({ files: variantFiles, ...spec }) => ({
					...spec,
					fit: fitOf(spec, hardware, choose(spec.engine)),
					size: sum(unique(variantFiles).map((file) => file.size)),
					files: variantFiles.map((file) => ({
						name: file.name,
						size: file.size,
						present: disk.complete.has(file.sha256),
					})),
				})),
				variant: variant?.id ?? null,
				installed: installed.has(model.id),
				ready: installed.has(model.id) && build != null && !engineMissing,
				demos: demos.map(({ url: _, ...demo }) => demo),
				size: sum([...files, ...engineFiles].map((file) => file.size)),
				receivedBytes: sum([...files, ...engineFiles].map(held)),
				reclaimableBytes:
					sum(mine.map(held)) +
					(freesEngine && build ? (engineSizes.get(build.id) ?? 0) : 0),
				...(error && {
					error: error.message,
					...(error.code && { errorCode: error.code }),
					...(error.params && { errorParams: error.params }),
				}),
			};
		});

		const engines = this.engines.flatMap((engine): LocalEngineStatus[] => {
			const choice = choose(engine.id);
			if (!choice) return [];
			const { build, throughWindows } = choice;
			const present = builds.has(build.id);
			return [
				{
					engine: engine.id,
					name: engine.name,
					build: build.id,
					version: build.version,
					backend: build.backend,
					throughWindows,
					installed: present,
					size: present
						? (engineSizes.get(build.id) ?? 0)
						: sum(unique(build.files).map((file) => file.size)),
					usedBy: users(engine.id),
				},
			];
		});

		const sizes = new Map(
			[
				...this.catalog.flatMap((m) => m.variants.flatMap((v) => v.files)),
				...this.engines.flatMap((e) => e.builds.flatMap((b) => b.files)),
			].map((file) => [file.sha256, file.size]),
		);
		let usedBytes = sum([...engineSizes.values()]);
		for (const hash of disk.complete) {
			usedBytes += sizes.get(hash) ?? (await sizeOf(this.blob(hash)));
		}
		for (const bytes of disk.partial.values()) usedBytes += bytes;
		// Another Hatchlight sharing this folder (the desktop app and Hatchlight
		// under WSL do) may have installed or deleted a model: say so, as for
		// a change made here.
		const ready = models
			.filter((m) => m.ready)
			.map((m) => m.id)
			.join();
		if (this.lastReady != null && ready !== this.lastReady) {
			this.lastReady = ready;
			this.emit({ type: "models.changed" });
		}
		this.lastReady = ready;
		return {
			hardware,
			engines,
			models,
			disk: {
				path: this.root,
				freeBytes: await this.freeBytes(),
				usedBytes,
				changeable: this.locationFile != null,
				moving: this.moving,
				moveError: this.moveError,
			},
		};
	}

	private async freeBytes(): Promise<number> {
		await mkdir(this.root, { recursive: true });
		const info = await statfs(this.root);
		return info.bavail * info.bsize;
	}

	/**
	 * Moves the models to `target` and keeps them there from now on, for
	 * every Hatchlight that shares the choice. Refused while anything uses the
	 * folder, here or in another Hatchlight. The old folder stays whole until
	 * the new one is written down (see move.ts): a failure, or quitting
	 * midway, leaves the models where they were.
	 */
	async relocate(target: string): Promise<void> {
		// Claimed before the first wait: two requests must not both start.
		if (this.moving || this.relocating) throw movingError();
		this.relocating = true;
		try {
			await this.startMove(target);
		} finally {
			this.relocating = false;
		}
	}

	private async startMove(target: string): Promise<void> {
		const file = this.locationFile;
		if (!file) {
			throw new ValidationError(
				"The models folder is set from outside Hatchlight",
				"modelsFolderFixed",
			);
		}
		const here = pathHere(target.trim());
		if (!here) {
			throw new ValidationError(
				`Not a full path: ${target}`,
				"folderNotAbsolute",
				{ path: target },
			);
		}
		// Under WSL the choice is shared with the desktop app, which reaches
		// only folders on Windows drives.
		if (
			process.platform === "linux" &&
			file.startsWith("/mnt/") &&
			!/^\/mnt\/[a-z](\/|$)/.test(here)
		) {
			throw new ValidationError(
				`Windows cannot reach ${here}`,
				"folderNotShared",
				{ path: here },
			);
		}
		try {
			await mkdir(here, { recursive: true });
			const probe = join(here, `.hatchlight-${crypto.randomUUID()}`);
			await Bun.write(probe, "");
			await rm(probe);
		} catch {
			throw new ValidationError(
				`Cannot write to ${here}`,
				"folderNotWritable",
				{ path: here },
			);
		}
		await mkdir(this.root, { recursive: true });
		// Compared on disk, not as text: the same folder has many names (case,
		// links, short names), and moving a folder onto itself would delete it.
		const [from, to] = await Promise.all([
			stat(this.root, { bigint: true }),
			stat(here, { bigint: true }),
		]);
		if (from.dev === to.dev && from.ino === to.ino) return;
		if ((await inside(here, from)) || (await inside(this.root, to))) {
			throw new ValidationError(
				"The new folder cannot hold the current one, nor sit inside it",
				"folderInside",
				{ path: here },
			);
		}
		// Held in both folders until the old files are gone: no Hatchlight
		// installs, removes, runs or moves models meanwhile. Taken before
		// looking whether anything runs, so nothing starts in between.
		const holdOld = tryFileLock(join(this.root, "moving.lock"));
		const holdNew = holdOld && tryFileLock(join(here, "moving.lock"));
		const release = () => {
			holdOld?.();
			holdNew?.();
		};
		if (!holdOld || !holdNew) {
			release();
			throw movingError();
		}
		// A model kept loaded holds its files open, and Windows moves no open
		// file: let them go, now that nothing new can start.
		await this.letGo();
		try {
			const locked = async (dir: string) =>
				(await readdir(join(this.root, dir)).catch(() => [])).some(
					(name) =>
						name.endsWith(".lock") && isLocked(join(this.root, dir, name)),
				);
			const busy =
				this.installs.size > 0 ||
				this.gpu.inUse() ||
				this.loras.busy ||
				this.checkpoints.busy ||
				(await locked("blobs")) ||
				(await locked("engines")) ||
				(await locked("installed"));
			if (busy) {
				throw new ValidationError(
					"Models are in use; try again once nothing is installing or generating",
					"modelsBusy",
				);
			}
			let totalBytes = 0;
			for (const entry of MOVED_ENTRIES) {
				totalBytes += await treeSize(join(this.root, entry));
			}
			// Within one disk files are linked and take no room.
			if (from.dev !== to.dev) {
				const info = await statfs(here);
				const freeBytes = info.bavail * info.bsize;
				if (totalBytes > freeBytes) {
					throw new ValidationError(
						`Not enough disk space: ${formatBytes(totalBytes)} needed, ${formatBytes(freeBytes)} free`,
						"notEnoughDisk",
						{ neededBytes: totalBytes, freeBytes },
					);
				}
			}
			const moving = { to: here, movedBytes: 0, totalBytes };
			this.moving = moving;
			this.moveError = null;
			this.emit({ type: "models.moving", ...moving });
			// Across disks it takes minutes: it goes on after the answer, telling
			// how far it is, and a failure shows with the folder.
			this.moveTask = this.move(here, file, moving, release);
		} catch (error) {
			release();
			throw error;
		}
	}

	private async move(
		here: string,
		file: string,
		moving: NonNullable<LocalModelsView["disk"]["moving"]>,
		release: () => void,
	): Promise<void> {
		const old = this.root;
		let reported = 0;
		const report = (bytes: number) => {
			moving.movedBytes += bytes;
			const now = Date.now();
			if (now - reported < PROGRESS_INTERVAL_MS) return;
			reported = now;
			this.emit({ type: "models.moving", ...moving });
		};
		const mirror: Mirror = { made: [], old: [] };
		try {
			for (const entry of MOVED_ENTRIES) {
				await mirrorInto(join(old, entry), join(here, entry), mirror, {
					report,
					// Named by their hash: one already there is the same file.
					// Install markers and the list of broken engines are this
					// folder's word, and replace what is there.
					keep: (path) =>
						!path.startsWith(join(old, "installed")) &&
						!path.endsWith("broken-engines.json"),
					// An engine shows only once all its files are there.
					whole: (path) => dirname(path) === join(old, "engines"),
				});
			}
			// The move happens here: written whole, then renamed over the old
			// choice, so it is never read half written.
			const tmp = `${file}.${crypto.randomUUID()}.tmp`;
			await Bun.write(tmp, JSON.stringify({ path: portablePath(here) }));
			await rename(tmp, file);
		} catch (error) {
			const left = await undo(mirror);
			const reason = error instanceof Error ? error.message : String(error);
			this.moveError = describeError(
				new CodedError(
					`Could not move the models: ${reason}`,
					left.length > 0 ? "modelsMoveLeftCopies" : "modelsMoveFailed",
					{ reason, path: here },
				),
			);
			this.moving = null;
			release();
			this.emit({ type: "models.changed" });
			return;
		}
		this.switchTo(here);
		// Only now do the old files go. Still moving until they are gone: a
		// move back meanwhile would find files about to be deleted.
		await cleanUp(mirror, old);
		this.moving = null;
		release();
		this.emit({ type: "models.changed" });
	}

	/** Refuses to touch models while they move to another folder. */
	private notMoving(): void {
		if (
			this.moving ||
			this.relocating ||
			isLocked(join(this.root, "moving.lock"))
		) {
			throw movingError();
		}
	}

	/** Uses the folder another Hatchlight chose, once nothing runs here. */
	private async follow(): Promise<void> {
		if (
			!this.locationFile ||
			this.moving ||
			this.relocating ||
			this.installs.size > 0 ||
			this.gpu.reserved > 0
		) {
			return;
		}
		const chosen = await Bun.file(this.locationFile)
			.json()
			.then((body: { path?: unknown }) =>
				typeof body.path === "string" ? pathHere(body.path) : null,
			)
			.catch(() => null);
		if (chosen && !samePath(chosen, this.root)) this.switchTo(chosen);
	}

	private switchTo(root: string): void {
		this.root = root;
		this.gpu.moveTo(root);
		this.emit({ type: "models.changed" });
	}

	/** What it takes to run an installed model on this machine. */
	async runtime(id: string): Promise<LocalRuntime> {
		const model = this.spec(id);
		// Another Hatchlight may have moved the models since this one looked.
		await this.follow();
		this.notMoving();
		const disk = await this.onDisk();
		const variant = (await this.installedVariants(disk.complete)).get(id);
		if (!variant) {
			throw new ValidationError(
				`${model.name} is not installed`,
				"notInstalled",
				{
					model: model.name,
				},
			);
		}
		const hardware = await this.machine();
		const choice = this.chooser(hardware)(variant.engine);
		if (!choice || !(await this.installedBuilds()).has(choice.build.id)) {
			throw new ValidationError(
				`The engine for ${model.name} is not installed. Install the model again.`,
				"engineMissing",
				{ model: model.name },
			);
		}
		const dir = await this.installedEngineDir(choice.build);
		return {
			model,
			variant,
			build: choice.build,
			executable: join(dir, ...choice.build.executable.split(/[\\/]/)),
			throughWindows: choice.throughWindows,
			fit: fitOf(variant, hardware, choice),
			...(choice.gpu && { gpuMemoryBytes: choice.gpu.memoryBytes }),
			scratch: join(this.root, "tmp"),
			files: Object.fromEntries(
				variant.files.map((file) => [
					file.role ?? file.name,
					this.blob(file.sha256),
				]),
			),
		};
	}

	/**
	 * What it takes to run a checkpoint added by hand, as `model` (made from
	 * its notes) with the engine the catalog's models of its family use.
	 */
	async checkpointRuntime(
		id: string,
		model: LocalModelSpec,
	): Promise<LocalRuntime> {
		await this.follow();
		this.notMoving();
		const [variant] = model.variants;
		await this.checkpoints.get(id);
		if (!variant) throw new Error(`${model.name} has no variant`);
		const hardware = await this.machine();
		const choice = this.chooser(hardware)(variant.engine);
		if (!choice || !(await this.installedBuilds()).has(choice.build.id)) {
			throw new ValidationError(
				`${model.name} needs the engine of the Stable Diffusion models. Install one of them first.`,
				"checkpointNeedsEngine",
				{ model: model.name },
			);
		}
		const dir = await this.installedEngineDir(choice.build);
		return {
			model,
			variant,
			build: choice.build,
			executable: join(dir, ...choice.build.executable.split(/[\\/]/)),
			throughWindows: choice.throughWindows,
			fit: fitOf(variant, hardware, choice),
			...(choice.gpu && { gpuMemoryBytes: choice.gpu.memoryBytes }),
			scratch: join(this.root, "tmp"),
			files: { model: this.checkpoints.path(id) },
		};
	}

	/**
	 * What Hatchlight does with a repository on Hugging Face: the catalog
	 * model it is, or the checkpoint or LoRA file it would add, or why not.
	 */
	openFromHub(target: HubTarget, signal?: AbortSignal): Promise<HubChoice> {
		return resolveHub(target, this.catalog, this.fetch, signal);
	}

	/**
	 * Adds a checkpoint or LoRA from Hugging Face, at the revision the person
	 * confirmed. It is looked at again there rather than taken on trust, and
	 * stops when `signal` does.
	 */
	async addFromHub(
		target: HubTarget,
		revision: string,
		signal?: AbortSignal,
	): Promise<
		| { kind: "checkpoint"; item: CheckpointInfo }
		| { kind: "lora"; item: LoraInfo }
	> {
		this.notMoving();
		if (!target.file || !HUB_REVISION.test(revision)) {
			throw new ValidationError(
				"Name a file and the revision it was found at",
				"hubInvalid",
			);
		}
		const key = `${target.repo}/${target.file}`.toLowerCase();
		// Files can be many gigabytes: two at a time at most.
		if (this.hubDownloads.has(key) || this.hubDownloads.size >= 2) {
			throw new ValidationError(
				"This file, or two others, are already being downloaded from Hugging Face",
				"hubBusy",
			);
		}
		this.hubDownloads.add(key);
		try {
			const choice = await inspectHubFile(target, revision, this.fetch, signal);
			if (choice.kind === "unsupported") {
				throw new ValidationError(
					"This file cannot be added from Hugging Face",
					"hubUnsupported",
					{ reason: choice.reason },
				);
			}
			const { repo, file, size, sha256 } = choice;
			const freeBytes = await this.freeBytes();
			if (size > freeBytes) {
				throw new ValidationError(
					`Not enough disk space: ${formatBytes(size)} needed, ${formatBytes(freeBytes)} free`,
					"notEnoughDisk",
					{ neededBytes: size, freeBytes },
				);
			}
			const name = file.split("/").at(-1) as string;
			const response = await hubFetch(
				this.fetch,
				hubFileUrl(repo, choice.revision, file),
				{ signal },
			);
			if (!response.ok || !response.body) {
				await response.body?.cancel().catch(() => {});
				throw new CodedError(
					`Could not download ${name} (HTTP ${response.status})`,
					"downloadFailed",
					{ file: name, status: response.status },
				);
			}
			const hasher = new Bun.CryptoHasher("sha256");
			let received = 0;
			let shown = 0;
			// Kept here: a stream's error may come out of the write changed.
			let failure: Error | null = null;
			const fail = (
				controller: TransformStreamDefaultController,
				error: Error,
			) => {
				failure = error;
				controller.error(error);
			};
			const progress = () =>
				this.emit({
					type: "hub.progress",
					repo,
					file,
					receivedBytes: received,
					size,
				});
			progress();
			const checked = response.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform: (chunk, controller) => {
						received += chunk.byteLength;
						if (received > size) {
							fail(
								controller,
								new CodedError(
									`${name} is larger than expected`,
									"downloadTooLarge",
									{ file: name },
								),
							);
							return;
						}
						hasher.update(chunk);
						if (Date.now() - shown >= PROGRESS_INTERVAL_MS) {
							shown = Date.now();
							progress();
						}
						controller.enqueue(chunk);
					},
					flush: (controller) => {
						if (received !== size) {
							fail(
								controller,
								new CodedError(
									`The download of ${name} was cut short`,
									"downloadCutShort",
									{ file: name },
								),
							);
						} else if (sha256 && hasher.digest("hex") !== sha256) {
							fail(
								controller,
								new CodedError(
									`${name} did not match its expected hash`,
									"hashMismatch",
									{ file: name },
								),
							);
						}
					},
				}),
			);
			try {
				if (choice.kind === "checkpoint") {
					return {
						kind: "checkpoint",
						item: await this.checkpoints.add(checked, name),
					};
				}
				return { kind: "lora", item: await this.loras.add(checked, name) };
			} catch (error) {
				throw signal?.aborted ? error : (failure ?? error);
			}
		} finally {
			this.hubDownloads.delete(key);
		}
	}

	/**
	 * Starts installing a model: the variant asked for, or the best one for
	 * this machine, and its engine if missing. Progress and the outcome arrive
	 * as events.
	 */
	async install(id: string, variantId?: string): Promise<void> {
		const model = this.spec(id);
		if (this.installs.has(id)) return;
		this.notMoving();
		const view = await this.list();
		const status = view.models.find((m) => m.id === id) as LocalModelStatus;
		if (status.ready) return;

		const hardware = await this.machine();
		const choose = this.chooser(hardware);
		let variant: LocalModelVariant | undefined;
		if (status.installed) {
			// Installed without its engine (older install, or new hardware): fetch it.
			variant = model.variants.find((v) => v.id === status.variant);
			if (!variant) throw new Error(`${model.name} has no variant installed`);
		} else if (variantId) {
			variant = model.variants.find((v) => v.id === variantId);
			if (!variant) {
				throw new NotFoundError(
					`Unknown variant: ${variantId}`,
					"unknownVariant",
					{
						variant: variantId,
					},
				);
			}
			if (fitOf(variant, hardware, choose(variant.engine)) === "none") {
				throw new ValidationError(
					`${model.name} (${variant.label}) does not run on this machine`,
					"variantDoesNotRun",
					{ model: model.name, variant: variant.label },
				);
			}
		} else {
			// The one the list proposes, so what is shown is what installs.
			variant = model.variants.find((v) => v.id === status.variant);
			if (!variant) {
				throw new ValidationError(
					`${model.name} does not run on this machine`,
					"modelDoesNotRun",
					{ model: model.name },
				);
			}
		}
		const build = choose(variant.engine)?.build as EngineBuild;

		// Space for this install and for others waiting in line.
		const installedBuilds = await this.installedBuilds();
		const disk = await this.onDisk();
		const queuedEngines = new Set(
			[...this.installs.values()].map(
				(i) => choose(i.variant.engine)?.build.id,
			),
		);
		const missing = (file: LocalModelFile) =>
			file.size - Math.min(disk.partial.get(file.sha256) ?? 0, file.size);
		const engineBytes =
			installedBuilds.has(build.id) || queuedEngines.has(build.id)
				? 0
				: sum(unique(build.files).map(missing)) +
					// Extracting needs room for the program next to its archives.
					sum(unique(build.files).map((file) => file.size)) * 2;
		const pending =
			engineBytes +
			sum(
				unique(variant.files)
					.filter((file) => !disk.complete.has(file.sha256))
					.map(missing),
			) +
			sum(
				view.models
					.filter((m) => this.installs.has(m.id))
					.map((m) => m.size - m.receivedBytes),
			);
		if (pending > view.disk.freeBytes) {
			throw new ValidationError(
				`Not enough disk space: ${formatBytes(pending)} needed, ${formatBytes(view.disk.freeBytes)} free`,
				"notEnoughDisk",
				{ neededBytes: pending, freeBytes: view.disk.freeBytes },
			);
		}

		const install: Install = {
			state: "queued",
			controller: new AbortController(),
			variant,
			current: null,
			startedAt: 0,
			transferred: 0,
			lastProgress: 0,
		};
		this.installs.set(id, install);
		this.errors.delete(id);
		this.emit({ type: "models.changed" });

		const run = async () => {
			if (this.installs.get(id) !== install) return; // canceled while waiting
			// Says to other Hatchlights on the folder that this model's files are
			// wanted, before its marker is there to say so.
			let announced: (() => void) | null = null;
			try {
				await mkdir(join(this.root, "installed"), { recursive: true });
				announced = tryFileLock(join(this.root, "installed", `${id}.lock`));
				install.state = "downloading";
				install.startedAt = Date.now();
				this.emit({ type: "models.changed" });
				// A build that does not run here is set aside for the next best.
				let current = build;
				while (!(await this.installedBuilds()).has(current.id)) {
					try {
						await this.installEngine(model, current, install);
					} catch (error) {
						if (!(error instanceof EngineCheckFailed)) throw error;
						await this.markBroken(current.id);
						const next = this.chooser(await this.machine())(variant.engine);
						if (!next) {
							throw new CodedError(
								`The engine does not run on this computer: ${error.message}`,
								"engineDoesNotRun",
								{ reason: error.message },
							);
						}
						current = next.build;
					}
				}
				for (const file of variant.files) {
					await this.download(model, file, install);
				}
				await Bun.write(
					this.marker(id),
					JSON.stringify({ variant: variant.id }),
				);
			} catch (error) {
				if (!install.controller.signal.aborted) {
					this.errors.set(id, describeError(error));
				}
			} finally {
				announced?.();
				this.installs.delete(id);
				this.emit({ type: "models.changed" });
			}
		};
		this.queue = this.queue.then(run);
	}

	/**
	 * Downloads a build's archives, extracts them, and drops the archives.
	 * Another Hatchlight sharing the folder may be installing the same build:
	 * this one waits for it and uses what it installed.
	 */
	private async installEngine(
		model: LocalModelSpec,
		build: EngineBuild,
		install: Install,
	): Promise<void> {
		await mkdir(join(this.root, "engines"), { recursive: true });
		await withFileLock(
			`${this.engineDir(build.id)}.lock`,
			install.controller.signal,
			async () => {
				if ((await this.installedBuilds()).has(build.id)) return;
				await this.unpackEngine(model, build, install);
			},
		);
	}

	private async unpackEngine(
		model: LocalModelSpec,
		build: EngineBuild,
		install: Install,
	): Promise<void> {
		for (const file of build.files) await this.download(model, file, install);
		install.state = "verifying";
		this.progress(model, install, true);
		const dir = this.engineDir(build.id);
		const tmp = `${dir}.${crypto.randomUUID()}.tmp`;
		try {
			for (const file of build.files) {
				install.controller.signal.throwIfAborted();
				const extract = /\.(tar\.gz|tgz)$/.test(file.name)
					? extractTarGz
					: extractZip;
				await extract(this.blob(file.sha256), tmp).catch((error: unknown) => {
					throw new CodedError(
						error instanceof Error ? error.message : String(error),
						"engineUnpackFailed",
					);
				});
			}
			await chmod(join(tmp, ...build.executable.split(/[\\/]/)), 0o755);
			await rename(tmp, dir);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
		const problem = await this.checkEngine(
			join(dir, ...build.executable.split(/[\\/]/)),
		);
		if (problem) {
			await rm(dir, { recursive: true, force: true });
			for (const file of build.files)
				await rm(this.blob(file.sha256), { force: true });
			throw new EngineCheckFailed(problem);
		}
		// Extracted, the archives are only taking space.
		for (const file of build.files)
			await rm(this.blob(file.sha256), { force: true });
	}

	private progress(
		model: LocalModelSpec,
		install: Install,
		force = false,
	): void {
		const now = Date.now();
		if (!force && now - install.lastProgress < PROGRESS_INTERVAL_MS) return;
		install.lastProgress = now;
		void this.list()
			// The folder may be gone (moved, or deleted): no progress to tell.
			.catch(() => null)
			.then((view) => {
				if (!view) return;
				const status = view.models.find((m) => m.id === model.id);
				if (!status || this.installs.get(model.id) !== install) return;
				const seconds = Math.max((now - install.startedAt) / 1000, 0.001);
				this.emit({
					type: "model.progress",
					id: model.id,
					state: install.state,
					receivedBytes: status.receivedBytes,
					size: status.size,
					bytesPerSecond: Math.round(install.transferred / seconds),
				});
			});
	}

	/**
	 * Downloads one file, unless it is there. Another Hatchlight sharing the
	 * folder may be downloading it: this one waits, showing that download's
	 * progress, and uses the file it leaves.
	 */
	private async download(
		model: LocalModelSpec,
		file: LocalModelFile,
		install: Install,
	): Promise<void> {
		const path = this.blob(file.sha256);
		if (await Bun.file(path).exists()) return;
		// Another Hatchlight may have started moving the models.
		this.notMoving();
		await mkdir(join(this.root, "blobs"), { recursive: true });
		await withFileLock(
			`${path}.lock`,
			install.controller.signal,
			async () => {
				if (await Bun.file(path).exists()) return;
				await this.fetchFile(model, file, install);
			},
			{
				onWait: async () => {
					install.state = "downloading";
					install.current = {
						sha256: file.sha256,
						bytes: await sizeOf(`${path}.part`),
					};
					this.progress(model, install, true);
				},
			},
		);
	}

	private async fetchFile(
		model: LocalModelSpec,
		file: LocalModelFile,
		install: Install,
	): Promise<void> {
		const { signal } = install.controller;
		const path = this.blob(file.sha256);
		const part = `${path}.part`;

		let have = await sizeOf(part);
		if (have > file.size) {
			await rm(part, { force: true });
			have = 0;
		}
		install.state = "downloading";
		install.current = { sha256: file.sha256, bytes: have };

		if (have < file.size) {
			const response = await this.fetch(file.url, {
				headers: have > 0 ? { range: `bytes=${have}-` } : {},
				signal,
			});
			if (!response.ok || !response.body) {
				throw new CodedError(
					`Could not download ${file.name} (HTTP ${response.status})`,
					"downloadFailed",
					{ file: file.name, status: response.status },
				);
			}
			// A server that ignores the range sends the file from the start.
			const resumed = response.status === 206;
			if (!resumed) install.current.bytes = 0;
			// Each chunk is written where it belongs rather than appended: on a
			// Windows folder under WSL, appending while the file's size is read
			// (as listing the models does) loses chunks.
			const out = await open(part, resumed ? "r+" : "w");
			try {
				for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
					if (install.current.bytes + chunk.byteLength > file.size) {
						throw new CodedError(
							`${file.name} is larger than expected`,
							"downloadTooLarge",
							{ file: file.name },
						);
					}
					await out.write(chunk, 0, chunk.byteLength, install.current.bytes);
					install.current.bytes += chunk.byteLength;
					install.transferred += chunk.byteLength;
					this.progress(model, install);
				}
			} finally {
				await out.close();
			}
			signal.throwIfAborted();
			// The file, not only the count: a write the disk lost shows here.
			if (
				install.current.bytes !== file.size ||
				(await sizeOf(part)) !== file.size
			) {
				throw new CodedError(
					`The download of ${file.name} was cut short`,
					"downloadCutShort",
					{ file: file.name },
				);
			}
		}

		install.state = "verifying";
		this.progress(model, install, true);
		const hasher = new Bun.CryptoHasher("sha256");
		for await (const chunk of Bun.file(part).stream()) {
			signal.throwIfAborted();
			hasher.update(chunk);
		}
		if (hasher.digest("hex") !== file.sha256) {
			// Nothing of a file that fails the check is worth resuming.
			await rm(part, { force: true });
			throw new CodedError(
				`${file.name} did not match its expected hash`,
				"hashMismatch",
				{ file: file.name },
			);
		}
		await rename(part, path);
		install.current = null;
		install.state = "downloading";
	}

	/** Stops an install. What was downloaded is kept, to resume from. */
	async cancel(id: string): Promise<void> {
		this.spec(id);
		const install = this.installs.get(id);
		if (!install) return;
		install.controller.abort();
		if (install.state === "queued") {
			// Its turn has not come; do not wait for the downloads ahead of it.
			this.installs.delete(id);
			this.emit({ type: "models.changed" });
			return;
		}
		await this.settled(id);
	}

	private async settled(id: string): Promise<void> {
		while (this.installs.has(id)) {
			await new Promise<void>((resolve) => {
				const unsubscribe = this.subscribe((event) => {
					if (event.type !== "models.changed") return;
					unsubscribe();
					resolve();
				});
			});
		}
	}

	/**
	 * Tells the store how to make something that keeps model files open (a
	 * model kept loaded between pictures or prompts) let go of them, before
	 * files are deleted or moved. It resolves once they are closed.
	 */
	onLetGo(letGo: () => Promise<void>): void {
		this.holders.add(letGo);
	}

	private async letGo(): Promise<void> {
		for (const letGo of this.holders) await letGo().catch(() => {});
	}

	/**
	 * Deletes a model, installed or half downloaded, in every variant. Files
	 * another model uses are kept; an engine no model uses any more goes too.
	 */
	async remove(id: string): Promise<void> {
		const model = this.spec(id);
		this.notMoving();
		await this.cancel(id);
		// Windows deletes no open file: a model kept loaded lets go first.
		await this.letGo();
		this.errors.delete(id);
		await rm(this.marker(id), { force: true });
		const needed = await this.neededHashes();
		for (const file of unique(model.variants.flatMap((v) => v.files))) {
			if (needed.has(file.sha256)) continue;
			// Another Hatchlight sharing the folder is downloading it.
			if (isLocked(`${this.blob(file.sha256)}.lock`)) continue;
			await rm(this.blob(file.sha256), { force: true });
			await rm(`${this.blob(file.sha256)}.part`, { force: true });
		}
		await this.removeUnusedEngines();
		this.emit({ type: "models.changed" });
	}

	private async removeUnusedEngines(): Promise<void> {
		const disk = await this.onDisk();
		const inUse = new Set(
			[
				...(await this.installedVariants(disk.complete)).values(),
				...[...this.installs.values()].map((install) => install.variant),
			].map((variant) => variant.engine),
		);
		for (const engine of this.engines) {
			if (inUse.has(engine.id)) continue;
			for (const build of engine.builds) {
				// Another Hatchlight sharing the folder is installing it.
				if (isLocked(`${this.engineDir(build.id)}.lock`)) continue;
				await rm(this.engineDir(build.id), { recursive: true, force: true });
				for (const file of build.files) {
					await rm(this.blob(file.sha256), { force: true });
					await rm(`${this.blob(file.sha256)}.part`, { force: true });
				}
			}
		}
	}

	/**
	 * A model's demo, downloaded on first use and kept. A demo picture can be
	 * asked for at a smaller size: authors publish some at over 100
	 * megapixels, which browsers take seconds to decode for a small card.
	 */
	async demo(
		id: string,
		index: number,
		size: DemoSize = "original",
	): Promise<{ blob: Blob; mime: string }> {
		const demo = this.spec(id).demos[index];
		if (!demo) throw new NotFoundError("Demo not found");
		const name = new Bun.CryptoHasher("sha256").update(demo.url).digest("hex");
		const path = join(this.root, "demos", name);
		if (!(await Bun.file(path).exists())) {
			await this.once(name, () => this.fetchDemo(demo.url, path));
		}
		const blob = Bun.file(path);
		const mime = sniffMime(await blob.slice(0, 32).bytes());
		if (!mime) throw new Error("The stored demo is not an image or a video");
		// A GIF may move, which a smaller WebP would lose.
		const key = `${name}.${size}`;
		if (
			size === "original" ||
			!mime.startsWith("image/") ||
			mime === "image/gif" ||
			this.unshrinkable.has(key)
		) {
			return { blob, mime };
		}
		const smaller = `${path}.${size}.webp`;
		if (!(await Bun.file(smaller).exists())) {
			const made = await this.once(key, () =>
				shrinkDemo(path, smaller, DEMO_SIDES[size]),
			).catch(() => false);
			// A picture Bun cannot read is served as it came, without trying again.
			if (!made) {
				this.unshrinkable.add(key);
				return { blob, mime };
			}
		}
		return { blob: Bun.file(smaller), mime: "image/webp" };
	}

	/** Runs `work` once for every caller asking for `key` at the same time. */
	private once<T>(key: string, work: () => Promise<T>): Promise<T> {
		let pending = this.demos.get(key) as Promise<T> | undefined;
		if (!pending) {
			pending = work().finally(() => this.demos.delete(key));
			this.demos.set(key, pending);
		}
		return pending;
	}

	private async fetchDemo(url: string, path: string): Promise<string> {
		const response = await this.fetch(url, {
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) {
			throw new Error(`Could not download the demo (HTTP ${response.status})`);
		}
		if (Number(response.headers.get("content-length")) > MAX_DEMO_BYTES) {
			throw new Error("The demo is too large");
		}
		const data = await response.bytes();
		// It will be served from this origin, so it must be what it claims.
		if (data.byteLength > MAX_DEMO_BYTES || !sniffMime(data)) {
			throw new Error("The demo is not an image or a video");
		}
		await mkdir(join(this.root, "demos"), { recursive: true });
		const tmp = `${path}.${crypto.randomUUID()}.tmp`;
		await Bun.write(tmp, data);
		await rename(tmp, path);
		return path;
	}

	/** Resolves once no install is queued or running. */
	async idle(): Promise<void> {
		await this.moveTask;
		while (this.installs.size > 0) await this.queue;
	}

	/** Stops every install. Downloads are kept, to resume from. */
	async close(): Promise<void> {
		for (const install of this.installs.values()) install.controller.abort();
		await this.idle();
	}
}
