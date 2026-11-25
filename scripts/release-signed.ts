/**
 * Puts installers signed after the build back into a draft release: the
 * files, their new update signatures, and latest.json pointing at both. Used
 * by .github/workflows/desktop.yml once SignPath has signed the Windows
 * installers.
 *
 *   bun scripts/release-signed.ts <tag> <folder of signed files>
 *
 * Each `<file>.sig` must sit next to its file (made by `tauri signer sign`).
 * Needs `gh` with a token that can write to the release (GH_TOKEN).
 */
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

interface Platform {
	signature: string;
	url: string;
}

export interface LatestJson {
	platforms: Record<string, Platform>;
	[key: string]: unknown;
}

/** The file an update signature was made for: Tauri writes it in its comment. */
export function signedFileOf(signature: string): string | null {
	const text = Buffer.from(signature, "base64").toString("utf8");
	return /\tfile:([^\t\n]+)/.exec(text)?.[1] ?? null;
}

/**
 * latest.json with the platforms whose file was replaced pointing at the new
 * asset and signature. Throws when a replaced file is in no platform, since
 * then the updater would still offer the old one.
 */
export function withReplaced(
	latest: LatestJson,
	replaced: Map<string, { signature: string; url: string }>,
): LatestJson {
	const seen = new Set<string>();
	const platforms: Record<string, Platform> = {};
	for (const [name, platform] of Object.entries(latest.platforms)) {
		const file = signedFileOf(platform.signature);
		const next = file ? replaced.get(file) : undefined;
		if (file && next) seen.add(file);
		platforms[name] = next ?? platform;
	}
	const missing = [...replaced.keys()].filter((file) => !seen.has(file));
	if (missing.length > 0) {
		throw new Error(`No platform in latest.json has ${missing.join(", ")}`);
	}
	return { ...latest, platforms };
}

async function gh(...args: string[]): Promise<string> {
	const child = Bun.spawn(["gh", ...args], {
		stdout: "pipe",
		stderr: "inherit",
	});
	const output = await new Response(child.stdout).text();
	if ((await child.exited) !== 0)
		throw new Error(`gh ${args[0]} ${args[1]} failed`);
	return output;
}

async function main(tag: string, folder: string): Promise<void> {
	const files = (await readdir(folder))
		.filter((name) => !name.endsWith(".sig"))
		.map((name) => join(folder, name));
	if (files.length === 0) throw new Error(`Nothing signed in ${folder}`);
	await gh(
		"release",
		"upload",
		tag,
		"--clobber",
		...files.flatMap((file) => [file, `${file}.sig`]),
	);

	// Replaced assets get new ids, and latest.json points at assets by id.
	const { assets } = JSON.parse(
		await gh("release", "view", tag, "--json", "assets"),
	) as { assets: { name: string; apiUrl: string }[] };
	const replaced = new Map<string, { signature: string; url: string }>();
	for (const file of files) {
		const name = basename(file);
		const asset = assets.find((a) => a.name === name);
		if (!asset) throw new Error(`${name} is not in release ${tag}`);
		const signature = (await Bun.file(`${file}.sig`).text()).trim();
		replaced.set(name, { signature, url: asset.apiUrl });
	}

	const latest = JSON.parse(
		await gh(
			"release",
			"download",
			tag,
			"--pattern",
			"latest.json",
			"--output",
			"-",
		),
	) as LatestJson;
	const out = join(folder, "..", "latest.json");
	await Bun.write(
		out,
		`${JSON.stringify(withReplaced(latest, replaced), null, 2)}\n`,
	);
	await gh("release", "upload", tag, "--clobber", out);
	console.log(`Replaced ${[...replaced.keys()].join(", ")} in ${tag}`);
}

if (import.meta.main) {
	const [tag, folder] = process.argv.slice(2);
	if (!tag || !folder) {
		console.error("Usage: bun scripts/release-signed.ts <tag> <folder>");
		process.exit(2);
	}
	await main(tag, folder);
}
