import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	APP_NAME,
	appEnv,
	envVariable,
	LEGACY_NAME,
	ValidationError,
} from "@hatchlight/core";

/** How a program starts `hatchlight mcp`. */
export interface Launch {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/** What the app knows about connecting agents to this installation. */
export interface AgentsSetup {
	/** As Claude Desktop starts it, e.g. through wsl.exe under WSL. */
	desktop: Launch;
	/** As an agent on this same system, such as Claude Code, starts it. */
	code: Launch;
	/**
	 * As Claude Code inside WSL starts this Windows program, when it runs
	 * on Windows from a drive WSL can reach.
	 */
	codeInWsl?: Launch;
	/** Where Claude Desktop keeps its settings, or null if unknown here. */
	claudeDesktopConfig: string | null;
	/** The shell the Claude Code command is written for. */
	shell: "posix" | "powershell";
}

/** What an agent may spend, as the person chose it. */
export interface AgentPolicy {
	allowPaid: boolean;
	spendLimitUsd: number | null;
}

export interface AgentsStatus {
	/** `claude mcp add …`, without the policy's options. */
	claudeCode: string[];
	/** The same from Linux in WSL, for a Windows installation; else null. */
	claudeCodeWsl: string[] | null;
	/** The shell those words are for, to quote them. */
	shell: "posix" | "powershell";
	claudeDesktop: {
		/** Claude Desktop seems installed: its settings folder is there. */
		available: boolean;
		connected: boolean;
		/** The entry starts this installation as it is now. */
		current: boolean;
		policy: AgentPolicy | null;
		/** Why its settings could not be read, when they could not. */
		problem: string | null;
	};
}

/**
 * A Windows path as WSL reaches it, C:\x → /mnt/c/x, under WSL's usual
 * mount root; null for one it cannot reach, such as a network share.
 */
export function wslPath(windows: string): string | null {
	const match = windows.match(/^([A-Za-z]):[\\/](.*)$/);
	if (!match) return null;
	const [, drive, rest] = match as unknown as [string, string, string];
	return `/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`;
}

/** The name Hatchlight goes by in agents' settings. */
const NAME = "hatchlight";

/**
 * Whether an entry under the old name starts this app as an MCP server:
 * with the same program as now, or with one named after the app then.
 * Anything else under that name is someone else's, and stays.
 */
function isOurLegacyEntry(entry: unknown, desktop: Launch): boolean {
	if (!entry || typeof entry !== "object") return false;
	const { command, args } = entry as { command?: unknown; args?: unknown };
	if (typeof command !== "string" || !Array.isArray(args)) return false;
	const words = args.map(String);
	if (!words.includes("mcp")) return false;
	return (
		command === desktop.command ||
		[command, ...words].some((word) =>
			word.split(/[\\/]/).some((part) => part.startsWith(LEGACY_NAME)),
		)
	);
}

/** The entry under the old name, when it is this app's. */
function legacyEntry(config: Config, desktop: Launch): unknown {
	const entry = config.mcpServers?.[LEGACY_NAME];
	return isOurLegacyEntry(entry, desktop) ? entry : undefined;
}

/** Removes this app's entry under the old name; whether there was one. */
function removeLegacyEntry(config: Config, desktop: Launch): boolean {
	if (!config.mcpServers || !legacyEntry(config, desktop)) return false;
	const { [LEGACY_NAME]: _, ...rest } = config.mcpServers;
	config.mcpServers = rest;
	return true;
}

/** The options `hatchlight mcp` takes for a policy. */
export function policyArgs(policy: AgentPolicy): string[] {
	if (!policy.allowPaid) return [];
	return [
		"--allow-paid",
		...(policy.spendLimitUsd != null
			? ["--spend-limit", String(policy.spendLimitUsd)]
			: []),
	];
}

/** The options of `hatchlight mcp` that take a value. */
const VALUED = new Set(["--data-dir", "--resources", "--spend-limit"]);

/**
 * The options an entry gives `mcp` that are neither its policy nor set by
 * `desktop` itself, such as a --data-dir the person added.
 */
function addedArgs(args: string[], desktop: Launch): string[] {
	const at = args.indexOf("mcp");
	if (at < 0) return [];
	const set = new Set(["--allow-paid", "--spend-limit", ...desktop.args]);
	const added: string[] = [];
	for (let i = at + 1; i < args.length; i++) {
		const arg = args[i] as string;
		const option = VALUED.has(arg) ? args.slice(i, i + 2) : [arg];
		if (!set.has(arg)) added.push(...option);
		i += option.length - 1;
	}
	return added;
}

/**
 * An entry's environment with the variables named after the old name
 * renamed, WSLENV's list of them included.
 */
function renamedEnv(env: unknown): Record<string, string> {
	if (!env || typeof env !== "object" || Array.isArray(env)) return {};
	const before = envVariable(LEGACY_NAME, "");
	const now = envVariable(APP_NAME, "");
	const rename = (name: string) =>
		name.startsWith(before) ? now + name.slice(before.length) : name;
	return Object.fromEntries(
		Object.entries(env).map(([key, value]) => [
			rename(key),
			key === "WSLENV"
				? String(value).split(":").map(rename).join(":")
				: String(value),
		]),
	);
}

/** The policy an entry's options say, back. */
function policyOf(args: string[]): AgentPolicy {
	const at = args.indexOf("--spend-limit");
	const given = at >= 0 ? (args[at + 1] ?? "") : "";
	const limit = /^\d+(\.\d+)?$/.test(given) ? Number(given) : null;
	return { allowPaid: args.includes("--allow-paid"), spendLimitUsd: limit };
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

type Config = { mcpServers?: Record<string, unknown> } & Record<
	string,
	unknown
>;

const unreadable = (path: string) =>
	new ValidationError(
		"Claude Desktop's settings file cannot be read, so it is left as it is",
		"claudeConfigUnreadable",
		{ path },
	);

/**
 * Claude Desktop's settings, kept as they are. Missing, they are empty;
 * anything else unreadable is refused, never written over.
 */
async function readConfig(path: string): Promise<Config> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw unreadable(path);
	}
	const text = raw.replace(/^﻿/, "");
	if (!text.trim()) return {};
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch {
		throw unreadable(path);
	}
	const servers = (config as Config | null)?.mcpServers;
	if (
		!config ||
		typeof config !== "object" ||
		Array.isArray(config) ||
		(servers != null && (typeof servers !== "object" || Array.isArray(servers)))
	) {
		throw unreadable(path);
	}
	return config as Config;
}

