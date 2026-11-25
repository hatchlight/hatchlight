import type { LibraryInput, LibraryKind } from "@hatchlight/core/types";
import {
	COMMON_HELP,
	type Command,
	EXIT,
	integer,
	json,
	table,
	UsageError,
} from "./command";
import { libraryEntryNamed, references } from "./media";

/** `id` or `id:weight`, as a LoRA is named in a prompt. */
function loraOf(value: string): { id: string; weight: number } {
	const [id = "", weight] = value.split(":");
	const strength = weight == null ? 1 : Number(weight);
	if (!id || !Number.isFinite(strength) || strength < -2 || strength > 2) {
		throw new UsageError(
			`--lora takes an id from \`hatchlight loras\`, with a weight from -2 to 2 after a colon, not ${value}.`,
		);
	}
	return { id, weight: strength };
}

/** Characters and styles kept to use again by name. */
export const LIBRARY_COMMANDS: Record<string, Command> = {
	library: {
		summary: "List, add or remove saved characters and styles",
		usage: `Usage: hatchlight library [--kind character|style]
       hatchlight library add character|style <name> [options]
       hatchlight library remove <name|id> [--kind character|style]

A character keeps pictures of someone, LoRAs and words, to draw them again;
a style keeps words, LoRAs and pictures to make others look alike. Use them
with \`hatchlight generate --character <name> --style <name>\`.

  -r, --ref <p>     A picture: an id (ast_…) or a file; repeat, up to 4
  --lora <id[:w]>   A LoRA from \`hatchlight loras\`, with its weight; repeat
  --prompt <text>   Words added to every prompt
  --seed <n>        A seed, used when none is given
  --ratio <r>       Aspect ratio, used when none is given
  -m, --model <id>  The model used when none is given
  --kind <k>        character or style
${COMMON_HELP}`,
		options: {
			ref: { type: "string", short: "r", multiple: true },
			lora: { type: "string", multiple: true },
			prompt: { type: "string" },
			seed: { type: "string" },
			ratio: { type: "string" },
			model: { type: "string", short: "m" },
			kind: { type: "string" },
		},
		async run(values, [action, ...rest], { api, io }) {
			const kindOf = (value: unknown): LibraryKind | undefined => {
				if (value == null) return undefined;
				if (value !== "character" && value !== "style") {
					throw new UsageError(`Give character or style, not ${value}.`);
				}
				return value;
			};
			if (action == null) {
				const kind = kindOf(values.kind);
				const entries = (await api.library()).filter(
					(e) => kind == null || e.kind === kind,
				);
				if (values.json) {
					json(io, entries);
					return EXIT.ok;
				}
				if (entries.length === 0) {
					io.err(
						"Nothing saved yet. Add one with: hatchlight library add character <name> --ref <picture>",
					);
					return EXIT.ok;
				}
				for (const line of table(
					entries.map((e) => [
						e.kind,
						e.name,
						e.pictureIds.length > 0 ? `${e.pictureIds.length} picture(s)` : "",
						e.loras.map((l) => `${l.id}:${l.weight}`).join(" "),
						e.prompt ?? "",
					]),
				)) {
					io.out(line);
				}
				return EXIT.ok;
			}
			if (action === "add") {
				const [kindWord, ...words] = rest;
				const kind = kindOf(kindWord);
				const name = words.join(" ").trim();
				if (!kind || !name) {
					throw new UsageError(
						"Use `library add character <name>` or `library add style <name>`.",
					);
				}
				const installed = new Map((await api.loras()).map((l) => [l.id, l]));
				const loras = ((values.lora as string[] | undefined) ?? []).map(
					(value) => {
						const lora = loraOf(value);
						return {
							...lora,
							trigger: installed.get(lora.id)?.trigger ?? null,
						};
					},
				);
				const input: LibraryInput = {
					kind,
					name,
					pictureIds: await references(
						api,
						io,
						(values.ref as string[] | undefined) ?? [],
					),
					loras,
					prompt: (values.prompt as string | undefined) ?? null,
					seed: integer(values, "seed", 0) ?? null,
					aspectRatio: (values.ratio as string | undefined) ?? null,
					modelId: (values.model as string | undefined) ?? null,
				};
				const entry = await api.addToLibrary(input);
				if (values.json) json(io, entry);
				io.err(
					`Saved the ${entry.kind} ${entry.name}. Use it with: hatchlight generate --${entry.kind} "${entry.name}" <prompt>`,
				);
				return EXIT.ok;
			}
			if (action === "remove") {
				const name = rest.join(" ").trim();
				if (!name) throw new UsageError("Give the name of what to remove.");
				const entries = await api.library();
				const kind = kindOf(values.kind);
				const kinds: LibraryKind[] = kind ? [kind] : ["character", "style"];
				const found = kinds.flatMap((k) => {
					// One kind asked for says why its name does not fit.
					if (kind) return [libraryEntryNamed(entries, k, name)];
					try {
						return [libraryEntryNamed(entries, k, name)];
					} catch {
						return [];
					}
				});
				const [entry, other] = found;
				if (!entry) {
					throw new UsageError(
						`Nothing named ${name} in the library. See \`hatchlight library\`.`,
					);
				}
				if (other) {
					throw new UsageError(
						`Both a character and a style are named ${name}: add --kind.`,
					);
				}
				await api.removeFromLibrary(entry.id);
				if (values.json) json(io, { id: entry.id, removed: true });
				io.err(`Removed the ${entry.kind} ${entry.name}.`);
				return EXIT.ok;
			}
			throw new UsageError(
				"Use `library`, `library add character|style <name>` or `library remove <name>`.",
			);
		},
	},
};
