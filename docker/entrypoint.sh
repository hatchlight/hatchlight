#!/bin/sh
# Starts Hatchlight in its container. As root it only gives the `hatchlight`
# user the ids the volumes belong to (PUID and PGID, as NAS users know them)
# and makes the volumes that user's; the app itself never runs as root.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = 0 ]; then
	case "$PUID$PGID" in
	*[!0-9]*)
		echo "PUID and PGID must be numbers (got PUID=$PUID PGID=$PGID)." >&2
		exit 64
		;;
	esac
	if [ "$PUID" = 0 ] || [ "$PGID" = 0 ]; then
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
