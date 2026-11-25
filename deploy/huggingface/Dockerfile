# Hatchlight's public demo as a Hugging Face Docker Space. See README.md.
#
# Demo mode came in 0.5.0. Pinned to a release, so the Space changes only
# when this line does.
ARG HATCHLIGHT_IMAGE=ghcr.io/hatchlight/hatchlight:0.5.0
FROM ${HATCHLIGHT_IMAGE}

COPY start.sh /usr/local/bin/demo-start
RUN chmod 755 /usr/local/bin/demo-start

# The public address comes from SPACE_HOST, which the Space sets, and the
# Space's proxy is trusted on its private network. Data and the model go to
# the Space's persistent storage at /data when it has it.
ENV HATCHLIGHT_MODE=demo \
	HATCHLIGHT_DATA_DIR=/data/hatchlight \
	HATCHLIGHT_MODELS_DIR=/data/hatchlight/models

# Spaces run their container as user 1000, with no capabilities to drop.
USER 1000:1000
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
	CMD ["env", "BUN_BE_BUN=1", "/opt/hatchlight/bin/hatchlight", "-e", "fetch('http://127.0.0.1:7860/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/demo-start"]
CMD ["serve", "--port", "7860"]
