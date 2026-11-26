import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointShelf } from "./checkpoints";
import {
	detectLayout,
	installPlaces,
	LinkedFolders,
	type LinkedKind,
	lorasFolder,
} from "./linked";
import { LoraShelf } from "./loras";
import { safetensors } from "./testing";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function temporary(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-linked-"));
	dirs.push(dir);
	return dir;
}

const SDXL_LORA = ["lora_unet_input_blocks_4_1_proj_in.alpha"];
const SD1_LORA = ["lora_unet_down_blocks_0_attentions_0_proj_in.alpha"];
const SDXL = [
	"model.diffusion_model.input_blocks.0.0.weight",
	"conditioner.embedders.1.model.ln_final.weight",
	"first_stage_model.decoder.conv_in.weight",
];
const SD1 = [
	"model.diffusion_model.input_blocks.0.0.weight",
	"cond_stage_model.transformer.text_model.embeddings.position_ids",
	"first_stage_model.decoder.conv_in.weight",
];
/** A Flux model in one file: a family whose checkpoints are not run. */
const FLUX = ["model.diffusion_model.double_blocks.0.img_attn.qkv.weight"];

/** Writes files below `root`, making their folders. */
async function tree(root: string, files: Record<string, Uint8Array>) {
	for (const [path, data] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), data);
	}
}

/** A ComfyUI install with a model, a LoRA in a subfolder and two it cannot use. */
async function comfyui(root: string) {
	await tree(root, {
		"models/checkpoints/juggernautXL.safetensors": safetensors(SDXL),
		"models/checkpoints/flux1-dev.safetensors": safetensors(FLUX),
		"models/loras/styles/Ink Style.safetensors": safetensors(SDXL_LORA),
		"models/loras/broken.safetensors": new Uint8Array([1, 2, 3]),
		"models/loras/notes.txt": new TextEncoder().encode("not a model"),
	});
}

/** The shelves as the store wires them, around one models folder. */
async function setup(file?: string) {
	const models = await temporary();
	const changes: LinkedKind[] = [];
	const shelves: { loras?: LoraShelf; checkpoints?: CheckpointShelf } = {};
	const folders = new LinkedFolders({
		file,
		root: () => models,
		ownIds: {
			lora: async () => (await shelves.loras?.ownIds()) ?? [],
			checkpoint: async () => (await shelves.checkpoints?.ownIds()) ?? [],
		},
		changed: (kind) => changes.push(kind),
	});
	const loras = new LoraShelf({
		root: () => models,
		linked: folders.loras,
	});
	const checkpoints = new CheckpointShelf({
		root: () => models,
		linked: folders.checkpoints,
	});
	shelves.loras = loras;
	shelves.checkpoints = checkpoints;
	return { models, folders, loras, checkpoints, changes };
}

