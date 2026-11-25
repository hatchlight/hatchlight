import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	AccountService,
	defaultDataDir,
	SqliteRepository,
} from "@hatchlight/core";
import { databaseFile } from "@hatchlight/server";
import { resourcesDir } from "./resources";

const HELP = `hatchlight users — the people of a Hatchlight server

Usage: hatchlight users list [options]
       hatchlight users reset-password <username> [options]

reset-password prints a one-time password, which must be changed at the
next sign-in, turns two-step sign-in off, and ends every sign-in and API
token of the account. Use it when an owner is
locked out, for instance through docker exec. It works while the server runs.

Options:
  --data-dir <p>   The data directory (default ${defaultDataDir()})
  --resources <p>  For a packaged app: where its migrations are
  -h, --help       Show this help
`;

/** Runs \`hatchlight users\` with its arguments. */
export async function users(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			"data-dir": { type: "string" },
			resources: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	const [command, username] = positionals;
	if (values.help || !command) {
		console.log(HELP);
		return values.help ? 0 : 1;
	}
	const dataDir = values["data-dir"] ?? defaultDataDir();
	const resources = resourcesDir(values.resources);
	const migrations = resources ? join(resources, "drizzle") : undefined;
	// The database is shared with a running server, which SQLite allows.
	const repo = new SqliteRepository(databaseFile(dataDir), migrations);
	try {
		const accounts = new AccountService(repo.accounts());
		if (command === "list") {
			const people = accounts.users();
			if (people.length === 0) {
				console.log("No accounts yet: the server is waiting to be set up.");
				return 0;
			}
			for (const person of people) {
				const notes = [
					person.role,
					person.disabled ? "disabled" : null,
					person.totp ? "two-step" : null,
				].filter(Boolean);
				console.log(`${person.username}\t${notes.join(", ")}`);
			}
			return 0;
		}
		if (command === "reset-password") {
			if (!username) {
				console.error(
					"Name the account: hatchlight users reset-password <username>",
				);
				return 1;
			}
			const user = accounts.findUser(username);
			if (!user) {
				console.error(`No account named ${username}.`);
				return 1;
			}
			const password = await accounts.resetPasswordFromConsole(user.id);
			console.log(`One-time password for ${user.username}: ${password}`);
			console.log("It must be changed at the next sign-in.");
			console.log(
				"Two-step sign-in is turned off; it can be set up again in Settings.",
			);
			console.log("Every sign-in and API token of the account has ended.");
			return 0;
		}
		console.error(`Unknown command: ${command}. See hatchlight users --help.`);
		return 1;
	} finally {
		repo.close();
	}
}
