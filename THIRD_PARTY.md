# Third-party software

Hatchlight is MIT licensed (see [LICENSE](LICENSE)). It builds on other
people's work. Some of it ships inside the app, and the rest is downloaded the
first time you use a feature that needs it. Each part keeps its own license.

## Downloaded when you need it

Hatchlight checks the hash of every file it downloads before using it.

| What                                                                                    | Used for                                                                         | License                                                        |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)                  | Making pictures and videos on your computer                                      | MIT                                                            |
| NVIDIA CUDA runtime, from stable-diffusion.cpp's releases                               | Running that engine on NVIDIA cards on Windows                                   | [NVIDIA CUDA Toolkit EULA](https://docs.nvidia.com/cuda/eula/) |
| [llama.cpp](https://github.com/ggml-org/llama.cpp)                                      | Prompt translation, Improve prompt, the local assistant and picture descriptions | MIT                                                            |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) weights                           | Upscaling ×4                                                                     | BSD-3-Clause                                                   |
| [uv](https://github.com/astral-sh/uv)                                                   | Installing the LoRA trainer's Python                                             | MIT or Apache-2.0                                              |
| Python, through uv's builds                                                             | Running the LoRA trainer                                                         | [PSF License](https://docs.python.org/3/license.html)          |
| [PyTorch](https://pytorch.org), from download.pytorch.org                               | Running the LoRA trainer on the graphics card                                    | BSD-3-Clause                                                   |
| [sd-scripts](https://github.com/kohya-ss/sd-scripts) and its Python packages, from PyPI | Training LoRAs                                                                   | Apache-2.0; each package its own                               |

## Models

Each model in the catalog has its own license, set by its authors. The Models
screen links to it and says whether commercial use is allowed. Every model in
the catalog allows commercial use, except SDXL Turbo, which allows it only
under a yearly revenue limit. See `packages/providers/src/local-models/` for
each model's license and link.

Models you import yourself, such as LoRAs and checkpoints, come with the
licenses their authors chose. Checking them is up to you.

## Inside the app

- [Tauri](https://tauri.app), MIT or Apache-2.0, for the desktop window and
  updates.
- [Bun](https://bun.sh), MIT, which runs the server.
- The fonts Bricolage Grotesque, Inter Tight and IBM Plex Mono, through
  [Fontsource](https://fontsource.org), SIL Open Font License 1.1.
- The JavaScript and Rust packages listed in `bun.lock` and
  `apps/desktop/src-tauri/Cargo.lock`, each under its own license.
