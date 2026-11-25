#!/bin/sh
# Starts Hatchlight in its container. As root it only gives the `hatchlight`
# user the ids the volumes belong to (PUID and PGID, as NAS users know them)
# and makes the volumes that user's; the app itself never runs as root.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = 0 ]; then
	case "$PUID" in "" | *[!0-9]*) bad=1 ;; esac
	case "$PGID" in "" | *[!0-9]*) bad=1 ;; esac
	if [ -n "${bad:-}" ]; then
		echo "PUID and PGID must be numbers (got PUID=$PUID PGID=$PGID)." >&2
		exit 64
	fi
	# As decimal numbers, without leading zeros: 00 is 0 and 0010 is 10. (The
	# shell is dash: no $((10#...)), and $((010)) would be octal.)
	while [ "${PUID#0}" != "$PUID" ] && [ -n "${PUID#0}" ]; do PUID=${PUID#0}; done
	while [ "${PGID#0}" != "$PGID" ] && [ -n "${PGID#0}" ]; do PGID=${PGID#0}; done
	if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
		echo "Hatchlight does not run as root: set PUID and PGID to a user, such as 1000." >&2
		exit 64
	fi
	[ "$(id -g hatchlight)" = "$PGID" ] || groupmod --non-unique --gid "$PGID" hatchlight
	[ "$(id -u hatchlight)" = "$PUID" ] || usermod --non-unique --uid "$PUID" hatchlight

	for dir in "$HATCHLIGHT_DATA_DIR" "$HATCHLIGHT_MODELS_DIR" "$HATCHLIGHT_TRAINER_DIR" "$HOME"; do
		mkdir -p "$dir"
		# Only when something is not the user's: models can be many GB.
		if [ -n "$(find "$dir" ! -user "$PUID" -print -quit 2>/dev/null)" ] ||
			[ -n "$(find "$dir" ! -group "$PGID" -print -quit 2>/dev/null)" ]; then
			echo "Giving $dir to $PUID:$PGID"
			chown -R "$PUID:$PGID" "$dir" ||
				echo "Could not change the owner of $dir (a network share?); make it writable by $PUID:$PGID." >&2
		fi
	done
	# Accounts, keys and pictures, and the trainer's: their user's alone, on
	# installs made before this too.
	chmod 700 "$HATCHLIGHT_DATA_DIR" "$HATCHLIGHT_TRAINER_DIR" ||
		echo "Could not make $HATCHLIGHT_DATA_DIR private (a network share?)." >&2
else
	# Started as a user already (docker run --user, a hosted container such
	# as a Hugging Face Space): nothing can be handed over, so the folders
	# must be that user's to write. Said plainly, before the app fails.
	for dir in "${HATCHLIGHT_DATA_DIR:-}" "${HATCHLIGHT_MODELS_DIR:-}"; do
		[ -n "$dir" ] || continue
		if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
			echo "Hatchlight runs as user $(id -u), who cannot write to $dir. Make it writable by that user, or start the container as root with PUID and PGID set." >&2
			exit 73
		fi
	done
fi

# Said here with an example for Docker, before the app says it its own way.
if [ "${1:-serve}" = serve ] && [ "${HATCHLIGHT_MODE:-}" = server ] &&
	[ -z "${HATCHLIGHT_PUBLIC_URL:-}" ]; then
	cat >&2 <<'EOF'

Hatchlight needs HATCHLIGHT_PUBLIC_URL: the address people type in their
browser to reach it. For example, on your home network:

  docker run ... -e HATCHLIGHT_PUBLIC_URL=http://192.168.1.20:4096 ...

or in compose.yaml:

  environment:
    HATCHLIGHT_PUBLIC_URL: http://nas.local:4096

Behind HTTPS (Tailscale, Caddy, a Cloudflare Tunnel), use that address, such
as https://hatchlight.example.com. See docs/self-hosting.md.

EOF
	exit 64
fi

exec /usr/local/bin/hatchlight "$@"
