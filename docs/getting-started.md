# Getting started with Hatchlight

This guide is for people who want to make pictures and videos with
Hatchlight, with no experience of AI models needed. It covers the desktop app;
to run Hatchlight for a household or a team, see
[Self-hosting](self-hosting.md), and for the command line and AI agents, see
[Command line and agents](command-line.md).

- [Install](#install)
- [Your first picture](#your-first-picture)
- [Which model to start with](#which-model-to-start-with)
- [Cloud models, with your key](#cloud-models-with-your-key)
- [Chat and Advanced](#chat-and-advanced)
- [Change a picture](#change-a-picture)
- [The gallery](#the-gallery)
- [Your own styles: LoRAs and models](#your-own-styles)
- [When something goes wrong](#when-something-goes-wrong)
- [Words used here](#words-used-here)

## Install

Download the installer for your system from the
[latest release](https://github.com/hatchlight/hatchlight/releases/latest)
and run it. The app updates itself when a new version comes out.

The installers are not signed yet, so your system may warn you the first
time:

- **Windows:** if Windows says it protected your computer, choose **More
  info**, then **Run anyway**.
- **macOS:** if macOS says the app is damaged or cannot be opened, move it to
  Applications, run `xattr -cr /Applications/Hatchlight.app` in Terminal, and
  open it again.

Signing the Windows installers is being set up; the
[code signing policy](../CODE_SIGNING_POLICY.md) says how it will work.

Hatchlight needs no account. Check [Where it runs](../README.md#where-it-runs)
to see whether models can run on your computer; if they cannot, cloud models
still work.

## Your first picture

The first time you open Hatchlight, it shows **Choose a model and start
creating**:

1. At the top, choose **Image** or **Video**.
2. **Your computer** shows your graphics card and how much memory it has.
   Hatchlight uses it to tell which models will run well; there is nothing
   to do there.
3. The model marked **Recommended**, under **Best for you**, is a good first
   choice. Each model on your computer says how it runs here:
   - **Runs great here**: it fits in the graphics card's memory.
   - **May be slow**: it borrows the computer's own memory, which works but
     takes longer.

   Models too big for your computer are hidden at the end of the list.
   **See the difference before you choose** shows the same prompt drawn by
   each model.

4. Choose **Download and use**. The button shows the download's size. The
   model goes through **Downloading**, **Checking** and **Ready**. It is
   downloaded once, and then works offline.
5. In **Describe what you want to create**, write what you want to see, or
   pick one of the suggestions, and choose **Generate**.

The picture sharpens on screen while it forms. If you already know your way,
**Skip, I know my way around** goes straight to an empty session.

Models on your computer are free, and nothing you make leaves it. Cloud
models are paid per picture or video, to the service that runs them (see
[below](#cloud-models-with-your-key)).

## Which model to start with

Models need graphics card memory, sometimes called VRAM. Many come in
several versions: a larger one (16-bit) that looks best, and smaller ones
(8-bit and 4-bit) for cards with less memory. Hatchlight installs the best
version that fits your computer, so you do not need to choose. To pick
another one, open the model on the **Models** screen and choose **Install
this version**.

Good first models, with the graphics card memory each version needs to run
at full speed:

| Model                | Makes                                | Memory needed   |
| -------------------- | ------------------------------------ | --------------- |
| SDXL Turbo           | Pictures, in a second or two         | 8 GB            |
| Stable Diffusion 1.5 | Small pictures, on weak cards        | 4 to 5 GB       |
| Z-Image Turbo        | Pictures, good with text             | 6, 9 or 15 GB   |
| FLUX.1 schnell       | Pictures                             | 9 or 15 GB      |
| Stable Diffusion XL  | Pictures, slower and richer          | 9 GB            |
| Wan 2.1 1.3B         | Short videos, from words only        | 7 GB            |
| Wan 2.2 5B           | 720p videos, from words or a picture | 10, 12 or 17 GB |

On a card with less memory than that, a model may still run, more slowly.
On a computer with no graphics card Hatchlight can use, the first screen
suggests a cloud model instead.

The **Models** screen lists every model, with its size, what it is good
at, how it runs here (**Runs well here** or **Runs slowly: not enough
graphics memory**), and whether its license allows commercial use. Models
take 2 to 30 GB of disk each.

## Cloud models, with your key

Cloud models are the largest ones on the market: FLUX, GPT Image, Nano
Banana, Veo, Kling and more. They run on the service's computers, and you pay
the service for what you make, with your own account there.

To use one, you need an API key from the service: a long code that lets
Hatchlight use your account.

| Service    | Where to get a key                                                           |
| ---------- | ---------------------------------------------------------------------------- |
| fal        | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys)                       |
| OpenAI     | [platform.openai.com/api-keys](https://platform.openai.com/api-keys)         |
| Google     | [aistudio.google.com/apikey](https://aistudio.google.com/apikey)             |
| Replicate  | [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens) |
| OpenRouter | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys)           |

fal and Replicate each give access to many picture and video models with one
key. OpenAI, Google and OpenRouter keys also run the assistant (see
[Chat](#chat-and-advanced)). Paste the key when Hatchlight asks for it
(**Paste your API key**, then **Save and continue**), or in **Settings >
Providers**. The key stays on your computer and is sent only to its service.

Each result shows what it cost, and the assistant asks before it uses a paid
model.

## Chat and Advanced

Everything you make belongs to a **session**. **New session** in the sidebar
starts one, and **Sessions** lists the earlier ones. Each session can be
worked in two ways, switched at the top:

- **Chat**: talk to the assistant as you would to a person. Ask for "a fox
  in the snow", then "make it bigger", "now in 16:9, with FLUX", or "try
  another model". It picks models, writes the prompts and makes the
  pictures. The assistant needs a key for OpenAI, Google or OpenRouter. In
  the Windows app it can also run on your computer, for free, once its
  language model is installed in **Settings**.
- **Advanced**: every setting in view, with no assistant needed. Choose one
  or more **Models** and write a prompt: each model makes its own take, side
  by side, with its time and cost. Click a picture to choose it; the panel on
  the side shows what to do next, and **Open large** shows it full size.

Both show the same session, so you can switch at any time.

You can write in your own language. Some models (SDXL, FLUX.1, Chroma) read
prompts well only in English. **Settings > Prompt translation** puts your
prompt into English for them, and you see what was sent: choose **Translate
with**, and install the translator if it asks. **Improve prompt** turns a
short idea into a detailed prompt. Both run on your computer on Windows; on
macOS and Linux they need a cloud key.

## Which model you prefer

When you compare models, mark the result you like best with **This one**
under it; press it again to clear it, or pick another. It works in both
views, with the mouse or the keyboard.

**Models you prefer** in the sidebar ranks the models by your picks: how
many comparisons each won, and its median time and cost per picture on your
computer. Narrow it to pictures or videos, the last 30 days, or a kind of
prompt, such as portraits, text in the picture or editing. A model with few
comparisons is marked and ranks lower until there are more, so one lucky win
does not top the list.

To choose without knowing which model made what, turn on **Settings >
Comparisons > Hide model names until I pick**: the results show as Model A,
Model B…, in an order of their own, until you pick.

**Copy as Markdown** and **Download image** share the ranking with only the
model names, the numbers, your GPU and the date; tick **Include one example
per model** to add the pictures you picked. In the terminal,
`hatchlight ranking --kind portrait` prints the same, and agents can ask for
it with the `model_ranking` tool. When you leave the model to the assistant,
it uses your favourite once you have picked enough.

## Change a picture

Any picture can be the start of the next one. Click it, then:

- **Use as reference**: the next prompt starts from this picture.
- **Upscale ×4**: makes the picture four times larger. It appears once the
  Real-ESRGAN model is installed from **Models**.
- **Talk about it**: ask the assistant about this picture.

Once a picture is the reference, the **Advanced** view shows it under
**Reference images**, with more tools:

- **Change** sets how much of the picture may change, from a little to
  almost everything.
- Click the small picture to crop it, turn it left or right, or flip it.
- **Mark area**: paint over the part to redraw, with the brush and the
  eraser, then **Use this area**. The rest stays as it is.
- **Make room**: give the picture a new shape or more space around it, and a
  model draws what is new.

**Mark area** and **Make room** need a single reference and a model that can
redraw part of a picture; they appear when one is chosen. **Add reference
image** adds a picture of your own.

To make a picture move, use it as the reference, switch to **Video**, and
describe how it should move: the picture becomes the video's first frame.
This needs a video model that starts from a picture, such as Wan 2.2 5B or a
cloud video model.

## The gallery

Every picture and video is saved on your computer, with the prompt and
settings that made it. **Gallery** shows them all, and **Search prompts**
finds them again. Deleting a session keeps its pictures in the gallery.

## Your own styles

A LoRA is a small file that teaches a model a style or a subject. On the
**Models** screen:

- **Add a LoRA**: add one you downloaded. LoRAs are made for one family of
  models, such as SDXL, Stable Diffusion 1.5, FLUX, Z-Image or Wan.
- **Add a model**: add a whole Stable Diffusion XL or 1.5 model (a
  checkpoint), as a `.safetensors` file.
- **Models from other apps**: already have models in ComfyUI, AUTOMATIC1111,
  Forge or Stability Matrix? Add that app's folder (or its models folder),
  or pick it when Hatchlight finds it. Its checkpoints and LoRAs show up with
  yours and are used where they are: nothing is copied, moved or deleted.
  Only SDXL and SD 1.5 checkpoints, and LoRAs for a family Hatchlight runs,
  are used; other files are counted as skipped. Hatchlight looks again each
  time it starts, or when you choose **Look again**.
- **Train a LoRA**: teach Stable Diffusion XL a subject or style from your
  own pictures. It needs Windows (or WSL), an NVIDIA card with 12 GB of
  memory, and Stable Diffusion XL installed. It downloads about 6 GB of tools
  the first time (**Install the trainer**). Then:
  1. Give it a **Name** and a **Trigger word**: a made-up word, such as
     `qzporcelain`, that stands for what it learns.
  2. Add 10 to 30 sharp pictures, **From this computer** or **From your
     pictures**, varied in angle and background.
  3. Describe each picture, or let Hatchlight do it with **Describe them**
     (it needs the Qwen2.5-VL model).
  4. Confirm that you may use the pictures, and choose **Start training**.
     800 steps take about 10 minutes on a 12 GB card.
  5. **How it is learning** shows sample pictures along the way. If one
     already looks right, stop there and keep that step.

To use a LoRA, choose it under **Styles (LoRA)** in the **Advanced** view,
with a model of its family. Its trigger word is added to your prompt for
you.

## When something goes wrong

**"… does not run on this computer".** The model, or the version you picked,
needs more memory than your computer has. Pick a model marked **Runs well
here**, a smaller version of it (**Install this version**), or a cloud model.

**Generating is very slow.** The model borrows the computer's memory (**Runs
slowly: not enough graphics memory**). Try a smaller model or version. If it
says **Waiting for another Hatchlight to free the graphics card**, other
pictures, another copy of Hatchlight, or a LoRA being trained are using the
card, and yours starts when it is free.

**Chat does not answer, or asks you to set up the assistant.** The assistant
needs a key for OpenAI, Google or OpenRouter, or, in the Windows app, its
language model in **Settings**. Without one, use **Advanced**.

**"… cannot use reference images".** That model makes pictures or videos
from words only. Choose another, such as one that edits pictures, or Wan 2.2
5B for video.

**"Could not download …" or the download was cut short.** The site that
hosts the model was busy or the connection dropped. Try again: the download
resumes where it stopped.

**"Not enough disk space".** Free some space, or move your models to another
disk: **Models > Folder for models > Change**.

**"The engine for … is not installed" or "The engine download is damaged".**
Install the model again from **Models**.

**"Add your … key in Settings to use this model".** That model runs in the
cloud: add a key for its service (see
[Cloud models](#cloud-models-with-your-key)).

**The picture does not follow the prompt.** Try another model: each one
draws in its own way, and some read prompts well only in English (see
**Prompt translation** [above](#chat-and-advanced)). **Improve prompt** often
helps too.

**Where are my files?** See [Your data](../README.md#your-data).

Something else? Open an
[issue](https://github.com/hatchlight/hatchlight/issues/new/choose) and say
what you did, what happened, and your system and graphics card.

## Words used here

- **Model**: the AI that makes the pictures. Each draws in its own way.
- **Local model**: runs on your computer, free and private, once downloaded.
- **Cloud model**: runs on a service's computers, paid with your key.
- **Graphics card memory (VRAM)**: the memory on your graphics card. It
  decides which models run fast. On a Mac with Apple Silicon, the computer's
  memory is shared with the graphics.
- **Version (16-bit, 8-bit, 4-bit)**: the same model made smaller to fit
  cards with less memory, at a small cost in quality.
- **Prompt**: the words that describe what you want.
- **Reference**: a picture the next one starts from.
- **Mark area**: painting over the part of a picture to redraw (a mask).
- **LoRA**: a small add-on that teaches a model a style or a subject.
- **Checkpoint**: a whole model file, such as a community version of Stable
  Diffusion XL.
- **API key**: the code that lets Hatchlight use your account on a cloud
  service.
- **WSL**: Windows Subsystem for Linux, a way to run Linux inside Windows.
  Only needed if you run Hatchlight from source.
