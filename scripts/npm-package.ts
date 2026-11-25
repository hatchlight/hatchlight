/**
 * Builds the npm package `hatchlight` into dist/npm: the command line in one
 * file, and next to it what it reads from disk (the built UI and the
 * migrations). It runs on Bun, like the source: `bunx hatchlight mcp`.
 *
 * Build the UI first (`bun run build`). Then publish with
 * `npm publish dist/npm --access public`.
 */
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { APP_VERSION } from "../packages/core/src/version";
import registryEntry from "../server.json" with { type: "json" };

const root = join(import.meta.dir, "..");
const out = join(root, "dist", "npm");
const web = join(root, "apps", "web", "dist");

if (!(await stat(join(web, "index.html")).catch(() => null))) {
	throw new Error("Build the UI first: bun run build");
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await $`bun build ${join(root, "packages", "cli", "src", "index.ts")} --target=bun --minify --outfile ${join(out, "bin", "hatchlight.js")}`;
await cp(web, join(out, "resources", "web"), { recursive: true });
await cp(
	join(root, "packages", "core", "drizzle"),
	join(out, "resources", "drizzle"),
	{ recursive: true },
);
await cp(join(root, "LICENSE"), join(out, "LICENSE"));

const manifest = {
	name: "hatchlight",
	version: APP_VERSION,
	description:
		"Make pictures and videos with many AI models, side by side, on your own graphics card or with your own cloud keys. Includes an MCP server for AI agents.",
	keywords: [
		"mcp",
		"mcp-server",
		"stable-diffusion",
		"flux",
		"image-generation",
		"text-to-image",
		"local-ai",
	],
	homepage: "https://hatchlight.app",
	repository: {
		type: "git",
		url: "git+https://github.com/hatchlight/hatchlight.git",
	},
	bugs: "https://github.com/hatchlight/hatchlight/issues",
	license: "MIT",
	type: "module",
	bin: { hatchlight: "bin/hatchlight.js" },
	files: ["bin", "resources"],
	engines: { bun: ">=1.3" },
	// The official MCP Registry checks that the package names the same server.
	mcpName: registryEntry.name,
};
await writeFile(
	join(out, "package.json"),
	`${JSON.stringify(manifest, null, "\t")}\n`,
);

await writeFile(
	join(out, "README.md"),
	`# Hatchlight

Make pictures and videos with many AI models, side by side. Run them on your
own graphics card for free, or use the services you already pay for with your
own keys. Open source, no account, no telemetry.

This package is Hatchlight's command line, and it runs on
[Bun](https://bun.sh). For the desktop app, see
[hatchlight.app](https://hatchlight.app).

## Use it from an AI agent

\`hatchlight mcp\` lets an agent that speaks the
[Model Context Protocol](https://modelcontextprotocol.io), such as Claude Code,
make pictures and videos with your models:

\`\`\`sh
claude mcp add hatchlight -- bunx hatchlight mcp
\`\`\`

It uses the Hatchlight already running, or starts one that stops with the
agent. By default only models on your computer are used, so it costs nothing;
\`--allow-paid --spend-limit 5\` also lets it use your cloud keys, up to $5 per
connection. Agents cannot install models: you do, in the app.

## Run the app

\`\`\`sh
bunx hatchlight
\`\`\`

starts Hatchlight and opens it in your browser. \`bunx hatchlight --help\`
lists the other commands.

More: https://github.com/hatchlight/hatchlight
`,
);

console.log(`hatchlight ${APP_VERSION}: ${out}`);
