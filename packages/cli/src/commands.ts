import { CHAT_COMMANDS } from "./chat";
import type { Command } from "./command";
import { completionsCommand } from "./completions";
import { MANAGE_COMMANDS } from "./manage";
import { MEDIA_COMMANDS } from "./media";
import { TRAIN_COMMANDS } from "./train";

export {
	type Command,
	type Context,
	EXIT,
	type Io,
	parse,
	UsageError,
} from "./command";
export { extension } from "./media";

/** Every command a person types, in the order the help lists them. */
export const COMMANDS: Record<string, Command> = {
	...MEDIA_COMMANDS,
	...CHAT_COMMANDS,
	...MANAGE_COMMANDS,
	...TRAIN_COMMANDS,
	completions: completionsCommand(() => COMMANDS),
};

/** The commands, one per line, for the main help. */
export function commandList(): string {
	const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
	return Object.entries(COMMANDS)
		.map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`)
		.join("\n");
}
