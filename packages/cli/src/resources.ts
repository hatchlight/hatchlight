import { existsSync } from "node:fs";
import { join } from "node:path";
import { plainPath } from "@hatchlight/core";

/**
 * Where the built UI (web/) and the database migrations (drizzle/) are.
 * `--resources` names the folder, as the desktop app and the Docker image do.
 * Without it, the npm package finds the folder it ships next to its bundle;
 * a source checkout has none, and reads both from the source tree.
 */
export function resourcesDir(flag: string | undefined): string | undefined {
	if (flag) return plainPath(flag);
	const packaged = join(import.meta.dir, "..", "resources");
	const complete =
		existsSync(join(packaged, "drizzle")) &&
		existsSync(join(packaged, "web", "index.html"));
	return complete ? packaged : undefined;
}