describe("telling an app's folder", () => {
	test("ComfyUI, A1111 or Forge, and Stability Matrix, whatever the case", async () => {
		const root = await temporary();
		await tree(root, {
			"ComfyUI/models/checkpoints/a.safetensors": safetensors(SDXL),
			"ComfyUI/models/loras/b.safetensors": safetensors(SDXL_LORA),
			"webui/models/stable-diffusion/a.safetensors": safetensors(SDXL),
			"webui/models/LORA/b.safetensors": safetensors(SDXL_LORA),
			"StabilityMatrix/Data/Models/StableDiffusion/a.safetensors":
				safetensors(SDXL),
			"StabilityMatrix/Data/Models/Lora/b.safetensors": safetensors(SDXL_LORA),
		});
		const comfy = await detectLayout(join(root, "ComfyUI"));
		expect(comfy.app).toBe("comfyui");
		expect(comfy.dirs).toEqual([
			{ dir: join(root, "ComfyUI/models/checkpoints"), kind: "checkpoint" },
			{ dir: join(root, "ComfyUI/models/loras"), kind: "lora" },
		]);
		// Its models folder, or its portable package, are the same app.
		expect((await detectLayout(join(root, "ComfyUI/models"))).app).toBe(
			"comfyui",
		);
		expect((await detectLayout(root)).app).toBe("comfyui");
		const webui = await detectLayout(join(root, "webui"));
		expect(webui.app).toBe("a1111");
		expect(webui.dirs.map((d) => d.dir)).toEqual([
			join(root, "webui/models/stable-diffusion"),
			join(root, "webui/models/LORA"),
		]);
		// Its Data folder has a Models folder too, which A1111's could match.
		for (const path of ["StabilityMatrix", "StabilityMatrix/Data"]) {
			expect((await detectLayout(join(root, path))).app).toBe(
				"stabilityMatrix",
			);
		}
	});

	test("Forge Neo is read with A1111's layout", async () => {
		const root = await temporary();
		await tree(root, {
			"sd-webui-forge-neo/models/Stable-diffusion/a.safetensors":
				safetensors(SDXL),
			"sd-webui-forge-neo/models/Lora/b.safetensors": safetensors(SDXL_LORA),
		});
		const neo = await detectLayout(join(root, "sd-webui-forge-neo"));
		expect(neo.app).toBe("a1111");
		expect(neo.dirs.map((d) => d.dir)).toEqual([
			join(root, "sd-webui-forge-neo/models/Stable-diffusion"),
			join(root, "sd-webui-forge-neo/models/Lora"),
		]);
	});

	test("SwarmUI is told from A1111 by its launch script", async () => {
		const root = await temporary();
		await tree(root, {
			"SwarmUI/launch-linux.sh": new Uint8Array(),
			"SwarmUI/Models/Stable-Diffusion/a.safetensors": safetensors(SDXL),
			"SwarmUI/Models/Lora/b.safetensors": safetensors(SDXL_LORA),
			"Other/Models/Stable-Diffusion/a.safetensors": safetensors(SDXL),
			"Other/Models/Lora/b.safetensors": safetensors(SDXL_LORA),
		});
		const swarm = await detectLayout(join(root, "SwarmUI"));
		expect(swarm.app).toBe("swarmui");
		expect(swarm.dirs).toEqual([
			{
				dir: join(root, "SwarmUI/Models/Stable-Diffusion"),
				kind: "checkpoint",
			},
			{ dir: join(root, "SwarmUI/Models/Lora"), kind: "lora" },
		]);
		// Without its launch script the same folders are A1111's.
		expect((await detectLayout(join(root, "Other"))).app).toBe("a1111");
	});

	test("any other folder is read whole", async () => {
		const root = await temporary();
		expect(await detectLayout(root)).toEqual({
			app: null,
			dirs: [{ dir: root, kind: null }],
		});
	});

	test("suggestions are the usual places", () => {
		const places = installPlaces(["/home/ana"], ["/mnt/c"], (...parts) =>
			parts.join("/"),
		);
		expect(places).toContain("/home/ana/ComfyUI");
		expect(places).toContain("/home/ana/.config/StabilityMatrix");
		expect(places).toContain("/mnt/c/ComfyUI_windows_portable/ComfyUI");
		expect(places).toContain("/home/ana/sd-webui-forge-neo");
		expect(places).toContain("/home/ana/SwarmUI");
		expect(places).toContain("/mnt/c/SwarmUI");
	});
});

