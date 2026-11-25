# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

The Windows installers of Hatchlight are signed with a certificate issued to
SignPath Foundation. Windows shows **SignPath Foundation** as the publisher.

## What is signed

Only files built from this repository by the
[Desktop workflow](.github/workflows/desktop.yml) on GitHub-hosted runners,
for a release tag (`v*`): the Windows installers (`.exe` made with NSIS and
`.msi`). Nothing built on a person's computer is signed.

The installers contain programs from other open source projects, unchanged
and unsigned by us: the [Bun](https://bun.sh) runtime inside the Hatchlight
server, and the libraries listed in [THIRD_PARTY.md](THIRD_PARTY.md). The
engines that run models (such as
[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)) are
not in the installers: Hatchlight downloads them when a person installs a
model.

## Team

- Committers and reviewers: the
  [members of the Hatchlight organization](https://github.com/orgs/hatchlight/people).
  Every change from anyone else comes as a pull request and is reviewed by
  one of them before it is merged.
- Approvers: the
  [owners of the Hatchlight organization](https://github.com/orgs/hatchlight/people?query=role%3Aowner).
  Each signing request is approved by hand, one release at a time.

Everyone with these roles uses multi-factor authentication on GitHub and
SignPath.

## Privacy

Hatchlight has no telemetry and no account. It connects to other systems
only for what the person using it does or sets up:

- **Updates (desktop app):** it asks
  [GitHub](https://github.com/hatchlight/hatchlight/releases) whether there is
  a new version, and downloads it from there.
- **Models on this computer:** when a person installs a model, the engine or
  the LoRA trainer, the files come from
  [Hugging Face](https://huggingface.co), GitHub or the
  [PyTorch](https://download.pytorch.org) download site. The model list shows
  sample pictures and videos from the models' own pages.
- **Cloud models:** prompts and pictures are sent to fal, Replicate,
  OpenRouter, OpenAI or Google only when the person chooses one of their
  models, with the person's own key.
- **Server mode:** a Hatchlight server answers the people and apps its owner
  lets in.

Pictures, prompts, keys and settings stay on the computer (or the server)
that runs Hatchlight. See [SECURITY.md](SECURITY.md) to report a problem.
