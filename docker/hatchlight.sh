#!/bin/sh
# `hatchlight` in the image: runs the program with the web app and the
# migrations that came with it, and never as root. `docker exec hatchlight
# hatchlight users list` comes through here too, as the same user as the
# server, so the files it writes stay the server's.
set -eu

app=/opt/hatchlight/bin/hatchlight
resources=/opt/hatchlight/resources

# What reads the web app or the database migrations is told where they are.
case "${1:-serve}" in
serve | -*) set -- "$@" --resources "$resources" ;;
users) set -- "$@" --resources "$resources" ;;
esac

if [ "$(id -u)" = 0 ]; then
	exec setpriv --reuid=hatchlight --regid=hatchlight --init-groups -- "$app" "$@"
fi
exec "$app" "$@"
