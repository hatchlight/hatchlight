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

# What it writes (pictures, backups, keys) is its user's alone.
umask 077

# As root: becomes the hatchlight user, with no capabilities left to it or to
# what it starts, and no way to gain any back (setuid programs included).
if [ "$(id -u)" = 0 ]; then
	exec setpriv --reuid=hatchlight --regid=hatchlight --init-groups \
		--no-new-privs --inh-caps=-all --bounding-set=-all -- "$app" "$@"
fi
exec "$app" "$@"
