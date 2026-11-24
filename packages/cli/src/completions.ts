import type { ParseArgsOptionsConfig } from "node:util";
import { COMMON, type Command, EXIT, UsageError } from "./command";

/**
 * Completion scripts for shells, made from the commands themselves, so a
 * new command or option is completed without anyone writing it here.
 */

/** Commands the program has besides those in the list. */
const OTHERS: Record<string, string> = {
	serve: "Start the app",
	mcp: "Connect an AI agent",
};

interface Spec {
	name: string;
	summary: string;
	options: { name: string; short?: string; value: boolean; many: boolean }[];
}

function specs(commands: Record<string, Command>): Spec[] {
	const options = (config: ParseArgsOptionsConfig) =>
		Object.entries(config)
			// "--wait" is the default; only its opposite is typed.
			.filter(([name]) => name !== "wait" && name !== "resources")
			.map(([name, option]) => ({
				name,
				short: option.short,
				value: option.type === "string",
				many: option.multiple === true,
			}));
	return [
		...Object.entries(commands).map(([name, command]) => ({
			name,
			summary: command.summary,
			options: options({ ...COMMON, ...command.options }),
		})),
		...Object.entries(OTHERS).map(([name, summary]) => ({
			name,
			summary,
			options: [],
		})),
	];
}

/** Options whose value is a file or a folder. */
const PATHS = new Set(["output", "data-dir", "batch", "samples", "ref"]);

/** Quoted for a shell's single quotes. */
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function bash(all: Spec[]): string {
	const cases = all
		.map((spec) => {
			const words = spec.options.flatMap((o) => [
				`--${o.name}`,
				...(o.short ? [`-${o.short}`] : []),
			]);
			return `\t\t${spec.name}) opts=${quoted(words.join(" "))} ;;`;
		})
		.join("\n");
	return `# hatchlight completions for bash. Add to ~/.bashrc:
#   eval "$(hatchlight completions bash)"
_hatchlight() {
	local cur="\${COMP_WORDS[COMP_CWORD]}" opts=""
	if [ "$COMP_CWORD" -eq 1 ]; then
		COMPREPLY=($(compgen -W ${quoted(all.map((s) => s.name).join(" "))} -- "$cur"))
		return
	fi
	case "\${COMP_WORDS[1]}" in
${cases}
	esac
	if [[ "$cur" == -* ]]; then
		COMPREPLY=($(compgen -W "$opts" -- "$cur"))
	fi
}
complete -o default -F _hatchlight hatchlight
`;
}

function zsh(all: Spec[]): string {
	const commands = all
		.map((spec) => `\t\t${quoted(`${spec.name}:${spec.summary}`)}`)
		.join("\n");
	const cases = all
		.map((spec) => {
			const args = spec.options.flatMap((o) => {
				const many = o.many ? "*" : "";
				// Options that name a file or folder complete paths.
				const value = !o.value
					? ""
					: PATHS.has(o.name)
						? `:${o.name}:_files`
						: `:${o.name}:`;
				return [
					quoted(`${many}--${o.name}[]${value}`),
					...(o.short ? [quoted(`${many}-${o.short}[]${value}`)] : []),
				];
			});
			return `\t\t${spec.name}) _arguments ${[...args, quoted("*:file:_files")].join(" ")} ;;`;
		})
		.join("\n");
	return `#compdef hatchlight
# hatchlight completions for zsh. Add to ~/.zshrc, after compinit:
#   source <(hatchlight completions zsh)
_hatchlight() {
	local -a commands
	commands=(
${commands}
	)
	if (( CURRENT == 2 )); then
		_describe 'command' commands
		return
	fi
	shift words
	(( CURRENT-- ))
	case $words[1] in
${cases}
	esac
}
compdef _hatchlight hatchlight
`;
}

function fish(all: Spec[]): string {
	const lines = [
		"# hatchlight completions for fish. Save them with:",
		"#   hatchlight completions fish > ~/.config/fish/completions/hatchlight.fish",
	];
	for (const spec of all) {
		lines.push(
			`complete -c hatchlight -n __fish_use_subcommand -f -a ${spec.name} -d ${quoted(spec.summary)}`,
		);
		for (const o of spec.options) {
			lines.push(
				`complete -c hatchlight -n ${quoted(`__fish_seen_subcommand_from ${spec.name}`)} -l ${o.name}${o.short ? ` -s ${o.short}` : ""}${o.value ? " -r" : ""}`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

const SHELLS = { bash, zsh, fish };

/** The `completions` command, for the commands `all` gives. */
export function completionsCommand(
	all: () => Record<string, Command>,
): Command {
	return {
		summary: "Print shell completions (bash, zsh or fish)",
		usage: `Usage: hatchlight completions <bash|zsh|fish>

Prints a script that completes hatchlight's commands and options as you
type. To have it in every terminal:

  bash   add to ~/.bashrc:  eval "$(hatchlight completions bash)"
  zsh    add to ~/.zshrc:   source <(hatchlight completions zsh)
  fish   hatchlight completions fish > ~/.config/fish/completions/hatchlight.fish

  -h, --help        Show this help`,
		options: {},
		offline: true,
		async run(_, [shell, ...extra], { io }) {
			const make = SHELLS[shell as keyof typeof SHELLS];
			if (!make || extra.length > 0) {
				throw new UsageError("Name a shell: bash, zsh or fish.");
			}
			// Written whole, without the trailing line out() adds.
			io.out(make(specs(all())).trimEnd());
			return EXIT.ok;
		},
	};
}
