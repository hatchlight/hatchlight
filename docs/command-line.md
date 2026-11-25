# Command line and agents

Hatchlight's program makes pictures from the terminal, and lets AI agents
make them with your models. To use the app itself, see
[Getting started](getting-started.md).

- [Getting the command](#getting-the-command)
- [Make pictures from the terminal](#make-pictures-from-the-terminal)
- [Set up from the terminal](#set-up-from-the-terminal)
- [Use it from an AI agent](#use-it-from-an-ai-agent)

## Getting the command

The examples below are written as `hatchlight <command>`. Run them in one of
these ways:

- **From a source checkout** (see [Install](../README.md#install)): from the
  Hatchlight folder, `bun run start <command>`.
- **Without a checkout:** install [Bun](https://bun.sh) 1.4 or newer, then
  `bunx hatchlight <command>`, which runs the
  [npm package](https://www.npmjs.com/package/hatchlight).

The desktop app does not put a `hatchlight` command on your system. To
connect an agent to the desktop app, use **Settings > Use with AI agents** in
the app: see [below](#use-it-from-an-ai-agent).

Every command has `--help`, and `hatchlight --help` lists them all.

## Make pictures from the terminal

```sh
hatchlight models                         # what can be used now
hatchlight generate "a lighthouse at dusk" -m local/sdxl-turbo -o out/
hatchlight generate "the same, at night" -r out/first.png --seed 7
hatchlight upscale ast_… -o big.png
hatchlight gallery lighthouse             # find what was made before
hatchlight get ast_… -o lighthouse.png
hatchlight generate --batch prompts.txt -o out/   # one prompt per line
hatchlight chat "a poster of a lighthouse, then make it warmer"
```

`generate` waits and shows how each model is doing. With the app open,
Ctrl+C stops waiting while the job goes on, to follow with
`status <session>`. Compare models by repeating `-m`. Every command takes
`--json` for scripts. Like agents, it uses the Hatchlight already running or
starts one for the command, and only models on your computer unless you pass
`--allow-paid`.

## Set up from the terminal

```sh
hatchlight doctor                 # the GPU, disk, models and what is missing
hatchlight catalog                # models to download, and how they fit
hatchlight install sdxl-turbo     # download one and wait until it is ready
hatchlight keys set fal           # asks for the key without showing it
hatchlight loras add style.safetensors
hatchlight folders add ~/ComfyUI  # use the models of another app where they are
hatchlight trainer install        # then train a LoRA from your pictures:
hatchlight train photos/ --name "My dog" --trigger qzxdog --consent --samples out/
```

`hatchlight completions zsh` (or `bash`, `fish`) prints tab completion for
your shell; its `--help` says where to put it.

Keys can also come from the environment: `FAL_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `REPLICATE_API_TOKEN`, `OPENROUTER_API_KEY`.

## Use it from an AI agent

`hatchlight mcp` lets an agent that speaks the
[Model Context Protocol](https://modelcontextprotocol.io), such as Claude Code
or Claude Desktop, make pictures and videos with your models: list them,
generate and compare, redraw a picture, upscale it, and search and save from
your gallery.

**With the desktop app:** **Settings > Use with AI agents** connects Claude
Desktop for you (restart Claude Desktop afterwards), and shows the command to
run once for Claude Code. Paid models stay off unless you tick **Also let it
use paid models, on your keys**, and **Spend at most** caps what it spends.

**Without the app**, with Bun:

```sh
claude mcp add hatchlight -- bunx hatchlight mcp
```

From a source checkout:

```sh
claude mcp add hatchlight -- bun "$PWD/packages/cli/src/index.ts" mcp
```

It uses the Hatchlight already running, or starts one that stops with the
agent. By default only models on your computer are used, so it costs nothing;
`--allow-paid --spend-limit 5` also lets it use your cloud keys, up to $5 per
connection. Agents cannot install models: you do, in the app or with
`hatchlight install`. See
`hatchlight mcp --help`.

On a Hatchlight server, agents connect with an API token instead, over HTTP
at `/mcp` or with `hatchlight mcp --url`: see
[Agents](self-hosting.md#agents) in the self-hosting guide.
