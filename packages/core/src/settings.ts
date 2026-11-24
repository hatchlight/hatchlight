import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	isImproveWith,
	isTranslateWith,
	type Settings,
	type UserContext,
} from "./types";

/** Nothing is spent until asked: the model on this computer, if installed. */
export const DEFAULT_SETTINGS: Settings = {
	translateWith: "local",
	improveWith: "auto",
	assistantWith: "auto",
};

export interface SettingsStore {
	get(ctx: UserContext): Promise<Settings>;
	set(ctx: UserContext, change: Partial<Settings>): Promise<Settings>;
}

type SettingsFile = Record<string, Partial<Settings>>;

/** Settings in a JSON file, one entry per user. */
export class FileSettingsStore implements SettingsStore {
	/** Serializes changes so concurrent ones cannot overwrite each other. */
	private pending: Promise<unknown> = Promise.resolve();

	constructor(private path: string) {}

	private async read(): Promise<SettingsFile> {
		const file = Bun.file(this.path);
		if (!(await file.exists())) return {};
		return (await file.json().catch(() => ({}))) as SettingsFile;
	}

	async get(ctx: UserContext): Promise<Settings> {
		const mine = (await this.read())[ctx.userId] ?? {};
		return {
			translateWith: isTranslateWith(mine.translateWith)
				? mine.translateWith
				: DEFAULT_SETTINGS.translateWith,
			improveWith: isImproveWith(mine.improveWith)
				? mine.improveWith
				: DEFAULT_SETTINGS.improveWith,
			assistantWith: isImproveWith(mine.assistantWith)
				? mine.assistantWith
				: DEFAULT_SETTINGS.assistantWith,
		};
	}

	set(ctx: UserContext, change: Partial<Settings>): Promise<Settings> {
		const next = this.pending.then(async () => {
			const data = await this.read();
			data[ctx.userId] = { ...data[ctx.userId], ...change };
			await mkdir(dirname(this.path), { recursive: true });
			// Written aside and renamed, so a crash cannot leave it half written.
			const tmp = `${this.path}.${crypto.randomUUID()}.tmp`;
			await writeFile(tmp, JSON.stringify(data, null, 2));
			await rename(tmp, this.path);
			return this.get(ctx);
		});
		this.pending = next.catch(() => {});
		return next;
	}

	/** Gives `from`'s choices to `to`, unless `to` already made some. */
	moveUser(from: string, to: string): Promise<void> {
		const next = this.pending.then(async () => {
			const data = await this.read();
			if (!Object.hasOwn(data, from) || Object.hasOwn(data, to)) return;
			data[to] = data[from] as Partial<Settings>;
			delete data[from];
			await mkdir(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.${crypto.randomUUID()}.tmp`;
			await writeFile(tmp, JSON.stringify(data, null, 2));
			await rename(tmp, this.path);
		});
		this.pending = next.catch(() => {});
		return next;
	}
}
