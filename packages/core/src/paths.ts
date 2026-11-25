import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { APP_NAME, appEnv, LEGACY_NAME } from "./legacy";
import { detectHardware } from "./local/hardware";

type Exists = (path: string) => boolean;

/**
 * The app's folder in `parent`, or the one under the old name while only
 * that one has `inside`: an install made before the rename keeps its
 * folder. It is never moved, since another process may be using it.
 */
export function appFolder(
	parent: string,
	path: typeof posix,
	exists: Exists,
	inside: string[],
): string {
	const current = path.join(parent, APP_NAME);
	const legacy = path.join(parent, LEGACY_NAME);
	const has = (folder: string) =>
		inside.some((name) => exists(path.join(folder, name)));
	return !has(current) && has(legacy) ? legacy : current;
}

/**
 * The data folder in `parent`: the one with a gallery, the new one first.
 * A new folder without one (made by a preview or a test run, say) does not
 * hide the gallery made before the rename; with no gallery anywhere, the
 * old folder is used while it is there.
 */
function dataFolder(
	parent: string,
	path: typeof posix,
	exists: Exists,
): string {
	const current = path.join(parent, APP_NAME);
	const legacy = path.join(parent, LEGACY_NAME);
	if (exists(path.join(current, `${APP_NAME}.sqlite`))) return current;
	if (exists(path.join(legacy, `${LEGACY_NAME}.sqlite`))) return legacy;
	return exists(legacy) ? legacy : current;
}

/** Directory for the database, assets and stored keys, where each system expects it. */
export function defaultDataDir(
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
	exists: Exists = existsSync,
): string {
	const explicit = appEnv(env, "DATA_DIR");
	if (explicit) return explicit;
	if (platform === "win32") {
		return dataFolder(
			env.APPDATA ?? win32.join(home, "AppData", "Roaming"),
			win32,
			exists,
		);
	}
	if (platform === "darwin") {
		return dataFolder(
			join(home, "Library", "Application Support"),
			posix,
			exists,
		);
	}
	return dataFolder(
		env.XDG_DATA_HOME ?? join(home, ".local", "share"),
		posix,
		exists,
	);
}

/**
 * What makes a folder the one holding the models: the models, or where they
 * were moved to. Anything else in it, such as a preview of the app, does not.
 */
const MODELS = ["models", "models-location.json"];

/**
 * `\\?\C:\...` turns into `C:\...`: in that form Windows takes no forward
 * slashes, and the libraries reading these folders join paths with them.
 */
export function plainPath(path: string): string {
	return /^\\\\\?\\[A-Za-z]:\\/.test(path) ? path.slice(4) : path;
}
async function output(argv: string[]): Promise<string | null> {
	try {
		const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
		const [text, code] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		return code === 0 ? text.replaceAll("\r", "").trim() : null;
	} catch {
		return null;
	}
}

/**
 * Directory for downloaded models and engines. On Windows it is the local
 * app data, never the roaming one that may be synced between computers.
 * Under WSL it is that same Windows folder: engines run there as Windows
 * programs, and they read files on the Linux side about twenty times slower.
 * So the desktop app and Hatchlight under WSL share what they download.
 */
export async function defaultModelsDir(
	dataDir: string,
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
	exists: Exists = existsSync,
): Promise<string> {
	const explicit = appEnv(env, "MODELS_DIR");
	if (explicit) return explicit;
	if (platform === "win32") {
		return env.LOCALAPPDATA
			? win32.join(appFolder(env.LOCALAPPDATA, win32, exists, MODELS), "models")
			: win32.join(dataDir, "models");
	}
	if (
		platform === "linux" &&
		(await detectHardware({ run: async () => null })).wsl
	) {
		const windows = await output(["cmd.exe", "/c", "echo", "%LOCALAPPDATA%"]);
		const linux =
			windows && !windows.includes("%")
				? await output(["wslpath", "-u", windows])
				: null;
		if (linux) return join(appFolder(linux, posix, exists, MODELS), "models");
	}
	return join(dataDir, "models");
}

