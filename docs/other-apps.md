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

If Open WebUI runs in Docker on the same computer, `localhost` is the
container itself: Hatchlight on your own computer cannot be reached from
there, because it answers only this computer. Run Hatchlight
[as a server](self-hosting.md) to share it with containers and other
machines.

## SillyTavern

1. Open **Extensions > Image Generation**.
2. Choose **Stable Diffusion WebUI (AUTOMATIC1111)** as the source.
3. Set the URL to the AUTOMATIC1111 address, without `/v1`, and connect.
4. Choose a model from the list: it is kept as the default for every app.

Samplers, steps and the CFG scale that SillyTavern shows are accepted and
left to Hatchlight, which sets them for each model. A negative prompt is
ignored: Hatchlight's models take only what to make.

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
`dall-e-3`), it gets the default: the model last chosen through
AUTOMATIC1111's options (as SillyTavern's model list does), or else the best
free model installed for the job. The default is always free; a paid model is
used only when an app names it.

Sizes such as `1792x1024` become the nearest shape the model makes, here
16:9: models make pictures at the sizes they were trained for.

AUTOMATIC1111's `<lora:name:weight>` tags in a prompt use your LoRAs when
the name matches one in **Models > LoRAs** that fits the model. Other tags
are left in the prompt as they are.

## Paid models

Other apps use only free models until you turn on **Also let them use
paid models, on your keys** in **Settings > Use with other apps**. Then a paid
model is used when an app names it, and costs what it costs in the app. On a
server, the monthly limit set for each person and the token's own spending
limit apply too.

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

## What is answered, and the limits

OpenAI's API:

- `POST /v1/images/generations`: `prompt`, `model`, `n` (1 to 8), `size`,
  `response_format` (`b64_json`, the default, or `url`, a link to the picture
  on this Hatchlight), and `seed`, which OpenAI does not have. `quality` and
  `style` are ignored.
- `POST /v1/images/edits`: the same, as a form with one or more `image` files
  and an optional `mask` (transparent where to change), for models that can.
- `GET /v1/models`.

AUTOMATIC1111's API:

- `POST /sdapi/v1/txt2img` and `POST /sdapi/v1/img2img` (with `init_images`,
  `mask`, `inpainting_mask_invert` and `denoising_strength`), which answer
  `images`, `parameters` and `info` with the seed used. `seed: -1` is a new
  seed each time.
- `GET /sdapi/v1/sd-models`, `GET` and `POST /sdapi/v1/options` (only
  `sd_model_checkpoint` is kept), `GET /sdapi/v1/loras`, `/samplers`,
  `/schedulers`, `/upscalers`, `/sd-vae`, `GET /sdapi/v1/progress` and
  `POST /sdapi/v1/interrupt`.

Limits:

- A local model makes one picture at a time: requests from several apps wait
  their turn, and each waits up to 15 minutes for its pictures. An app that
  gives up cancels what it asked for.
- Each picture sent may be up to 20 MB.
- Paid models are off for other apps until you turn them on.
- On a server, every call needs a token.
