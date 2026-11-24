# Hatchlight

[![CI](https://github.com/hatchlight/hatchlight/actions/workflows/ci.yml/badge.svg)](https://github.com/hatchlight/hatchlight/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/hatchlight/hatchlight/badge)](https://scorecard.dev/viewer/?uri=github.com/hatchlight/hatchlight)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/16935/badge)](https://www.bestpractices.dev/projects/16935)

One interface for many image and video generation models. Open source, runs on
your computer, and uses your own API keys or models that run on your own
graphics card.

- **Compare models side by side.** Send one prompt to several models and see
  each result with its time and cost.
- **Iterate like a conversation.** Any image can become the reference for your
  next prompt, or the first frame of a video.
- **Run models on your computer.** Hatchlight looks at your hardware, picks the
  engine and the version of each model that fits it, downloads and checks the
  files, and runs them. Free, private, and offline once downloaded.
- **Keep everything.** Every result is saved on your computer with the prompt
  and parameters that produced it, in a searchable gallery.

| Where pictures are made             | Models                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| On your computer                    | SDXL Turbo, Stable Diffusion XL, FLUX.1 schnell, Z-Image Turbo, Wan 2.1 (video) |
| [fal](https://fal.ai)               | FLUX, Veo, Kling, Hailuo, Wan and more, images and video                        |
| [Replicate](https://replicate.com)  | Images and video                                                                |
| [OpenRouter](https://openrouter.ai) | Images and video                                                                |
| OpenAI                              | GPT Image                                                                       |
| Google Gemini                       | Nano Banana                                                                     |

The interface speaks English and Brazilian Portuguese. More languages are
welcome: see [Translate](CONTRIBUTING.md#translate).

## Install

**Desktop app** (Windows, macOS, Linux): download the installer for your
system from the
[latest release](https://github.com/hatchlight/hatchlight/releases/latest).
The installers are not signed yet: if Windows says it protected your computer,
choose **More info**, then **Run anyway**.

**From source**, with [Bun](https://bun.sh) 1.4 or newer:

```sh
git clone https://github.com/hatchlight/hatchlight.git && cd hatchlight
bun install
bun run build
bun run start
```

This opens `http://localhost:4096`. The first screen walks you to a first
picture: download a model that runs on your computer, or paste an API key.

`bun run start --help` lists the options. Keys can also come from the
environment: `FAL_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`REPLICATE_API_TOKEN`, `OPENROUTER_API_KEY`.

## Use it from an AI agent

`hatchlight mcp` lets an agent that speaks the
[Model Context Protocol](https://modelcontextprotocol.io), such as Claude Code
or Claude Desktop, make pictures and videos with your models: list them,
generate and compare, redraw a picture, upscale it, and search and save from
your gallery. With Claude Code, from the Hatchlight folder:

```sh
claude mcp add hatchlight -- bun "$PWD/packages/cli/src/index.ts" mcp
```

It uses the Hatchlight already running, or starts one that stops with the
agent. By default only models on your computer are used, so it costs nothing;
`--allow-paid --spend-limit 5` also lets it use your cloud keys, up to $5 per
connection. Agents cannot install models: you do, in the app. See
`bun run start mcp --help`.

## Your data

Sessions, pictures, keys and models stay on your computer, in a directory
readable only by you:

| System  | Directory                                                  |
| ------- | ---------------------------------------------------------- |
| Windows | `%APPDATA%\hatchlight`                                     |
| macOS   | `~/Library/Application Support/hatchlight`                 |
| Linux   | `$XDG_DATA_HOME/hatchlight` or `~/.local/share/hatchlight` |

Installs made before the rename to Hatchlight
keep using their `open-reel` folders and `OPEN_REEL_*` variables.

`HATCHLIGHT_DATA_DIR` or `--data-dir` puts it elsewhere. Under WSL, models are
kept on the Windows side, where the graphics card driver reads them fastest.

Keys are sent only to the provider they belong to and are never returned by
the API. The server listens on `127.0.0.1` only and refuses requests that do
not come from its own page, so other websites cannot use your keys. Nothing is
collected about you: Hatchlight has no telemetry.

## Contribute

Bug reports, translations, new providers and new local models are all
welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the project is laid
out, how to run it while developing, and what a pull request needs. Everyone
taking part follows the [code of conduct](CODE_OF_CONDUCT.md). To report a
security problem, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
