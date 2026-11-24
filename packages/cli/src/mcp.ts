import { parseArgs } from "node:util";
import { defaultDataDir } from "@hatchlight/core";
import { runMcp } from "@hatchlight/mcp";
import { launcher, serverArgs } from "./launcher";

const HELP = `hatchlight mcp — lets an AI agent make pictures and videos with Hatchlight

It speaks the Model Context Protocol on standard input and output. Add it to
an agent, e.g. Claude Code:  claude mcp add hatchlight -- hatchlight mcp

It uses the Hatchlight already running on the data directory, or starts one
that stops with it. Agents cannot install models; the user does, in the app.

Options:
  --data-dir <p>        The data directory (default ${defaultDataDir()})
  --allow-paid          Also use paid cloud models, on the user's own keys
  --spend-limit <usd>   With --allow-paid: the most this connection may spend
  --resources <p>       For a packaged app: where its UI and migrations are
  -h, --help            Show this help
`;

/** Runs \`hatchlight mcp\` with its arguments. */
export async function mcp(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"data-dir": { type: "string" },
			"allow-paid": { type: "boolean", default: false },
			"spend-limit": { type: "string" },
			resources: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		// The protocol has not started: help can go to the output.
		console.log(HELP);
		return;
	}
	const limit =
		values["spend-limit"] == null ? null : Number(values["spend-limit"]);
	if (limit != null && !(Number.isFinite(limit) && limit >= 0)) {
		console.error(`Invalid spending limit: ${values["spend-limit"]}`);
		process.exit(1);
	}
	if (limit != null && !values["allow-paid"]) {
		console.error("--spend-limit only applies with --allow-paid");
		process.exit(1);
	}
	await runMcp({
		dataDir: values["data-dir"] ?? defaultDataDir(),
		launcher: launcher(),
		serverArgs: serverArgs(values),
		allowPaid: values["allow-paid"],
		spendLimitUsd: limit,
	});
}
