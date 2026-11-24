# Contributing to Hatchlight

Thank you for helping. Bug reports, translations, new providers, new local
models, fixes and ideas are all welcome, whether you write code or not.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug or ask for something:** open an
  [issue](https://github.com/hatchlight/hatchlight/issues/new/choose). The forms
  ask for what we need to reproduce it.
- **Translate:** see [Translate](#translate). No coding needed.
- **Fix or build something:** look for issues labeled
  `good first issue` or `help wanted`. For anything larger than a small fix,
  open an issue first so we can agree on the approach before you spend time
  on it.
- **Report a security problem:** privately, as [SECURITY.md](SECURITY.md)
  explains. Never in a public issue.

## Set up

You need [Bun](https://bun.sh) 1.4 or newer.

```sh
git clone https://github.com/hatchlight/hatchlight.git && cd hatchlight
bun install
HATCHLIGHT_FAKE=1 bun run dev:server   # API on :4096, with a key-free fake provider
bun run dev:web                       # the app on :5173, with hot reload
```

The fake provider makes gradient pictures after a short delay, so you can work
on the interface without API keys or a graphics card. `bun run dev:site` runs
the landing page.

Before calling a change done, run all three checks:

```sh
bun test && bun run typecheck && bun run lint
```

`bun run format` fixes formatting and the order of imports.

## How the project is laid out

| Package              | What it holds                                                              |
| -------------------- | -------------------------------------------------------------------------- |
| `packages/core`      | Domain types, job engine, storage, local models, and the provider contract |
| `packages/providers` | One adapter per provider, and the catalog of local models and engines      |
| `packages/server`    | HTTP API and the live event stream                                         |
| `packages/cli`       | The `hatchlight` command                                                   |
| `packages/i18n`      | Translation helpers shared by the app and the site                         |
| `packages/motion`    | The visual effects the app and the site share                              |
| `apps/web`           | The app's interface (React)                                                |
| `apps/site`          | The landing page                                                           |
| `apps/desktop`       | The desktop app: a Tauri window around the compiled server                 |

Storage sits behind `Repository` and `AssetStore`, and every operation takes a
`UserContext`, so the same core can serve the local app, the desktop app and,
later, a hosted version. Keep new code that way: no global user, and no
assumption that a provider is remote.

After changing `packages/core/src/db/schema.ts`, run `bunx drizzle-kit generate`
inside `packages/core` and commit the migration it writes.

## Rules everyone follows

- **English in the repository:** code, comments, messages, tests,
  documentation, commits and pull requests, whatever language we talk in.
- **No text in code:** every text a person reads comes from a translation
  catalog (see below), and numbers, sizes, money and dates are formatted with
  the translator (`number`, `bytes`, `date`), never by hand.
- **Tests with behavior changes:** a fix comes with a test that fails without
  it; a feature comes with tests for what it promises.
- **Accessible and calm:** controls are reachable by keyboard and labeled for
  screen readers, and every animation respects "reduce motion".

## Translate

Each language is one JSON file per part of the project:

- the app: `apps/web/src/locales/<language>.json`
- the site: `apps/site/src/locales/<language>.json`

Copy `en.json`, translate the values, and keep the words in `{braces}` exactly
as they are. Add the language to the list next to the catalogs
(`apps/web/src/i18n.tsx` and `apps/site/src/languages.ts`). Anything you leave
out shows in English, so a partial translation is welcome too. `bun test`
checks that every translation uses the same placeholders as English.

When you add or change an English message, update the other languages you can.

## Add a provider

A provider is one file in `packages/providers/src` implementing
`ProviderAdapter` from `@hatchlight/core`:

1. `listModels()` describes each model and what it supports (aspect ratios,
   seed, images per request, reference images, video lengths). The interface
   builds itself from this.
2. `submit()` starts a request and returns a JSON-serializable handle.
3. `events()` follows that handle and yields `progress`, then `completed` or
   `failed`.

If the provider has a server-side queue, set `resumable = true` and the handle
is used to re-attach after a restart (`fal.ts` is the example). If it answers
in a single request, do the call inside `events()` and set `resumable = false`
(`openai.ts`).

Register it in `packages/providers/src/index.ts`, add the page where people get
a key to `KEY_PAGES` in `apps/web/src/Picker.tsx`, and add a test file that
calls `providerContract(new YourProvider())` and exercises the adapter against
a scripted `fetch`, as the existing tests do. Tests never call the real API.

## Add a local model

Local models are listed in `packages/providers/src/local-models/`. Each one
pins a revision of its repository and gives, for every file, its size and
SHA-256, so downloads can be checked. Give each variant the memory it needs,
so Hatchlight can tell which ones run on a given computer. Say in the pull
request which hardware you ran it on and how long a picture took.

## Work on the desktop app

The desktop app needs [Rust](https://rustup.rs) as well. On Linux it also
needs the WebKitGTK libraries:

```sh
sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev \
  libxdo-dev libayatana-appindicator3-dev librsvg2-dev
```

Then, in `apps/desktop`, `bun run dev` builds the app and the server and opens
the window. The server is compiled into one executable by `bun build --compile`
and runs as a sidecar on a free port. The window shows a splash
(`apps/web/splash.html`) until the server is ready. The installers for every
system are built by the `Desktop` workflow.

## Pull requests

- Keep one change per pull request, small enough to review in one sitting.
- Explain what changes for the person using Hatchlight and why, and how you
  checked it. Screenshots or a short recording help for anything visible.
- Write commit messages as a short imperative summary ("Add the Kling 3
  model"), with a body when the reason is not obvious.
- The checks must pass. A maintainer reviews, may ask for changes, and merges.

### What runs on your pull request

- **CI / check**: lint, typecheck, tests and the build, the same as
  `bun test && bun run typecheck && bun run lint && bun run build`.
- **CI / desktop**: `cargo clippy` on the desktop shell in
  `apps/desktop/src-tauri`.
- **CI / dependency-review**: fails if the change adds a dependency with a known
  high or critical vulnerability.
- **CodeQL**: looks for security problems in the code.
- **Workflows / zizmor**: only when `.github/` changes, checks the workflows for
  unsafe patterns.

If this is your first pull request here, a maintainer has to approve the checks
before they run. Pull requests from forks never receive the project's secrets.

By contributing you agree that your contribution is released under the
project's [MIT license](LICENSE).