describe("linked folders", () => {
	test("a folder's models show on the shelves, used where they are", async () => {
		const { folders, loras, checkpoints, changes } = await setup();
		const app = await temporary();
		await comfyui(app);
		const folder = await folders.add(app);
		expect(folder).toMatchObject({
			path: app,
			app: "comfyui",
			available: true,
			checkpoints: 1,
			loras: 1,
			skipped: { unknown: 1, unreadable: 1, tooLarge: 0 },
			truncated: false,
		});
		expect(changes.sort()).toEqual(["checkpoint", "lora"]);
		const [lora] = await loras.list();
		expect(lora).toMatchObject({
			id: "ink-style",
			name: "Ink Style",
			base: "sdxl",
			linked: { folder: folder.id, app: "comfyui" },
		});
		expect(loras.path("ink-style")).toBe(
			join(app, "models/loras/styles/Ink Style.safetensors"),
		);
		const [model] = await checkpoints.list();
		expect(model).toMatchObject({
			id: "juggernautxl",
			base: "sdxl",
			steps: 30,
		});
		expect(checkpoints.path("juggernautxl")).toBe(
			join(app, "models/checkpoints/juggernautXL.safetensors"),
		);
		expect(await folders.list()).toEqual([folder]);
	});

	test("a file too large for its kind is skipped without being read", async () => {
		const { folders } = await setup();
		const app = await temporary();
		await mkdir(join(app, "models/loras"), { recursive: true });
		// Sparse: it takes no room on disk.
		const big = await open(join(app, "models/loras/huge.safetensors"), "w");
		await big.truncate(5 * 1024 ** 3);
		await big.close();
		expect((await folders.add(app)).skipped).toEqual({
			unknown: 0,
			unreadable: 0,
			tooLarge: 1,
		});
	});

	test("ids never clash with the shelf's own, nor each other's", async () => {
		const { folders, loras } = await setup();
		await loras.add(
			new Blob([safetensors(SDXL_LORA)]),
			"Ink Style.safetensors",
		);
		const one = await temporary();
		const two = await temporary();
		for (const app of [one, two]) {
			await tree(app, {
				"models/loras/Ink Style.safetensors": safetensors(SD1_LORA),
			});
		}
		await folders.add(one);
		await folders.add(two);
		const ids = (await loras.list()).map((l) => l.id).sort();
		expect(ids).toEqual(["ink-style", "ink-style-2", "ink-style-3"]);
		// A new file of the shelf's own does not take a linked one's id.
		const added = await loras.add(
			new Blob([safetensors(SDXL_LORA)]),
			"Ink Style.safetensors",
		);
		expect(added.id).toBe("ink-style-4");
	});

	test("ids stay across looks, and when the other app renames a file", async () => {
		const file = join(await temporary(), "model-folders.json");
		const { folders, loras } = await setup(file);
		const app = await temporary();
		await comfyui(app);
		await folders.add(app);
		await folders.rescan();
		expect((await loras.list()).map((l) => l.id)).toEqual(["ink-style"]);
		await rename(
			join(app, "models/loras/styles/Ink Style.safetensors"),
			join(app, "models/loras/ink_v2.safetensors"),
		);
		await folders.rescan();
		expect((await loras.list()).map((l) => l.id)).toEqual(["ink-style"]);
		expect(loras.path("ink-style")).toBe(
			join(app, "models/loras/ink_v2.safetensors"),
		);
		// Read back from the file, as after a restart.
		const again = await setup(file);
		expect((await again.loras.list()).map((l) => l.id)).toEqual(["ink-style"]);
	});

	test("a file is read again only when its size or time changed", async () => {
		const { folders, loras } = await setup();
		const app = await temporary();
		const path = join(app, "models/loras/ink.safetensors");
		const titled = (title: string) =>
			safetensors(SDXL_LORA, { "modelspec.title": title });
		await tree(app, { "models/loras/ink.safetensors": titled("Ink Style") });
		await folders.add(app);
		const { mtime } = await stat(path);
		// Same size and time, other notes: what was read is kept.
		await writeFile(path, titled("Ink Stylf"));
		await utimes(path, mtime, mtime);
		await folders.rescan();
		expect((await loras.get("ink-style")).name).toBe("Ink Style");
		// Another size: read again, under the same id.
		await writeFile(path, titled("Ink"));
		await folders.rescan();
		expect((await loras.get("ink-style")).name).toBe("Ink");
	});

	test("another app's file is never deleted from here", async () => {
		const { folders, loras, checkpoints } = await setup();
		const app = await temporary();
		await comfyui(app);
		await folders.add(app);
		await expect(loras.remove("ink-style")).rejects.toMatchObject({
			code: "modelLinked",
		});
		await expect(checkpoints.remove("juggernautxl")).rejects.toMatchObject({
			code: "modelLinked",
		});
		expect(await readdir(join(app, "models/checkpoints"))).toContain(
			"juggernautXL.safetensors",
		);
	});

	test("a linked model's settings change, and are kept", async () => {
		const file = join(await temporary(), "model-folders.json");
		const { folders, checkpoints } = await setup(file);
		const app = await temporary();
		await comfyui(app);
		await folders.add(app);
		const changed = await checkpoints.update("juggernautxl", {
			steps: 8,
			cfgScale: 2,
		});
		expect(changed).toMatchObject({ steps: 8, cfgScale: 2, linked: {} });
		await expect(
			checkpoints.update("juggernautxl", { steps: -1 }),
		).rejects.toMatchObject({ code: "checkpointSettingsInvalid" });
		await folders.rescan();
		const again = await setup(file);
		expect(await again.checkpoints.get("juggernautxl")).toMatchObject({
			steps: 8,
		});
	});

	test("a folder that went away hides its models until it is back", async () => {
		const { folders, loras, changes } = await setup();
		const parent = await temporary();
		const app = join(parent, "ComfyUI");
		await comfyui(app);
		await folders.add(app);
		await rename(app, join(parent, "away"));
		// Asked for before a look: not there, said as for a deleted file.
		await expect(loras.get("ink-style")).rejects.toMatchObject({
			code: "loraMissing",
		});
		changes.length = 0;
		const [folder] = await folders.rescan();
		expect(folder).toMatchObject({ available: false, loras: 1 });
		expect(await loras.list()).toEqual([]);
		expect(changes.sort()).toEqual(["checkpoint", "lora"]);
		await rename(join(parent, "away"), app);
		await folders.rescan();
		expect((await loras.list()).map((l) => l.id)).toEqual(["ink-style"]);
	});

	test("folders are checked before they are linked, and removed by id or path", async () => {
		const { folders, models, loras } = await setup();
		const app = await temporary();
		await comfyui(app);
		await expect(folders.add("models/loras")).rejects.toMatchObject({
			code: "folderNotAbsolute",
		});
		await expect(folders.add(join(app, "nope"))).rejects.toMatchObject({
			code: "modelFolderMissing",
		});
		await mkdir(join(models, "loras"), { recursive: true });
		for (const path of [models, join(models, "loras"), join(models, "..")]) {
			await expect(folders.add(path)).rejects.toMatchObject({
				code: "modelFolderInside",
			});
		}
		const folder = await folders.add(app);
		await expect(folders.add(`${app}/`)).rejects.toMatchObject({
			code: "modelFolderLinked",
		});
		await folders.remove(app);
		expect(await folders.list()).toEqual([]);
		expect(await loras.list()).toEqual([]);
		await folders.add(app);
		await expect(folders.remove(folder.id)).rejects.toMatchObject({
			code: "modelFolderNotFound",
		});
		const [again] = await folders.list();
		await folders.remove(again?.id ?? "");
		expect(await folders.list()).toEqual([]);
	});

	test("a plain folder is read whole, each file told by its header", async () => {
		const { folders, loras, checkpoints } = await setup();
		const app = await temporary();
		await tree(app, {
			"sd15/dreamshaper.safetensors": safetensors(SD1),
			"mine/ink.safetensors": safetensors(SDXL_LORA),
			"flux.safetensors": safetensors(FLUX),
		});
		expect(await folders.add(app)).toMatchObject({
			app: null,
			checkpoints: 1,
			loras: 1,
			skipped: { unknown: 1 },
		});
		expect((await checkpoints.list())[0]).toMatchObject({ base: "sd1" });
		expect((await loras.list())[0]).toMatchObject({ base: "sdxl" });
	});

	test("suggestions are installs found and not linked yet", async () => {
		const root = await temporary();
		await comfyui(join(root, "ComfyUI"));
		await mkdir(join(root, "empty"));
		const folders = new LinkedFolders({
			root: () => join(root, "hatchlight"),
			ownIds: { lora: async () => [], checkpoint: async () => [] },
			places: async () => [
				join(root, "ComfyUI"),
				join(root, "empty"),
				join(root, "missing"),
			],
		});
		expect(await folders.suggestions()).toEqual([
			{ path: join(root, "ComfyUI"), app: "comfyui" },
		]);
		await folders.add(join(root, "ComfyUI"));
		expect(await folders.suggestions()).toEqual([]);
	});
});

