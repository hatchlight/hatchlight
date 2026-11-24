/**
 * Puts the Linux engines into a folder for the Docker image, as
 * HATCHLIGHT_ENGINES_DIR expects them: `<dir>/<build id>/<executable>`.
 * The archives, their sizes and hashes come from the catalog, so the image
 * holds exactly what the app would download, checked the same way.
 *
 * Usage: bun scripts/docker-engines.ts <dir>
 *
 * It needs only these two files beside it (no dependencies installed), so the
 * Dockerfile can run it in a stage of its own that changes with the catalog.
 */
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { extractTarGz } from "../packages/core/src/local/tar.ts";
import { builtinEngines } from "../packages/providers/src/engines.ts";

const [dir] = process.argv.slice(2);
if (!dir) {
	console.error("Usage: bun scripts/docker-engines.ts <dir>");
	process.exit(2);
}

const builds = builtinEngines()
	.flatMap((engine) => engine.builds)
	.filter((build) => build.os === "linux" && build.arch === "x64");
if (builds.length === 0) throw new Error("The catalog has no linux-x64 build");

await mkdir(dir, { recursive: true });
for (const build of builds) {
	const tmp = join(dir, `${build.id}.tmp`);
	await rm(tmp, { recursive: true, force: true });
	for (const file of build.files) {
		const response = await fetch(file.url);
		if (!response.ok) {
			throw new Error(
				`Could not download ${file.url} (HTTP ${response.status})`,
			);
		}
		const data = new Uint8Array(await response.arrayBuffer());
		const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex");
		if (data.byteLength !== file.size || sha256 !== file.sha256) {
			throw new Error(
				`${file.name} is not the archive the catalog names: ${data.byteLength} bytes, sha256 ${sha256}`,
			);
		}
		const archive = join(dir, file.name);
		await Bun.write(archive, data);
		await extractTarGz(archive, tmp);
		await rm(archive);
	}
	await chmod(join(tmp, ...build.executable.split("/")), 0o755);
	await rm(join(dir, build.id), { recursive: true, force: true });
	await rename(tmp, join(dir, build.id));
	console.log(`${build.id}: ${build.files.map((f) => f.name).join(", ")}`);
}
