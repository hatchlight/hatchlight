# Use it from other apps

Many apps already know how to ask a server for pictures: Open WebUI,
SillyTavern, LibreChat and countless scripts speak OpenAI's image API, and
older tools speak the API of AUTOMATIC1111's Stable Diffusion WebUI.
Hatchlight answers both, so these apps can make pictures with your models.

What they make lands in your gallery like any other picture, in a session for
each app (such as "Image API: OpenAI"), so you can see, keep or redo it.

- [The addresses](#the-addresses)
- [Open WebUI](#open-webui)
- [SillyTavern](#sillytavern)
- [LibreChat](#librechat)
- [From a script](#from-a-script)
- [Models](#models)
- [Paid models](#paid-models)
- [On a server](#on-a-server)
- [What is answered, and the limits](#what-is-answered-and-the-limits)

## The addresses

**Settings > Use with other apps** in Hatchlight shows both, with buttons to
copy them. Started from the command line, Hatchlight listens on port 4096:

| For apps that speak | Address                    |
| ------------------- | -------------------------- |
| OpenAI's image API  | `http://localhost:4096/v1` |
| AUTOMATIC1111's API | `http://localhost:4096`    |

The desktop app may use another port: copy the address from Settings.

On your own computer, Hatchlight answers only programs on this computer, and
never web pages from other sites. Apps that insist on an API key take any
text there, such as `hatchlight`.

## Open WebUI

1. Open **Admin Panel > Settings > Images**.
2. Turn on image generation and choose the **OpenAI** engine (it may be called
   "Default (Open AI)").
3. Set the **API base URL** to the OpenAI address, ending in `/v1`, and the
   **API key** to any text (a token, [on a server](#on-a-server)).
4. Set the **model** to a Hatchlight model id, such as `local/sdxl-turbo`, or
   leave what is there: an unknown model gets the [default](#models).

Open WebUI usually runs in Docker. A container reaches the computer it runs
on from another address (`host.docker.internal` or the Docker bridge), and
Hatchlight on your own computer refuses every address but this computer's
own. Either:

- run the Open WebUI container with `--network=host`, so it shares this
  computer's network, and use `http://localhost:4096/v1`; or
- run Hatchlight [as a server](self-hosting.md), which takes requests from
  other addresses, and give Open WebUI a [token](#on-a-server) as its key.

The same goes for any app in a container, SillyTavern included.

## SillyTavern

1. Open **Extensions > Image Generation**.
2. Choose **Stable Diffusion WebUI (AUTOMATIC1111)** as the source.
3. Set the URL to the AUTOMATIC1111 address, without `/v1`, and connect.
4. Choose a model from the list: a free one is kept as the default for every
   app. A paid one cannot be the default: see [Models](#models).

The sampler, steps and CFG scale SillyTavern sends are ignored: each model
runs with its own settings, the ones it was made for (or, for a model you
added, the ones set in **Models**). A negative prompt is ignored too:
Hatchlight's models take only what to make.

## LibreChat

LibreChat's DALL-E tools take a base URL of their own. In its `.env`:

```sh
DALLE3_BASEURL=http://localhost:4096/v1
DALLE3_API_KEY=hatchlight
```

## From a script

With curl, the picture comes back as base64 PNG:

```sh
curl http://localhost:4096/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a lighthouse at dusk", "size": "1792x1024"}' \
  | jq -r '.data[0].b64_json' | base64 --decode > lighthouse.png
```

With the `openai` package for Python:

```python
import base64
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4096/v1", api_key="hatchlight")
result = client.images.generate(
    model="local/sdxl-turbo",
    prompt="a lighthouse at dusk",
    size="1024x1024",
    n=2,
)
for i, picture in enumerate(result.data):
    with open(f"lighthouse-{i}.png", "wb") as file:
        file.write(base64.b64decode(picture.b64_json))

# Redraw part of a picture: the mask is transparent where to change it.
edited = client.images.edit(
    image=open("lighthouse-0.png", "rb"),
    mask=open("mask.png", "rb"),
    prompt="a full moon in the sky",
)
```

## Models

`GET /v1/models` (and `GET /sdapi/v1/sd-models`) lists the models apps can
use now. Name one by its Hatchlight id, such as `local/sdxl-turbo`; a local
model may also be named without `local/`, or by its name, when only one
matches.

When an app names no model, or one Hatchlight does not have (such as
`dall-e-3`, which Open WebUI sends unless told otherwise), it gets the
default: the free model last chosen through AUTOMATIC1111's options (as
SillyTavern's model list does), or else the best free model installed for the
job. **Settings > Use with other apps** shows which, and sets it back to the
best free model.

The default is always free. A paid model is used only when the request names
it: `model` in OpenAI's API, `override_settings.sd_model_checkpoint` in
AUTOMATIC1111's. Choosing a paid model through `POST /sdapi/v1/options` is
refused, since requests that name no model never spend.

Sizes such as `1792x1024` become the nearest shape the model makes, here
16:9: models make pictures at the sizes they were trained for.

AUTOMATIC1111's `<lora:name:weight>` tags in a prompt use your LoRAs when
the name matches one in **Models > LoRAs** that fits the model.

`<character:name>` and `<style:name>` tags, in either API, use a character
or a style you saved in
[Characters and styles](getting-started.md#characters-and-styles), such as
`a heron <style:Watercolor>`. Names are matched ignoring case and accents,
and part of a name is enough when it fits only one. A name that fits none,
or more than one, refuses the request rather than making the picture
without it. Other tags are left in the prompt as they are.

## Paid models

Other apps use only free models until you turn on **Also let them use
paid models** in **Settings > Use with other apps**. Then a paid model is used
when a request names it, and costs what it costs in the app. On a server,
your own key pays if you have one, else the server's, and the monthly limit
set for each person and the token's own spending limit apply too.

## On a server

When Hatchlight runs [as a server](self-hosting.md), every call needs an API
token, sent as `Authorization: Bearer <token>`: the same tokens agents use,
made in **Settings > Use with AI agents**. In apps, paste the token where they
ask for an API key. A token needs:

- **read** to list models and options;
- **generate** to make pictures (and to choose the default model);
- **paid** as well, for paid models, along with the setting above and an
  account allowed to use them.

Wrong tokens are slowed down, as on `/mcp`. What a token makes lands in its
person's gallery, within their storage.

With `response_format: "url"`, the link points to the picture on the server,
which answers only with a token too: fetch it with the same
`Authorization: Bearer <token>` header, from a token with the **read** scope.

## What is answered, and the limits

OpenAI's API:

- `POST /v1/images/generations`: `prompt`, `model`, `n` (1 to 8), `size`,
  `response_format` (`b64_json`, the default, or `url`, a link to the picture
  on this Hatchlight), and `seed`, which OpenAI does not have. `quality` and
  `style` are ignored.
- `POST /v1/images/edits`: the same, as a form with one or more `image` files
  and an optional `mask` (transparent where to change). A mask needs one
  picture and a model that redraws only part of one; otherwise the request
  is refused, rather than redrawing all of it.
- `GET /v1/models`.

AUTOMATIC1111's API:

- `POST /sdapi/v1/txt2img` and `POST /sdapi/v1/img2img` (with `init_images`,
  `mask`, `inpainting_mask_invert` and `denoising_strength`), which answer
  `images`, `parameters` and `info` with the seed used and the size made.
  `seed: -1` is a new seed each time. `steps`, `cfg_scale` and
  `sampler_name` are ignored, and `info` gives them as `null`.
- `GET /sdapi/v1/sd-models`, `GET` and `POST /sdapi/v1/options` (only
  `sd_model_checkpoint` is kept), `GET /sdapi/v1/loras`, `/samplers`,
  `/schedulers`, `/upscalers`, `/sd-vae`, `GET /sdapi/v1/progress` and
  `POST /sdapi/v1/interrupt`.

Limits:

- A local model makes one picture at a time: requests wait their turn, and
  each waits up to 15 minutes for its pictures. An app that gives up cancels
  what it asked for.
- At most 16 requests wait at once on your own computer, from all apps
  together; on a server, 4 for each token. One more is refused with
  `429 Too Many Requests` until one ends.
- Each picture sent may be up to 20 MB and 4096 pixels on a side.
- Each app gets its own session, up to 20 apps; the rest share one called
  "Image API".
- Paid models are off for other apps until you turn them on.
- On a server, every call needs a token.
