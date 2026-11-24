# Deploying Hatchlight

Files to run the Docker image `ghcr.io/hatchlight/hatchlight`. The guide,
with requirements, first run, backups and troubleshooting, is
[docs/self-hosting.md](../docs/self-hosting.md).

| File                                               | What it runs                                                |
| -------------------------------------------------- | ----------------------------------------------------------- |
| [`compose.yaml`](compose.yaml)                     | Hatchlight on your home network, port 4096                  |
| [`compose.tailscale.yaml`](compose.tailscale.yaml) | On your tailnet with HTTPS, nothing published (recommended) |
| [`compose.caddy.yaml`](compose.caddy.yaml)         | Under your domain, with HTTPS from Caddy                    |
| [`unraid/hatchlight.xml`](unraid/hatchlight.xml)   | An Unraid template                                          |

A Cloudflare Tunnel and TrueNAS SCALE are covered in the guide.

The Hatchlight service runs with `no-new-privileges` and only the
capabilities its entrypoint needs to hand the volumes to `PUID:PGID`; the
app itself runs with none. The Tailscale and Caddy images are named by
version, not pinned by digest, on purpose: they are the parts facing the
network, and should get their security fixes when you pull.
