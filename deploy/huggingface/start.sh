#!/bin/sh
# Starts the public demo in a Hugging Face Space. Its data goes to /data, the
# Space's persistent storage, when the Space has it; otherwise to a folder in
# the container, which goes when the Space restarts (and the model with it,
# downloaded again at the next start).
set -eu

if ! mkdir -p "$HATCHLIGHT_DATA_DIR" "$HATCHLIGHT_MODELS_DIR" 2>/dev/null ||
	[ ! -w "$HATCHLIGHT_DATA_DIR" ] || [ ! -w "$HATCHLIGHT_MODELS_DIR" ]; then
	echo "No persistent storage at $HATCHLIGHT_DATA_DIR: keeping the demo's data in the container." >&2
	HATCHLIGHT_DATA_DIR=/tmp/hatchlight/data
	HATCHLIGHT_MODELS_DIR=/tmp/hatchlight/models
	export HATCHLIGHT_DATA_DIR HATCHLIGHT_MODELS_DIR
fi

exec /usr/local/bin/docker-entrypoint "$@"
