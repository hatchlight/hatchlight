# Self-hosting Hatchlight

Hatchlight can run as a server on a home server or a NAS with an NVIDIA card,
for the people of your home or a small team. Each person has an account and
their own gallery; the graphics card, the models and the cloud keys you choose
to share are shared.

This guide covers the Docker image: `ghcr.io/hatchlight/hatchlight`.

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [First run](#first-run)
- [Adding people](#adding-people)
- [Agents](#agents)
- [Reaching it: LAN, Tailscale, a domain](#reaching-it)
- [Settings](#settings)
- [Backups and updates](#backups-and-updates)
- [The secret for API keys](#the-secret-for-api-keys)
- [NAS platforms: Unraid, TrueNAS SCALE](#nas-platforms)
- [Troubleshooting](#troubleshooting)
- [A public demo](#public-demo)
- [What server mode protects, and what it does not](#threat-model)

## Requirements

- A 64-bit x86 Linux machine (or Windows with Docker Desktop and WSL 2).
- An NVIDIA card with the **NVIDIA driver 570 or newer** on the host. The
  image carries the CUDA 12.8 runtime; the driver comes from the host. `nvidia-smi`
  on the host shows the driver version.
- Docker with the **[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)**,
  so containers can use the card. Docker Desktop on Windows has it built in.
- Disk space: the image is a 2.5 GB download and takes about 7 GB once
  unpacked; models take 2 to 30 GB each.

Without an NVIDIA card, or with an older driver, Hatchlight still runs: local
models run on the processor, which is much slower, and cloud models work as
usual.

## Quick start

With Docker Compose, using [`deploy/compose.yaml`](../deploy/compose.yaml):

```sh
git clone https://github.com/hatchlight/hatchlight.git && cd hatchlight
HATCHLIGHT_PUBLIC_URL=http://192.168.1.20:4096 docker compose -f deploy/compose.yaml up -d
```

Compose downloads the image from `ghcr.io/hatchlight/hatchlight`. To build
it yourself instead, run `docker build -t ghcr.io/hatchlight/hatchlight .`
first, which takes a few minutes.
`docker compose -f deploy/compose.yaml logs hatchlight` shows the setup code.

Or with `docker run`:

```sh
docker run -d --name hatchlight --gpus all -p 192.168.1.20:4096:4096 \
  -e HATCHLIGHT_PUBLIC_URL=http://192.168.1.20:4096 \
  -e PUID=1000 -e PGID=1000 \
  -v hatchlight-data:/data -v hatchlight-models:/models -v hatchlight-trainer:/trainer \
  --restart unless-stopped \
  ghcr.io/hatchlight/hatchlight:latest
```

In the Compose files, `HATCHLIGHT_PORT` changes the port on the host (4096
by default), `HATCHLIGHT_BIND` the address it is published on, and
`HATCHLIGHT_IMAGE` pins a version, such as
`ghcr.io/hatchlight/hatchlight:<version>`.

**Docker's published ports go around the host's firewall:** Docker adds its
own rules ahead of ufw and firewalld, so a port published on every address
(`-p 4096:4096`, or `HATCHLIGHT_BIND` left at `0.0.0.0`) is open to every
network the machine is on, whatever the firewall says. Publish it on the LAN
address only (`-p 192.168.1.20:4096:4096`, `HATCHLIGHT_BIND=192.168.1.20`),
or on `127.0.0.1` behind a proxy, or use Tailscale, which publishes nothing.

`HATCHLIGHT_PUBLIC_URL` is the address people type in their browser. Use this
machine's address on your network (`192.168.1.20` above is an example). The
container refuses to start without it, and says so in its log.

## First run

The server waits to be set up. Its log has a one-time setup code:

```console
$ docker logs hatchlight
Hatchlight is running at http://192.168.1.20:4096
Listening on 0.0.0.0:4096

  Set up this server: open http://192.168.1.20:4096 and enter the code 7KQ2-X9FM-C4TR
  The code changes each time the server starts, until it is set up.
```

Open the address, enter the code, and create the owner's account. Only someone
who can read the log can do this, so nobody else on the network can claim the
server first.

Then install a model from **Models**. SDXL Turbo (about 7 GB) is a good first
one: it makes a picture in a second or two on a recent card.

## Adding people

The owner and admins invite people from **Settings > People**: each invite is
a link that works once, for a week. A member makes pictures in their own
gallery, which other members do not see. An admin decides, per person,
whether they may train LoRAs and use the paid cloud models on the server's
keys, with a monthly limit.

If the owner is locked out:

```sh
docker exec hatchlight hatchlight users list
docker exec hatchlight hatchlight users reset-password <username>
```

The reset prints a one-time password that must be changed at the next
sign-in.

<a id="agents"></a>

## Agents

AI agents that speak the [Model Context Protocol](https://modelcontextprotocol.io),
such as Claude Code and Claude Desktop, can make pictures and videos on the
server as a person, with an **API token** that person makes in **Settings >
Use with AI agents**. An agent can list the models, generate and compare,
redraw and upscale, search the person's gallery, use their saved characters
and styles, check that a character stays the same, and read which models
they prefer. It cannot install models, manage people or change the
server's settings, whatever the token.

Each token has:

- **Permissions**, never more than its person's own: _see_ (models, sessions,
  gallery), _make_ (pictures and videos, uploads and deletions), _paid
  models_ (only for people allowed them) and _train LoRAs_ (likewise).
- **A spending limit** on paid models, on top of the person's monthly one,
  whichever key pays.
- **An expiry**: 30, 90 (the default) or 365 days, or none.

Making a token takes the person's password, and their two-step code when
it is on, so a stolen browser session alone cannot mint one. The token is
shown once. Lists show its name, permissions, when it was last
used and what it spent; its person revokes it there, and admins and owners
revoke it from **Settings > People**. Changing the person's password or role,
or disabling them, ends all their tokens, and so does **Sign out everywhere
else** unless its box is unticked.

An agent connects in one of two ways:

- **Over HTTP, at `/mcp`**, with only the address and the token. For Claude
  Code:

  ```sh
  claude mcp add --transport http --scope user hatchlight \
    https://hatchlight.example.com/mcp --header "Authorization: Bearer hl_…"
  ```

  `--scope user` makes it available in every project. The token lands in the
  shell's history, unless the command starts with a space in a shell set to
  skip those, and Claude Code keeps it in its settings file (`~/.claude.json`).
  To keep it off the command line, read it first:

  ```sh
  read -s HATCHLIGHT_TOKEN
  claude mcp add --transport http --scope user hatchlight \
    https://hatchlight.example.com/mcp --header "Authorization: Bearer $HATCHLIGHT_TOKEN"
  ```

  `/mcp` takes the token
  only, never a browser's sign-in, and refuses requests from other websites.
  It is served in server mode only.

- **Through `hatchlight mcp`** on the agent's computer, for agents that start
  a command, such as Claude Desktop: its settings file takes commands only,
  and its connectors have no documented way to send a token. It needs
  Hatchlight's command line there:

  ```json
  {
    "mcpServers": {
      "hatchlight": {
        "command": "hatchlight",
        "args": ["mcp", "--url", "https://hatchlight.example.com"],
        "env": { "HATCHLIGHT_TOKEN": "hl_…" }
      }
    }
  }
  ```

  `HATCHLIGHT_TOKEN=hl_… hatchlight mcp --url <address>` does the same from a
  terminal; in the environment, unlike with `--token`, the token stays out of
  other users' process lists. It refuses a plain `http://` address unless it is this
  computer or `--insecure` is given. `--allow-paid` and `--spend-limit` add
  their own limits on that computer.

Treat a token like a password: anyone who has it acts as its person, within
what it allows. Tokens start with `hl_` followed by 43 characters (letters,
digits, `-` and `_`), so secret scanners can recognise them. To have GitHub
look for them in a repository, add a
[custom secret scanning pattern](https://docs.github.com/en/code-security/secret-scanning/using-advanced-secret-scanning-and-push-protection-features/custom-patterns/defining-custom-patterns-for-secret-scanning)
with the regular expression `hl_[A-Za-z0-9_-]{43}`.

The same tokens let other apps, such as Open WebUI and SillyTavern, make
pictures through the OpenAI and AUTOMATIC1111 image APIs the server also
answers (SillyTavern uses the AUTOMATIC1111 one): see [Use it from other apps](other-apps.md#on-a-server).

<a id="reaching-it"></a>

## Reaching it: LAN, Tailscale, a domain

| Path                                              | Good for                       | HTTPS | Open to the internet |
| ------------------------------------------------- | ------------------------------ | ----- | -------------------- |
| [Tailscale](#tailscale-recommended) (recommended) | Your devices, anywhere         | Yes   | No                   |
| [Home network](#home-network)                     | Everyone at home, nothing else | No    | No                   |
| [A domain with Caddy](#a-domain-with-caddy)       | People without Tailscale       | Yes   | Yes                  |
| [Cloudflare Tunnel](#cloudflare-tunnel)           | A domain without opening ports | Yes   | Through Cloudflare   |

### Tailscale (recommended)

[`deploy/compose.tailscale.yaml`](../deploy/compose.tailscale.yaml) runs
Tailscale next to Hatchlight. `tailscale serve` gives it a name and an HTTPS
certificate on your tailnet, such as `https://hatchlight.example-tailnet.ts.net`.
Nothing is published on the host or the internet: only devices signed in to
your tailnet reach it.

1. In the [Tailscale admin console](https://login.tailscale.com/admin), turn
   on **HTTPS certificates** (DNS page), and create an **auth key** (Settings >
   Keys).
2. Start it with your key and your tailnet's name:

   ```sh
   TS_AUTHKEY=tskey-auth-... TAILNET=example-tailnet.ts.net \
     docker compose -f compose.tailscale.yaml up -d
   ```

Hatchlight shares the Tailscale container's network, so the proxy reaches it
on `127.0.0.1`, which is its trusted proxy (`HATCHLIGHT_TRUSTED_PROXIES`).

### Home network

[`deploy/compose.yaml`](../deploy/compose.yaml) publishes port 4096. Set
`HATCHLIGHT_PUBLIC_URL` to `http://<this machine's address>:4096`, and add
other names it is reached by, such as `nas.local`, to
`HATCHLIGHT_ALLOWED_HOSTS`.

Without HTTPS, passwords cross your network unencrypted. On a network you
trust, at home, that is the usual trade-off; elsewhere, use Tailscale.

### A domain with Caddy

[`deploy/compose.caddy.yaml`](../deploy/compose.caddy.yaml) puts
[Caddy](https://caddyserver.com) in front, with a Let's Encrypt certificate
for your domain. Point the domain at your machine, forward ports 80 and 443 to
it, and start it with `DOMAIN=hatchlight.example.com`. Hatchlight publishes no
port: only Caddy reaches it, from a fixed address that is its only trusted
proxy. Read [the threat model](#threat-model) before opening a server to the
internet.

### Cloudflare Tunnel

A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
reaches Hatchlight from Cloudflare without opening ports. Run `cloudflared`
in the same Compose project, on a network with a fixed address as in the Caddy
file, and point the tunnel's public hostname at `http://hatchlight:4096`. Then
set:

- `HATCHLIGHT_PUBLIC_URL=https://<the tunnel's hostname>`;
- `HATCHLIGHT_TRUSTED_PROXIES=<cloudflared's address>`.

Cloudflare's free plan refuses uploads over 100 MB, so models and large LoRAs
cannot be added by hand through the tunnel; downloads from the catalog are not
affected. [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
in front adds a sign-in of its own.

## Settings

Everything is set through the environment. The image sets the first group.

| Variable                           | Default in the image          | What it is                                                                          |
| ---------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `HATCHLIGHT_MODE`                  | `server`                      | `server`: accounts, over the network                                                |
| `HATCHLIGHT_HOST`                  | `0.0.0.0`                     | Address to listen on, port 4096                                                     |
| `HATCHLIGHT_DATA_DIR`              | `/data`                       | Database, pictures, settings, keys                                                  |
| `HATCHLIGHT_MODELS_DIR`            | `/models`                     | Models and LoRAs                                                                    |
| `HATCHLIGHT_TRAINER_DIR`           | `/trainer`                    | The LoRA trainer, installed on first use (about 6 GB)                               |
| `HATCHLIGHT_ENGINES_DIR`           | `/opt/hatchlight/engines`     | The engines that come with the image, used instead of downloading them              |
| `PUID`, `PGID`                     | `1000`                        | The owner of the files in the volumes                                               |
| `HATCHLIGHT_PUBLIC_URL`            | (required)                    | The address people open, such as `https://hatchlight.example.com`                   |
| `HATCHLIGHT_ALLOWED_HOSTS`         |                               | Other host names it is reached by, comma-separated                                  |
| `HATCHLIGHT_TRUSTED_PROXIES`       |                               | Addresses or blocks of proxies whose `X-Forwarded-*` headers are believed           |
| `HATCHLIGHT_SECRET_FILE`           | `/data/secret.key`, made once | The secret saved API keys are encrypted with; see [below](#the-secret-for-api-keys) |
| `HATCHLIGHT_ASSET_GB_PER_PERSON`   | no limit                      | Space each member's pictures and videos may take                                    |
| `HATCHLIGHT_LORA_FILES_PER_PERSON` | `20`                          | LoRAs each member may add                                                           |
| `HATCHLIGHT_LORA_GB_PER_PERSON`    | `10`                          | Space each member's LoRAs may take                                                  |
| `NVIDIA_VISIBLE_DEVICES`           | `all`                         | Which cards the container uses                                                      |

Cloud keys can also come from the environment: `FAL_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `REPLICATE_API_TOKEN`, `OPENROUTER_API_KEY`. They are the
server's: only people allowed to use paid models spend on them.

To use the models of ComfyUI, AUTOMATIC1111, Forge or Stability Matrix
already on the server, mount their folder into the container (for example
`-v /srv/ComfyUI:/comfyui`, or a `volumes:` line in the compose file), then
add `/comfyui` in **Models > Models from other apps**. The folder must be
readable by `PUID`; Hatchlight only reads it. Only admins add or
remove these folders; members use their models without seeing the paths.

## Backups and updates

Only `/data` needs a backup: it holds the database, everyone's pictures, the
settings and the saved keys. Models download again; the trainer reinstalls.

`hatchlight backup` saves a consistent copy while the server runs:

```sh
docker exec hatchlight hatchlight backup /data/backups/hatchlight-$(date +%F).tar.gz
```

The file holds the API keys and the secret that opens them: keep it as safe as
the server. To restore, stop the server, look at what the backup holds, and
put it back:

```sh
docker compose stop hatchlight
docker compose run --rm hatchlight restore /data/backups/hatchlight-2026-11-24.tar.gz --dry-run
docker compose run --rm hatchlight restore /data/backups/hatchlight-2026-11-24.tar.gz
docker compose start hatchlight
```

A restore moves what was in `/data` to `/data/before-restore-<time>/` instead
of deleting it, and is refused while a server uses the folder.

**Updates:** back up, then pull the new image and recreate the container.
The database is brought up to date when the server starts.

```sh
docker compose pull && docker compose up -d
```

Images are signed with [cosign](https://docs.sigstore.dev): verify one with

```sh
cosign verify ghcr.io/hatchlight/hatchlight:latest \
  --certificate-identity-regexp '^https://github.com/hatchlight/hatchlight/\.github/workflows/docker\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## The secret for API keys

Saved API keys are encrypted (AES-256-GCM) with a key derived from a secret.
The first start makes a random one in `/data/secret.key`, readable by the
server's user only. Without that secret the saved keys cannot be read: the
server says so at start, sets `auth.json` aside untouched as
`auth.unreadable-<time>.json`, and starts without them. To recover them, stop
the server, put the right secret back, and rename that file to `auth.json`;
otherwise enter the keys again.

To keep the secret apart from the data, as a Docker secret, point
`HATCHLIGHT_SECRET_FILE` at a file of at least 16 bytes, better 32 random
ones:

```sh
openssl rand -base64 48 > hatchlight-secret.txt
chmod 600 hatchlight-secret.txt
sudo chown 1000:1000 hatchlight-secret.txt # PUID:PGID
```

```yaml
services:
  hatchlight:
    environment:
      HATCHLIGHT_SECRET_FILE: /run/secrets/hatchlight_secret
    secrets:
      - hatchlight_secret
secrets:
  hatchlight_secret:
    file: ./hatchlight-secret.txt
```

The server refuses a secret file that other users can read, so it must be
`chmod 600` and owned by `PUID:PGID`. Back that file up too: `hatchlight
backup` saves `secret.key` from the data directory, not a file kept
elsewhere, and says so when `HATCHLIGHT_SECRET_FILE` is set.

<a id="nas-platforms"></a>

## NAS platforms: Unraid, TrueNAS SCALE

**Unraid:** install the **Nvidia Driver** plugin, then add the template
[`deploy/unraid/hatchlight.xml`](../deploy/unraid/hatchlight.xml) (Docker >
Add Container > Template, or copy it to
`/boot/config/plugins/dockerMan/templates-user/`). It runs with
`--runtime=nvidia`, keeps its folders in `/mnt/user/appdata/hatchlight`, and
uses Unraid's usual owner, `99:100`.

**TrueNAS SCALE (24.10 or newer):** under **Apps > Discover Apps > Custom
App**, choose **Install via YAML** and paste
[`deploy/compose.yaml`](../deploy/compose.yaml), or fill the form:

- image `ghcr.io/hatchlight/hatchlight`, tag `latest`;
- the environment above, at least `HATCHLIGHT_PUBLIC_URL`, and `PUID` /
  `PGID` `568`, the `apps` user TrueNAS gives app datasets;
- host paths to datasets for `/data`, `/models` and `/trainer`;
- port 4096, and under **Resources**, the NVIDIA card (install the NVIDIA
  drivers first in **Apps > Configuration > Settings**).

## Troubleshooting

**No GPU in the container: models run on the processor.** Check that the card
is passed through:

```sh
docker exec hatchlight nvidia-smi
```

If that fails, the container was started without the card: add `--gpus all`,
or the `deploy.resources.reservations.devices` block from the Compose files,
and make sure the NVIDIA Container Toolkit is installed and Docker was
restarted after it (`sudo nvidia-ctk runtime configure --runtime=docker`). If
`nvidia-smi` works but shows a driver older than 570, update the host's
driver: the CUDA engine needs it, and Hatchlight uses the processor until
then. The log says which engine it skipped and why.

**"Forbidden host".** The browser opened an address that is neither
`HATCHLIGHT_PUBLIC_URL` nor in `HATCHLIGHT_ALLOWED_HOSTS`. Add it there.

**Behind a proxy, sign-in loops or the address is wrong.** Set
`HATCHLIGHT_TRUSTED_PROXIES` to the proxy's address, and
`HATCHLIGHT_PUBLIC_URL` to the `https://` address people open.

**Permission denied on `/data` or `/models`.** Set `PUID` and `PGID` to the
owner of those folders on the host (`id <user>`). On a network share that
does not allow changing owners, make them writable by that user.

**"secret.key can be read by other users".** The server refuses a secret
others can read. Run `chmod 600` on it; on a network share that forces open
permissions, keep `/data` on a local disk or use `HATCHLIGHT_SECRET_FILE` on
one that does not.

**"Hatchlight is already running on this data directory".** Another container
uses the same `/data`. Stop it; if it crashed, the folder is free again after
30 seconds.

**The container stops at once.** `docker logs hatchlight` says why, usually a
missing or malformed `HATCHLIGHT_PUBLIC_URL`.

<a id="public-demo"></a>

## A public demo

`--mode demo` (or `HATCHLIGHT_MODE=demo`) runs Hatchlight as a showcase that
anyone may try without an account, such as a Hugging Face Space. It is not
a way to share Hatchlight with people you know: use server mode for that.

- **No login.** The page starts a visit with `POST /api/visitor`, the only
  request that makes a visitor: a random token, sent back in the answer and
  in an HttpOnly cookie (`Secure` and `SameSite=None; Partitioned` over
  HTTPS). The page also sends it as `Authorization: Bearer`, so the demo
  works inside the frame Hugging Face shows a Space in even when the browser
  keeps no cookies there; pictures, which the browser loads as addresses,
  carry a separate media key that opens only them. The server keeps only
  hashes. Any other request without a known visitor is answered `401`. A
  visitor sees only their own sessions, pictures and gallery.
- **Only pictures with the installed model.** At start, the server installs
  `HATCHLIGHT_DEMO_MODEL` (SDXL Turbo unless set) if it is missing, and logs
  its progress; it is the only model offered or accepted. Visitors cannot
  install or remove models, add LoRAs or
  checkpoints, train, upload pictures, set keys, use the assistant or prompt
  improvement, or reach any account or server setting: those routes answer
  `403`. Paid cloud models are never offered, even with their keys in the
  environment.
- **Limits.** Each visitor, each address and the whole demo may ask for
  only so many pictures an hour, and start only so many visitors; an IPv6
  address counts by its /64. A turn makes at most a few pictures per model
  from a prompt of at most 1,000 characters, and videos are kept short.
  Each address may make only so many requests a minute and hold a few
  event streams open. When the server has too many jobs under way, the
  visitor has more than two, or the data folder is low on room, new
  pictures wait (`503`). Jobs share the card through the same queue as on
  a server, taking turns between visitors.
- **Nothing is kept for long.** Sessions and pictures older than
  `HATCHLIGHT_DEMO_TTL_HOURS` are deleted every ten minutes, and visitors not
  seen for that long are forgotten.

| Variable                                     | Default                             | What it is                                                                |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `HATCHLIGHT_PUBLIC_URL`                      | `https://$SPACE_HOST`               | The address people open; on a Hugging Face Space, taken from `SPACE_HOST` |
| `HATCHLIGHT_TRUSTED_PROXIES`                 | private networks on a Space         | Proxies whose `X-Forwarded-*` headers are believed                        |
| `HATCHLIGHT_FRAME_ANCESTORS`                 | `https://huggingface.co` on a Space | Sites that may show the demo in a frame, comma-separated                  |
| `HATCHLIGHT_DEMO_MODEL`                      | `sdxl-turbo`                        | The local model installed at start, from the catalog                      |
| `HATCHLIGHT_DEMO_TTL_HOURS`                  | `24`                                | How long pictures, sessions and idle visitors are kept                    |
| `HATCHLIGHT_DEMO_PICTURES_PER_HOUR`          | `20`                                | Pictures each visitor may ask for in an hour                              |
| `HATCHLIGHT_DEMO_PICTURES_PER_HOUR_PER_IP`   | `60`                                | Pictures all visitors from one address may ask for in an hour             |
| `HATCHLIGHT_DEMO_VISITORS_PER_HOUR_PER_IP`   | `30`                                | New visitors one address may start in an hour                             |
| `HATCHLIGHT_DEMO_TOTAL_PICTURES_PER_HOUR`    | `1000`                              | Pictures all visitors together may ask for in an hour                     |
| `HATCHLIGHT_DEMO_TOTAL_VISITORS_PER_HOUR`    | `1000`                              | New visitors all addresses together may start in an hour                  |
| `HATCHLIGHT_DEMO_REQUESTS_PER_MINUTE_PER_IP` | `600`                               | API requests one address may make in a minute                             |
| `HATCHLIGHT_DEMO_MAX_QUEUE`                  | `50`                                | Jobs under way on the server past which new pictures wait                 |
| `HATCHLIGHT_DEMO_MIN_FREE_GB`                | `2`                                 | Free room the data folder keeps; below it, new pictures wait              |
| `HATCHLIGHT_DEMO_MAX_BATCH`                  | `2`                                 | Pictures one turn may ask of each model                                   |
| `HATCHLIGHT_DEMO_MAX_SECONDS`                | `4`                                 | The longest video, in seconds                                             |

Behind a proxy, the demo must see the browser's address and scheme. On a
Hugging Face Space, the proxy connects from a private network and sends
`X-Forwarded-For` and `X-Forwarded-Proto` (of several values, the last,
which the nearest proxy added, counts); when `SPACE_HOST` is set and
`HATCHLIGHT_TRUSTED_PROXIES` is not, the private ranges (`10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, loopback, `fc00::/7`) are trusted, and a
visitor's own public address can never pass for the proxy. If pictures
cannot be made and the browser shows `Forbidden origin`, the proxy came
from elsewhere: set `HATCHLIGHT_TRUSTED_PROXIES` to its address. Limits per
address count the address the trusted proxy reports; trusting the wrong
proxy would put every visitor behind one address, or let them choose their
own. To check, for its first ten minutes the demo logs one request a
minute: `Demo request: peer …, X-Forwarded-For …, client …`. The client
must be the browser's own public address.

Files for a Hugging Face Space are in
[`deploy/huggingface/`](../deploy/huggingface/README.md). The image also
starts as a user other than root (Spaces run it as user 1000): then nothing
is handed over, and the data and models folders must already be writable by
that user.

<a id="threat-model"></a>

## What server mode protects, and what it does not

Hatchlight's server mode is made for a household or a small team who trust
the person running it. In short:

**It protects:**

- **Who gets in.** Every request needs a signed-in account. Passwords are
  hashed; two-step sign-in (TOTP) is available; repeated wrong passwords are
  slowed down. The first account needs the setup code from the server's log.
- **Each person's pictures.** In the app, each person sees only their own
  gallery and sessions.
- **Spending.** Members use paid cloud models only when an admin allows it,
  up to a monthly limit. Quotas keep one person from filling the disk.
- **Agents.** API tokens do only what their permissions name, never more than
  their person may, and stop at their own spending limit. They cannot manage
  accounts or the server, and a browser's sign-in never opens `/mcp`.
- **Saved API keys.** They are never sent back to browsers, and are encrypted
  on disk with the server's secret.
- **Requests from elsewhere.** Requests must name the server's own address
  and come from its own page, which stops other websites and DNS rebinding
  from acting for a signed-in person. `X-Forwarded-*` headers count only from
  trusted proxies.
- **The data on disk.** The data folder and the database are readable by
  the server's user only, so other users and containers on the host cannot
  read them through a shared folder.
- **The container.** The app runs as an unprivileged user, with no Linux
  capabilities and `no-new-privileges`; only the entrypoint starts as root,
  to hand the volumes to `PUID:PGID`.
- **Downloads.** Models and engines are checked against pinned SHA-256
  hashes before they are used.

**It does not protect against:**

- **Whoever runs the server.** Anyone with access to the host, the Docker
  socket or `/data` can read every picture and, with the secret, every saved
  key. `docker exec` can reset any password.
- **Traffic on a network without HTTPS.** On plain `http://`, passwords and
  pictures can be read on the network. Use Tailscale or a proxy with HTTPS.
- **A proxy set up wrong.** `HATCHLIGHT_TRUSTED_PROXIES` trusts what those
  addresses say about the client and the scheme. Trusting a proxy that passes
  on headers from anyone, or a whole network others share, lets them pose as
  someone else's address or as HTTPS.
- **A lost secret.** Without `secret.key` (or the `HATCHLIGHT_SECRET_FILE`),
  saved API keys cannot be read back. Keep it in your backups; anyone who has
  it and the data can read them.
- **The internet at large.** It has no defense against heavy traffic or
  denial of service. Put it behind Tailscale, or a proxy or Cloudflare with
  their own protections, rather than on an open port.
- **People you invite.** They share the card and, if allowed, the cloud keys'
  budget. Prompts and pictures are not moderated.
- **Models themselves.** Models come from their authors on Hugging Face;
  Hatchlight checks that the files are the ones it pins, not what they make.

Report security problems as described in [SECURITY.md](../SECURITY.md).