/**
 * Writes the settings whole or not at all, through a link if it is one,
 * keeping the file's permissions: it often holds other servers' keys. The
 * first time, what was there is kept beside it.
 */
async function writeConfig(path: string, config: Config): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const target = await realpath(path).catch(() => path);
	const before = await stat(target).catch(() => null);
	const backup = `${target}.before-hatchlight`;
	if (before && !(await exists(backup))) await copyFile(target, backup);
	const tmp = `${target}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, {
			mode: before ? before.mode & 0o777 : 0o600,
		});
		await rename(tmp, target);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}

/** Connects agents to Hatchlight, in their own settings. */
export class Agents {
	private setup: Promise<AgentsSetup> | null = null;
	/** Changes to the settings, one at a time. */
	private queue: Promise<unknown> = Promise.resolve();

	/** The setup is worked out when first needed: it may ask Windows. */
	constructor(private load: () => Promise<AgentsSetup>) {}

	private get(): Promise<AgentsSetup> {
		this.setup ??= this.load();
		return this.setup;
	}

	async status(): Promise<AgentsStatus> {
		const {
			code,
			codeInWsl,
			desktop,
			shell,
			claudeDesktopConfig: path,
		} = await this.get();
		const addCommand = (launch: Launch) => [
			"claude",
			"mcp",
			"add",
			NAME,
			"--scope",
			"user",
			...Object.entries(launch.env ?? {}).flatMap(([key, value]) => [
				"-e",
				`${key}=${value}`,
			]),
			"--",
			launch.command,
			...launch.args,
		];
		const claudeCode = addCommand(code);
		const claudeCodeWsl = codeInWsl ? addCommand(codeInWsl) : null;
		const none = {
			available: false,
			connected: false,
			current: false,
			policy: null,
			problem: null,
		};
		if (!path || !(await exists(dirname(path)))) {
			return { claudeCode, claudeCodeWsl, shell, claudeDesktop: none };
		}
		let config: Config;
		try {
			config = await readConfig(path);
		} catch (error) {
			return {
				claudeCode,
				claudeCodeWsl,
				shell,
				claudeDesktop: {
					...none,
					available: true,
					problem: (error as Error).message,
				},
			};
		}
		const named = config.mcpServers?.[NAME];
		// Connected before the rename: it still works, and connecting again
		// moves it to the new name.
		const entry = (named ?? legacyEntry(config, desktop)) as
			| { command?: unknown; args?: unknown }
			| undefined;
		const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
		return {
			claudeCode,
			claudeCodeWsl,
			shell,
			claudeDesktop: {
				available: true,
				connected: entry != null,
				current:
					named != null &&
					entry?.command === desktop.command &&
					desktop.args.every((arg, i) => args[i] === arg),
				policy: entry ? policyOf(args) : null,
				problem: null,
			},
		};
	}

	/** Adds Hatchlight to Claude Desktop, or updates what it may spend. */
	connectClaudeDesktop(policy: AgentPolicy): Promise<void> {
		return this.change(async (config, { desktop }) => {
			// Replacing the entry from before the rename keeps what the person
			// added to it.
			const before = config.mcpServers?.[NAME]
				? undefined
				: (legacyEntry(config, desktop) as
						| { args: unknown[]; env?: unknown }
						| undefined);
			removeLegacyEntry(config, desktop);
			const env = {
				...renamedEnv(before?.env),
				...(desktop.env ?? {}),
			};
			config.mcpServers = {
				...(config.mcpServers ?? {}),
				[NAME]: {
					command: desktop.command,
					args: [
						...desktop.args,
						...addedArgs(before?.args.map(String) ?? [], desktop),
						...policyArgs(policy),
					],
					...(Object.keys(env).length > 0 && { env }),
				},
			};
			return true;
		});
	}

	disconnectClaudeDesktop(): Promise<void> {
		return this.change(async (config, { desktop }) => {
			const removed = removeLegacyEntry(config, desktop);
			if (!config.mcpServers?.[NAME]) return removed;
			const { [NAME]: _, ...rest } = config.mcpServers;
			config.mcpServers = rest;
			return true;
		});
	}

	/** Reads, changes and writes the settings, after any change before. */
	private change(
		edit: (config: Config, setup: AgentsSetup) => Promise<boolean>,
	): Promise<void> {
		const run = async () => {
			const setup = await this.get();
			const path = setup.claudeDesktopConfig;
			if (!path || !(await exists(dirname(path)))) {
				throw new ValidationError(
					"Claude Desktop is not installed on this computer",
					"claudeNotFound",
				);
			}
			const config = await readConfig(path);
			if (await edit(config, setup)) await writeConfig(path, config);
		};
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => {});
		return next;
	}
}

/** A program's output, or null if it fails or takes more than a moment. */
async function output(argv: string[]): Promise<string | null> {
	try {
		const child = Bun.spawn(argv, {
			cwd: "/",
			stdout: "pipe",
			stderr: "ignore",
		});
		const timer = setTimeout(() => child.kill(), 5000);
		const [text, code] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		clearTimeout(timer);
		return code === 0 ? text.replaceAll("\r", "").trim() : null;
	} catch {
		return null;
	}
}

const CONFIG_FILE = "claude_desktop_config.json";

/**
 * Claude from the Microsoft Store may keep its settings inside its
 * package; that folder is the one it uses when it is there.
 */
export async function storeFolder(
	localAppData: string,
	join: (...parts: string[]) => string,
): Promise<string | null> {
	const packages = join(localAppData, "Packages");
	const names = await readdir(packages).catch(() => [] as string[]);
	for (const name of names.filter((n) => n.startsWith("Claude_"))) {
		const folder = join(packages, name, "LocalCache", "Roaming", "Claude");
		if (await exists(folder)) return folder;
	}
	return null;
}

/**
 * How agents start `hatchlight mcp` for this installation: this same program
 * (a compiled one by itself, Bun with this script otherwise), on the same
 * data and with the same resources, and where Claude Desktop keeps its
 * settings on this system.
 */
export async function agentsSetup(options: {
	/** Given when the server was told its data directory. */
	dataDir?: string;
	resources?: string;
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	home?: string;
	/** The program that runs Hatchlight; this one by default. */
	program?: string;
	/**
	 * Set when this is the npm package. bunx runs it from a temporary folder
	 * that can be cleared, so agents start it with bunx too, by this name.
	 */
	npmPackage?: string;
}): Promise<AgentsSetup> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? env.HOME ?? env.USERPROFILE ?? "";
	const compiled = /\$bunfs|~BUN/.test(Bun.main);
	// Agents start it from anywhere: every path is made whole.
	const dataDir = options.dataDir
		? ["--data-dir", resolve(options.dataDir)]
		: [];
	const code: Launch = options.npmPackage
		? { command: "bunx", args: [options.npmPackage, "mcp", ...dataDir] }
		: {
				command: options.program ?? process.execPath,
				args: [
					...(compiled ? [] : [Bun.main]),
					"mcp",
					...dataDir,
					...(options.resources
						? ["--resources", resolve(options.resources)]
						: []),
				],
			};
	// The places it was told to keep things go with it, under the new
	// names even when they were set under the old ones.
	const kept = Object.fromEntries(
		["DATA_DIR", "MODELS_DIR"].flatMap((suffix) => {
			const value = appEnv(env, suffix);
			return value ? [[envVariable(APP_NAME, suffix), resolve(value)]] : [];
		}),
	);
	if (Object.keys(kept).length > 0) code.env = kept;

	if (platform === "win32") {
		const join = (...parts: string[]) =>
			parts.map(withoutTrailingBackslashes).join("\\");
		const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
		const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
		const folder = (await storeFolder(local, join)) ?? join(appData, "Claude");
		const program = wslPath(code.command);
		return {
			code,
			...(program && {
				codeInWsl: {
					command: program,
					args: code.args,
					// Passed on to the Windows program as they are: Windows paths.
					...(code.env && {
						env: {
							...code.env,
							WSLENV: Object.keys(code.env).join(":"),
						},
					}),
				},
			}),
			desktop: code,
			shell: "powershell",
			claudeDesktopConfig: join(folder, CONFIG_FILE),
		};
	}
	if (platform === "darwin") {
		return {
			code,
			desktop: code,
			shell: "posix",
			claudeDesktopConfig: `${home}/Library/Application Support/Claude/${CONFIG_FILE}`,
		};
	}
	const distro = env.WSL_DISTRO_NAME;
	if (distro) {
		// Claude Desktop runs on the Windows side and reaches this one
		// through wsl.exe; -e runs the program itself, without a shell that
		// would split or expand its arguments. Windows' environment is not
		// passed along, so env sets what is kept.
		const unix = async (variable: string) => {
			const windows = await output(["cmd.exe", "/c", "echo", `%${variable}%`]);
			return windows && !windows.includes("%")
				? await output(["wslpath", "-u", windows])
				: null;
		};
		const [appData, local] = await Promise.all([
			unix("APPDATA"),
			unix("LOCALAPPDATA"),
		]);
		const join = (...parts: string[]) => parts.join("/");
		const folder =
			(local && (await storeFolder(local, join))) ??
			(appData ? join(appData, "Claude") : null);
		const pairs = Object.entries(kept).map(([key, value]) => `${key}=${value}`);
		return {
			code,
			desktop: {
				command: "wsl.exe",
				args: [
					"-d",
					distro,
					"-e",
					...(pairs.length > 0 ? ["env", ...pairs] : []),
					code.command,
					...code.args,
				],
			},
			shell: "posix",
			claudeDesktopConfig: folder ? join(folder, CONFIG_FILE) : null,
		};
	}
	const config = env.XDG_CONFIG_HOME ?? `${home}/.config`;
	return {
		code,
		desktop: code,
		shell: "posix",
		claudeDesktopConfig: `${config}/Claude/${CONFIG_FILE}`,
	};
}

/** The path without the backslashes it ends with. A loop, where a regular
 * expression would take quadratic time on a long run of backslashes. */
function withoutTrailingBackslashes(path: string): string {
	let end = path.length;
	while (end > 0 && path[end - 1] === "\\") end--;
	return path.slice(0, end);
}
