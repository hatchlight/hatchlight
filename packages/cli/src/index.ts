#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	appEnv,
	chosenModelsDir,
	clearServerInfo,
	defaultDataDir,
	defaultModelsDir,
	defaultTrainerDir,
	MAX_CHECKPOINT_BYTES,
	modelsLocationFile,
	SecretError,
	writeServerInfo,
} from "@hatchlight/core";
import { mcpOverHttp } from "@hatchlight/mcp";
import {
	Agents,
	agentsSetup,
	ConfigError,
	createApp,
	createRuntime,
	DataDirInUseError,
	localUrl,
	serverConfig,
	serveWeb,
} from "@hatchlight/server";
import { COMMANDS, commandList } from "./commands";
import { openInBrowser } from "./launcher";
import { resourcesDir } from "./resources";

const [first, ...rest] = process.argv.slice(2);

// An agent's connection: it has its own options, and never serves the app.
if (first === "mcp") {
	const { mcp } = await import("./mcp");
	await mcp(rest);
	process.exit(0);
}
// Accounts of a server, from its data directory, for an owner locked out.
if (first === "users") {
	const { users } = await import("./users");
	process.exit(await users(rest));
}

// A backup of a server's data directory, or putting one back.
if (first === "backup" || first === "restore") {
	const { backup, restore } = await import("./backup");
	process.exit(await (first === "backup" ? backup : restore)(rest));
}

// A command typed in a terminal: it uses the server, and never serves the app.
if (first != null && Object.hasOwn(COMMANDS, first)) {
	const { runCommand } = await import("./client");
	process.exit(await runCommand(first, rest));
}

if (first != null && !first.startsWith("-") && first !== "serve") {
	console.error(
		`Unknown command: ${first}\nSee the commands with: hatchlight --help`,
	);
	process.exit(2);
}

const HELP = `Hatchlight — one interface for many image generation models

Usage: hatchlight [serve] [options]   Start the app
       hatchlight <command> [options]

Commands (see hatchlight <command> --help):
${commandList()}
  mcp       Connect an AI agent
  users     Manage a server's accounts, from its data directory
  backup    Save a server's data in one file
  restore   Put a backup back, with the server stopped

Options for serve:
  --port <n>       Port to listen on (default 4096; 0 picks a free one)
  --mode <m>       personal: one person on this computer (default)
                   server: several people over the network; needs
                   HATCHLIGHT_PUBLIC_URL, and reads HATCHLIGHT_ALLOWED_HOSTS,
                   HATCHLIGHT_TRUSTED_PROXIES, and the LoRAs each member
                   may add: HATCHLIGHT_LORA_FILES_PER_PERSON (default 20)
                   and HATCHLIGHT_LORA_GB_PER_PERSON (default 10), and the
                   room each member's pictures may take:
                   HATCHLIGHT_ASSET_GB_PER_PERSON (unset: no limit)
  --host <a>       Address to listen on (default 127.0.0.1, or 0.0.0.0 in
                   server mode)
  --data-dir <p>   Where sessions, images and keys are stored
                   (default ${defaultDataDir()}). API keys are encrypted
                   with HATCHLIGHT_SECRET_FILE, or secret.key made there
  --dev            Accept requests from the Vite dev server and skip the UI
  --no-open        Do not open the browser
  --resources <p>  Where a packaged app keeps the built UI (web/) and the
                   database migrations (drizzle/)
  --parent-pid <n> Stop when the process with this id ends, such as the
                   desktop app that started this server, or when it closes
                   this server's standard input
  -h, --help       Show this help
`;

