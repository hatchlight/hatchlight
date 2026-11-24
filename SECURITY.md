# Security

Hatchlight keeps API keys and private pictures on people's computers, so
security problems matter a lot to us.

## Report a problem

Please report it privately, not in a public issue: open
[a private vulnerability report](https://github.com/hatchlight/hatchlight/security/advisories/new)
(the **Security** tab of the repository, **Report a vulnerability**). Only the
maintainers see the report.

Say what an attacker could do, and how to reproduce it. We answer within a
week, keep you informed while we fix it, and credit you in the release notes
unless you prefer otherwise.

## Disclosure

We aim to release a fix within 90 days of the report, sooner for problems that
are easy to exploit. Once the fix is out, we publish a
[security advisory](https://github.com/hatchlight/hatchlight/security/advisories)
that describes the problem, the affected versions and the version that fixes
it. Please keep the problem private until then; if 90 days pass without a fix,
tell us before you disclose it.

## What counts

Anything that lets someone other than the person running Hatchlight read their
keys, pictures or prompts, run code on their computer, or make requests with
their keys. For example: another website reaching the local server, a crafted
model download or engine running something it should not, a key sent to the
wrong provider, or a path escaping the data directory.

On a server ([server mode](docs/self-hosting.md)), also:

- one member reaching another's pictures, sessions or own API keys;
- getting past one's permissions or limits: training, paid models, the
  monthly limit, storage quotas, or an admin's or owner's actions;
- signing in without the password or the second step, or taking over an
  account, a session or an invite;
- an API token doing more than its permissions or spending limit allow, or
  reaching `/mcp` without one;
- CSRF or DNS rebinding against a server, or forged `X-Forwarded-*` headers
  believed from outside the trusted proxies;
- escaping the Docker image's defaults: the app gaining root or capabilities,
  or reading the data from outside the container in a setup the guide
  recommends.

## Threat model

Server mode is made for a household or a small team who trust the person
running it.

It protects: who gets in (accounts, two-step sign-in, a setup code only the
log shows); each person's pictures from the others; what members may do and
spend; what agents may do, through API tokens limited to what they were
given; saved API keys, encrypted at rest; the data folder, readable by the
server's user only; and the host, with the app unprivileged in its container.

It does not protect against: a compromised host, or an admin acting in bad
faith (whoever controls the host or `/data` controls everything); a reverse
proxy trusted but set up wrong; plain `http://` on a network you do not
trust; or a lost `secret.key`, without which saved keys cannot be read back.

The full version is in
[the self-hosting guide](docs/self-hosting.md#threat-model).

## Supported versions

Fixes go into the latest release. Please check that a problem still happens
there before reporting it.
