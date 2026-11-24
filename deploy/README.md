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