describe("a job's LoRA folder", () => {
	async function files() {
		const root = await temporary();
		const source = join(root, "ComfyUI/models/loras/Ink Style.safetensors");
		await tree(root, {
			"ComfyUI/models/loras/Ink Style.safetensors": safetensors(SDXL_LORA),
		});
		return {
			source,
			dir: join(root, "tmp/loras-job"),
			cache: join(root, "tmp/linked-loras"),
		};
	}

	test("holds a hard link to each file, under its id, until removed", async () => {
		const { source, dir, cache } = await files();
		const folder = await lorasFolder([{ id: "ink-style", path: source }], {
			dir,
			cache,
			throughWindows: false,
		});
		const linked = await stat(join(dir, "ink-style.safetensors"));
		expect(linked.ino).toBe((await stat(source)).ino);
		await folder.remove();
		expect(await stat(dir).catch(() => null)).toBeNull();
		expect(await stat(source).catch(() => null)).not.toBeNull();
	});

	test("on another drive, a symbolic link, but not for Windows engines", async () => {
		const { source, dir, cache } = await files();
		const symlinked: string[] = [];
		await lorasFolder([{ id: "ink-style", path: source }], {
			dir,
			cache,
			throughWindows: false,
			links: {
				link: async () => {
					throw new Error("EXDEV");
				},
				symlink: async (from) => {
					symlinked.push(from);
				},
			},
		});
		expect(symlinked).toEqual([source]);
		symlinked.length = 0;
		await lorasFolder([{ id: "ink-style", path: source }], {
			dir: `${dir}-2`,
			cache,
			throughWindows: true,
			links: {
				link: async (from, to) => {
					// Only the copy in the cache, on the same drive, links.
					if (from === source) throw new Error("EXDEV");
					await Bun.write(to, Bun.file(from));
				},
				symlink: async (from) => {
					symlinked.push(from);
				},
			},
		});
		expect(symlinked).toEqual([]);
	});

	test("last, a copy made once in the cache, linked from there", async () => {
		const { source, dir, cache } = await files();
		let copies = 0;
		const links = {
			link: async (from: string, to: string) => {
				if (from === source) throw new Error("EXDEV");
				const { link } = await import("node:fs/promises");
				await link(from, to);
			},
			symlink: async () => {
				throw new Error("EPERM");
			},
			copy: async (from: string, to: string) => {
				copies++;
				await Bun.write(to, Bun.file(from));
			},
		};
		for (const job of ["a", "b"]) {
			const folder = await lorasFolder([{ id: "ink-style", path: source }], {
				dir: `${dir}-${job}`,
				cache,
				throughWindows: true,
				links,
			});
			const [cached] = await readdir(join(cache, "ink-style"));
			expect(cached).toMatch(/^\d+-\d+\.safetensors$/);
			expect((await stat(join(folder.dir, "ink-style.safetensors"))).ino).toBe(
				(await stat(join(cache, "ink-style", cached ?? ""))).ino,
			);
			await folder.remove();
		}
		expect(copies).toBe(1);
		// The file changed: a new copy, and the old one goes.
		await writeFile(source, safetensors(SDXL_LORA, { changed: "yes" }));
		await utimes(source, new Date(2001, 1, 1), new Date(2001, 1, 1));
		await lorasFolder([{ id: "ink-style", path: source }], {
			dir: `${dir}-c`,
			cache,
			throughWindows: true,
			links,
		});
		expect(copies).toBe(2);
		expect(await readdir(join(cache, "ink-style"))).toHaveLength(1);
	});

	test("each LoRA's copies are its own: one never deletes another's", async () => {
		const { source, dir, cache } = await files();
		const links = {
			link: async (from: string, to: string) => {
				if (from === source) throw new Error("EXDEV");
				await Bun.write(to, Bun.file(from));
			},
			symlink: async () => {
				throw new Error("EPERM");
			},
		};
		// Another job's copy, still being written.
		await mkdir(join(cache, "foo"), { recursive: true });
		await writeFile(join(cache, "foo", "1-1.safetensors.x.part"), "");
		for (const id of ["foo", "foo-2"]) {
			await lorasFolder([{ id, path: source }], {
				dir: `${dir}-${id}`,
				cache,
				throughWindows: true,
				links,
			});
		}
		await writeFile(source, safetensors(SDXL_LORA, { changed: "yes" }));
		await lorasFolder([{ id: "foo", path: source }], {
			dir: `${dir}-again`,
			cache,
			throughWindows: true,
			links,
		});
		expect((await readdir(cache)).sort()).toEqual(["foo", "foo-2"]);
		expect(await readdir(join(cache, "foo-2"))).toHaveLength(1);
		const foo = await readdir(join(cache, "foo"));
		expect(foo).toContain("1-1.safetensors.x.part");
		expect(foo.filter((n) => n.endsWith(".safetensors"))).toHaveLength(1);
	});
});