/**
 * The home folders and drives other apps are often installed in: this
 * system's home and, under WSL, the Windows one with its C: drive, found as
 * the models folder is.
 */
export async function appHomes(
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): Promise<{ homes: string[]; drives: string[] }> {
	if (platform === "win32") {
		return { homes: [env.USERPROFILE ?? home], drives: ["C:\\"] };
	}
	if (
		platform === "linux" &&
		(await detectHardware({ run: async () => null })).wsl
	) {
		const windows = await output(["cmd.exe", "/c", "echo", "%USERPROFILE%"]);
		const linux =
			windows && !windows.includes("%")
				? await output(["wslpath", "-u", windows])
				: null;
		return { homes: [home, ...(linux ? [linux] : [])], drives: ["/mnt/c"] };
	}
	return { homes: [home], drives: [] };
}

/**
 * Where the LoRA trainer (Python, PyTorch and the training scripts) is
 * installed. Never the models folder: under WSL that folder is on the
 * Windows side, where a Linux Python environment runs too slowly, and the
 * trainer is a program of this system rather than a file to share.
 */
export function defaultTrainerDir(
	dataDir: string,
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
): string {
	const explicit = appEnv(env, "TRAINER_DIR");
	if (explicit) return explicit;
	// The local app data, not the roaming one: several gigabytes.
	if (platform === "win32" && env.LOCALAPPDATA) {
		return win32.join(env.LOCALAPPDATA, APP_NAME, "trainer");
	}
	return join(dataDir, "trainer");
}

/**
 * Where a models folder chosen by hand is written down: next to the default
 * one, so every Hatchlight that shares the default folder (the desktop app
 * and Hatchlight under WSL) follows the same choice.
 */
export function modelsLocationFile(defaultModelsDir: string): string {
	const path = /^[A-Za-z]:\\/.test(defaultModelsDir) ? win32 : posix;
	return path.join(path.dirname(defaultModelsDir), "models-location.json");
}

/**
 * A folder as written by any Hatchlight sharing the choice, as this system
 * names it: `D:\Models` is `/mnt/d/Models` under WSL, and back. Null when
 * this system cannot reach it.
 */
export function pathHere(
	path: string,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const drive = path.match(/^([A-Za-z]):[\\/](.*)$/);
	const mounted = path.match(/^\/mnt\/([a-z])(?:\/(.*))?$/);
	if (platform === "win32") {
		if (drive) return path;
		if (mounted) {
			return win32.join(
				`${mounted[1]?.toUpperCase()}:\\`,
				...(mounted[2] ?? "").split("/").filter(Boolean),
			);
		}
		return null;
	}
	if (drive) {
		// Only under WSL do Windows drives show, under /mnt.
		return platform === "linux"
			? posix.join(
					`/mnt/${drive[1]?.toLowerCase()}`,
					...(drive[2] ?? "").split(/[\\/]/).filter(Boolean),
				)
			: null;
	}
	return posix.isAbsolute(path) ? path : null;
}

/** How to write a folder down so the other side of WSL reads it too. */
export function portablePath(path: string): string {
	const mounted = path.match(/^\/mnt\/([a-z])(?:\/(.*))?$/);
	if (!mounted) return path;
	return win32.join(
		`${mounted[1]?.toUpperCase()}:\\`,
		...(mounted[2] ?? "").split("/").filter(Boolean),
	);
}

/** The models folder chosen by hand, if any, else the default one. */
export async function chosenModelsDir(
	defaultModelsDir: string,
	platform: NodeJS.Platform = process.platform,
): Promise<string> {
	const file = Bun.file(modelsLocationFile(defaultModelsDir));
	const chosen = await file
		.json()
		.then((body: { path?: unknown }) =>
			typeof body.path === "string" ? pathHere(body.path, platform) : null,
		)
		.catch(() => null);
	return chosen ?? defaultModelsDir;
}
