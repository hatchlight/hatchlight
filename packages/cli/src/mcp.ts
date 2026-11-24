import { parseArgs } from "node:util";
import { defaultDataDir } from "@hatchlight/core";
import { runMcp, runRemoteMcp } from "@hatchlight/mcp";
import { launcher, serverArgs } from "./launcher";

const HELP = `hatchlight mcp — lets an AI agent make pictures and videos with Hatchlight

It speaks the Model Context Protocol on standard input and output. Add it to
an agent, e.g. Claude Code:  claude mcp add hatchlight -- hatchlight mcp

It uses the Hatchlight already running on the data directory, or starts one
that stops with it. Agents cannot install models; the user does, in the app.

With --url, it uses a Hatchlight server elsewhere instead, as the person an
API token belongs to (Settings > Use with AI agents). The token's own scopes
and spending limit apply; --allow-paid and --spend-limit add to them here.

Options:
  --data-dir <p>        The data directory (default ${defaultDataDir()})
  --url <origin>        A Hatchlight server's address (or HATCHLIGHT_URL)
  --token <t>           Its API token (or HATCHLIGHT_TOKEN, which other
                        programs on this computer cannot read in a process list)
  --insecure            Allow plain http to a server not on this computer
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
			url: { type: "string" },
			token: { type: "string" },
			insecure: { type: "boolean", default: false },
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
	const url = values.url ?? process.env.HATCHLIGHT_URL;
	const token = values.token ?? process.env.HATCHLIGHT_TOKEN;
	if (url || token) {
		if (!url || !token) {
			console.error(
				"A server elsewhere needs both its address and a token: --url and --token, or HATCHLIGHT_URL and HATCHLIGHT_TOKEN",
			);
			process.exit(1);
		}
		try {
			await runRemoteMcp({
				url,
				token,
				insecure: values.insecure,
				allowPaid: values["allow-paid"],
				spendLimitUsd: limit,
			});
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
		return;
	}
	await runMcp({
		dataDir: values["data-dir"] ?? defaultDataDir(),
		launcher: launcher(),
		serverArgs: serverArgs(values),
		allowPaid: values["allow-paid"],
		spendLimitUsd: limit,
	});
}