describe("looking after the scratch folder", () => {
	test("copies of LoRAs no folder has, and folders of crashed jobs, go", async () => {
		const { folders, models } = await setup();
		const app = await temporary();
		await comfyui(app);
		const folder = await folders.add(app);
		const scratch = join(models, "tmp");
		const cache = join(scratch, "linked-loras");
		await mkdir(join(cache, "ink-style"), { recursive: true });
		await mkdir(join(cache, "gone"), { recursive: true });
		const crashed = join(scratch, `loras-${crypto.randomUUID()}`);
		const running = join(scratch, `loras-${crypto.randomUUID()}`);
		await mkdir(crashed);
		await mkdir(running);
		const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
		await utimes(crashed, old, old);
		await folders.rescan();
		expect(await readdir(cache)).toEqual(["ink-style"]);
		expect(await readdir(scratch)).not.toContain(
			crashed.slice(scratch.length + 1),
		);
		expect(await readdir(scratch)).toContain(running.slice(scratch.length + 1));
		await folders.remove(folder.id);
		expect(await readdir(cache)).toEqual([]);
	});
});

describe("where a look goes", () => {
	test("never through a link out of the folder, nor into Hatchlight's own", async () => {
		const { folders, loras, models } = await setup();
		await loras.add(new Blob([safetensors(SDXL_LORA)]), "Mine.safetensors");
		const outside = await temporary();
		await tree(outside, { "far.safetensors": safetensors(SDXL_LORA) });
		const app = await temporary();
		await tree(app, { "mine/near.safetensors": safetensors(SDXL_LORA) });
		const { symlink } = await import("node:fs/promises");
		await symlink(outside, join(app, "elsewhere"));
		await symlink(models, join(app, "hatchlight"));
		await symlink(app, join(app, "mine", "loop"));
		expect(await folders.add(app)).toMatchObject({ loras: 1 });
		expect((await loras.list()).map((l) => l.id).sort()).toEqual([
			"mine",
			"near",
		]);
	});

	test("a folder of an app may be a link to another drive", async () => {
		const { folders } = await setup();
		const drive = await temporary();
		await tree(drive, { "Ink.safetensors": safetensors(SDXL_LORA) });
		const app = await temporary();
		await mkdir(join(app, "models"));
		const { symlink } = await import("node:fs/promises");
		await symlink(drive, join(app, "models", "loras"));
		expect(await folders.add(app)).toMatchObject({ app: "comfyui", loras: 1 });
	});

	test("too many folders: it stops, and says so", async () => {
		const { folders } = await setup();
		const app = await temporary();
		await mkdir(join(app, "models", "loras"), { recursive: true });
		for (let n = 0; n < 5_001; n++) {
			await mkdir(join(app, "models", "loras", String(n)));
		}
		expect(await folders.add(app)).toMatchObject({ truncated: true });
	});

	test("a home folder or a drive is refused, unless it is an app's", async () => {
		const { folders } = await setup();
		const { homedir } = await import("node:os");
		const refused = await folders.add(homedir()).catch((error) => error);
		// Holding the test's models folder is refused first, where it is so.
		expect(["modelFolderTooBroad", "modelFolderInside"]).toContain(
			refused.code,
		);
	});

	test("a folder inside or holding one linked already is refused", async () => {
		const { folders } = await setup();
		const parent = await temporary();
		await comfyui(join(parent, "ComfyUI"));
		await folders.add(join(parent, "ComfyUI"));
		for (const path of [join(parent, "ComfyUI", "models"), parent]) {
			await expect(folders.add(path)).rejects.toMatchObject({
				code: "modelFolderOverlaps",
			});
		}
	});

	test("Stability Matrix wins a tie in its Data folder", async () => {
		const root = await temporary();
		await tree(root, {
			"Data/Models/Lora/a.safetensors": safetensors(SDXL_LORA),
		});
		expect((await detectLayout(join(root, "Data"))).app).toBe(
			"stabilityMatrix",
		);
	});

	test("an upload's id avoids linked ones before the list was read", async () => {
		const file = join(await temporary(), "model-folders.json");
		const first = await setup(file);
		const app = await temporary();
		await comfyui(app);
		await first.folders.add(app);
		const again = await setup(file);
		const added = await again.loras.add(
			new Blob([safetensors(SDXL_LORA)]),
			"Ink Style.safetensors",
		);
		expect(added.id).toBe("ink-style-2");
	});
});
