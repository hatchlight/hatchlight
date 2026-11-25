---
title: Hatchlight
emoji: 🥚
colorFrom: yellow
colorTo: pink
sdk: docker
app_port: 7860
license: mit
short_description: Make pictures with local AI models, free and open source
---

# Hatchlight, public demo

Try [Hatchlight](https://hatchlight.app) in the browser: make pictures with
SDXL Turbo, no account needed. Your pictures are seen only by you and
deleted after 24 hours. To use your own GPU, with every model, install
Hatchlight from [hatchlight.app](https://hatchlight.app) or
[GitHub](https://github.com/hatchlight/hatchlight).

## For the Space's owner

These files make a [Docker Space](https://huggingface.co/docs/hub/spaces-sdks-docker)
from the published image, `ghcr.io/hatchlight/hatchlight`, in demo mode.

1. Create a Space with the Docker SDK and copy this folder's files into its
   repository: `README.md` (this file, whose front matter sets up the
   Space), `Dockerfile` and `start.sh`.
2. Build from a release that has demo mode (after 0.4.2): set
   `HATCHLIGHT_IMAGE` in the Dockerfile to, for example,
   `ghcr.io/hatchlight/hatchlight:0.5.0`. `latest` works, but changes with
   every release.
3. Choose hardware with an NVIDIA GPU; SDXL Turbo needs about 8 GB of
   memory.
4. Optional: turn on persistent storage. The demo then keeps its data and
   the model (about 7 GB) in `/data` across restarts; without it, the model
   is downloaded again each time the Space starts.

At start the log shows `Installing the demo model SDXL Turbo` and its
progress, then `Demo model installed`. Until then visitors see the model as
not ready.

Settings go in the Space's variables; see
[A public demo](https://github.com/hatchlight/hatchlight/blob/main/docs/self-hosting.md#public-demo)
for all of them. The usual ones:

| Variable                            | Default      | What it is                                   |
| ----------------------------------- | ------------ | -------------------------------------------- |
| `HATCHLIGHT_DEMO_MODEL`             | `sdxl-turbo` | The model installed at start                 |
| `HATCHLIGHT_DEMO_TTL_HOURS`         | `24`         | How long pictures and sessions are kept      |
| `HATCHLIGHT_DEMO_PICTURES_PER_HOUR` | `20`         | Pictures each visitor may ask for in an hour |

The public address comes from `SPACE_HOST`, which the Space sets, and the
Space's proxy is trusted on its private network, so per-visitor limits see
each visitor's own address. Check it once the Space runs:

```sh
curl -s https://api.ipify.org; echo        # your own public address
curl -s https://<owner>-<space>.hf.space/api/health
```

In the Space's logs, the line `Demo request: peer …, X-Forwarded-For …,
client …` (written for one request a minute, in the first ten minutes)
must end with `client` and the first address. Lines with no
X-Forwarded-For are the Space's own checks: look for the one with your
address, and run the `curl` again a minute later if needed. If `client` is a private
address such as `10.x.x.x`, set `HATCHLIGHT_TRUSTED_PROXIES` to the `peer`
address's network in the Space's variables. Do not add cloud keys to the Space: the demo
never uses paid models, whatever keys it has.