const { values } = parseArgs({
	args: first === "serve" ? rest : process.argv.slice(2),
	options: {
		port: { type: "string", default: "4096" },
		mode: { type: "string" },
		host: { type: "string" },
		"data-dir": { type: "string" },
		dev: { type: "boolean", default: false },
		"no-open": { type: "boolean", default: false },
		resources: { type: "string" },
		"parent-pid": { type: "string" },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (values.help) {
	console.log(HELP);
	process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	console.error(`Invalid port: ${values.port}`);
	process.exit(1);
}

let config: ReturnType<typeof serverConfig>;
try {
	config = serverConfig({ mode: values.mode, host: values.host }, process.env);
} catch (error) {
	if (!(error instanceof ConfigError)) throw error;
	console.error(`${error.message}.`);
	process.exit(1);
}
const server = config.transport;

const parentPid =
	values["parent-pid"] == null ? null : Number(values["parent-pid"]);
if (parentPid != null && !(Number.isInteger(parentPid) && parentPid > 0)) {
	console.error(`Invalid parent process id: ${values["parent-pid"]}`);
	process.exit(1);
}

const resources = resourcesDir(values.resources);

// A compiled binary has no source tree around it, so it is told where things are.
const WEB_DIST = resources
	? join(resources, "web")
	: join(import.meta.dir, "..", "..", "..", "apps", "web", "dist");
const migrationsDir = resources ? join(resources, "drizzle") : undefined;
const dataDir = values["data-dir"] ?? defaultDataDir();
// An explicit data directory keeps everything inside it, models included,
// unless HATCHLIGHT_MODELS_DIR names another place for them. So does a
// server: its folder is not chosen from a browser. Otherwise the folder can
// be changed in the app, and every Hatchlight sharing the default one follows
// that choice.
const fixedModelsDir =
	appEnv(process.env, "MODELS_DIR") ??
	(values["data-dir"] || server ? join(dataDir, "models") : null);
const defaultModels = fixedModelsDir ? null : await defaultModelsDir(dataDir);
const modelsDir =
	fixedModelsDir ?? (await chosenModelsDir(defaultModels as string));
const runtime = await createRuntime({
	dataDir,
	modelsDir,
	trainerDir: defaultTrainerDir(dataDir),
	modelsLocationFile: defaultModels
		? modelsLocationFile(defaultModels)
		: undefined,
	migrationsDir,
	server: server != null,
	assetQuotaBytes: config.assetQuotaBytes,
}).catch((error) => {
	// Said plainly: another server on the folder, or keys under another secret.
	if (!(error instanceof DataDirInUseError || error instanceof SecretError)) {
		throw error;
	}
	console.error(`${error.message}.`);
	process.exit(1);
});
/** The largest MCP request read: tool calls are small JSON. */
const MAX_MCP_BODY_BYTES = 1024 * 1024;
const app = createApp({
	...runtime,
	allowedOrigins: values.dev ? ["http://localhost:5173"] : [],
	server: server ?? undefined,
	// Agents with a token reach a server at /mcp; each of their tool calls
	// goes through this server's own API, as that token.
	mcp: server
		? mcpOverHttp({
				fetch: (request) =>
					Promise.resolve(app.fetch(request, { peer: "127.0.0.1" })),
				maxBodyBytes: MAX_MCP_BODY_BYTES,
			})
		: undefined,
	loraQuota: config.loraQuota ?? undefined,
	agents: new Agents(() =>
		agentsSetup(
			// The npm package finds its own resources; agents run it by name.
			!values.resources && resources
				? { dataDir: values["data-dir"], npmPackage: "hatchlight" }
				: { dataDir: values["data-dir"], resources },
		),
	),
});

if (!values.dev) {
	if (!(await Bun.file(join(WEB_DIST, "index.html")).exists())) {
		console.error("The web UI is not built. Run `bun run build` first.");
		runtime.close();
		process.exit(1);
	}
	serveWeb(app, WEB_DIST);
}

// Loopback only, unless in server mode: the server holds API keys.
function listen() {
	try {
		return Bun.serve({
			hostname: config.host,
			port,
			idleTimeout: 0, // the event stream stays open
			// Models and LoRAs are added through the server; the app limits
			// the other routes.
			maxRequestBodySize: MAX_CHECKPOINT_BYTES,
			// The app checks the connection's address against trusted proxies.
			fetch: (request, bun) =>
				app.fetch(request, { peer: bun.requestIP(request)?.address }),
		});
	} catch (error) {
		if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
		console.error(
			`Port ${port} is already in use. Choose another with --port.`,
		);
		runtime.close();
		process.exit(1);
	}
}
const listener = listen();
// Only now that this process owns the port and the data directory.
await runtime.start();
const url = server?.publicOrigin ?? `http://localhost:${listener.port}`;
// Other processes, such as `hatchlight mcp`, find this server here.
await writeServerInfo(dataDir, {
	pid: process.pid,
	url: localUrl(config.host, listener.port as number),
}).catch((error) => {
	console.error(`Agents will not find this server: ${error.message}`);
});
// Written straight to the descriptor, so the line is out at once: the
// desktop app waits for it before opening the window on this address.
const say = (line: string) => writeSync(1, `${line}\n`);
// The desktop app reads this line; a server also says where it listens.
say(`Hatchlight is running at ${url}`);
if (server) {
	say(`Listening on ${config.host}:${listener.port}`);
	// Only whoever can read this log can make the first account.
	const code = runtime.accounts.setupCode();
	if (code) {
		say("");
		say(`  Set up this server: open ${url} and enter the code ${code}`);
		say("  The code changes each time the server starts, until it is set up.");
		say("");
	}
}
say(`Data directory: ${dataDir}`);
if (modelsDir !== join(dataDir, "models")) {
	say(`Local models: ${modelsDir}`);
}

// A server runs on a machine nobody sits at.
if (!values.dev && !values["no-open"] && !server) openInBrowser(url);

let stopping = false;
async function shutdown(): Promise<void> {
	// Input closing, the parent going and a signal can each ask; once is enough.
	if (stopping) return;
	stopping = true;
	listener.stop(true);
	await clearServerInfo(dataDir).catch(() => {});
	runtime.close();
	process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, shutdown);
}

// The desktop app stops this server by closing its input, which lets it shut
// down cleanly on every system. If the app dies instead, the server must not
// linger holding the data directory and the port.
if (parentPid != null) {
	void (async () => {
		for await (const _ of Bun.stdin.stream()) {
			// Nothing is sent; only the end matters.
		}
		void shutdown();
	})();
	setInterval(() => {
		try {
			process.kill(parentPid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") void shutdown();
		}
	}, 2000);
}
