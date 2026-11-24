# syntax=docker/dockerfile:1

# Hatchlight as a server for a home server or NAS with an NVIDIA card.
# See docs/self-hosting.md. Images are pinned by digest; the tags are for
# people reading this.
ARG BUN_IMAGE=oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e
ARG CUDA_IMAGE=nvidia/cuda:12.8.1-runtime-ubuntu22.04@sha256:4a801ef9232d2b05e69df4eb8aa054dbbe2824e5499e1e6e857320bb01ac41a9

# The Linux engines, exactly as the app would download them: the archives,
# sizes and hashes come from the catalog. Only these files are copied, so the
# download is redone only when the catalog changes.
FROM ${BUN_IMAGE} AS engines
WORKDIR /src
COPY scripts/docker-engines.ts scripts/
COPY packages/core/src/local/tar.ts packages/core/src/local/
COPY packages/providers/src/engines.ts packages/providers/src/
RUN bun scripts/docker-engines.ts /opt/hatchlight/engines

# The server compiled into one program, as the desktop app's sidecar is,
# with the web app and the database migrations beside it. The baseline
# target runs on processors without AVX2, which some NAS boxes have.
FROM ${BUN_IMAGE} AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
	&& bun run --filter '@hatchlight/web' build \
	&& bun build --compile --minify --target=bun-linux-x64-baseline \
		packages/cli/src/index.ts --outfile /opt/hatchlight/bin/hatchlight \
	&& mkdir -p /opt/hatchlight/resources \
	&& cp -r apps/web/dist /opt/hatchlight/resources/web \
	&& cp -r packages/core/drizzle /opt/hatchlight/resources/drizzle

# The CUDA 12.8 runtime: cudart, cuBLAS and NCCL, which the cuda engine
# loads; the driver comes from the host through the NVIDIA Container Toolkit.
FROM ${CUDA_IMAGE}
LABEL org.opencontainers.image.title="Hatchlight" \
	org.opencontainers.image.description="Make pictures with local and cloud AI models, for several people on your own server" \
	org.opencontainers.image.source="https://github.com/hatchlight/hatchlight" \
	org.opencontainers.image.url="https://hatchlight.app" \
	org.opencontainers.image.licenses="MIT"

# tini forwards signals and reaps processes; tar and gzip unpack the trainer's
# tools; setpriv (util-linux, in the base image) drops root. The upgrade takes
# Ubuntu's security fixes the base image was built before; NVIDIA holds the
# CUDA libraries at their versions.
RUN apt-get update \
	&& apt-get upgrade -y --no-install-recommends \
	&& apt-get install -y --no-install-recommends ca-certificates tini tar gzip \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --gid 1000 hatchlight \
	&& useradd --uid 1000 --gid 1000 --create-home --home-dir /home/hatchlight \
		--shell /usr/sbin/nologin hatchlight \
	&& mkdir -p /data /models /trainer \
	&& chown hatchlight:hatchlight /data /models /trainer \
	&& chmod 700 /data /trainer

COPY --from=engines /opt/hatchlight/engines /opt/hatchlight/engines
COPY --from=build /opt/hatchlight/bin /opt/hatchlight/bin
COPY --from=build /opt/hatchlight/resources /opt/hatchlight/resources
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/docker-entrypoint
COPY --chmod=755 docker/hatchlight.sh /usr/local/bin/hatchlight

ENV HATCHLIGHT_MODE=server \
	HATCHLIGHT_HOST=0.0.0.0 \
	HATCHLIGHT_DATA_DIR=/data \
	HATCHLIGHT_MODELS_DIR=/models \
	HATCHLIGHT_TRAINER_DIR=/trainer \
	HATCHLIGHT_ENGINES_DIR=/opt/hatchlight/engines \
	NVIDIA_VISIBLE_DEVICES=all \
	NVIDIA_DRIVER_CAPABILITIES=compute,utility \
	HOME=/home/hatchlight \
	PUID=1000 \
	PGID=1000

VOLUME ["/data", "/models", "/trainer"]
EXPOSE 4096

# The program itself makes the request (BUN_BE_BUN runs it as Bun): no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
	CMD ["env", "BUN_BE_BUN=1", "/opt/hatchlight/bin/hatchlight", "-e", "fetch('http://127.0.0.1:4096/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Hatchlight stops its jobs and closes the database on SIGTERM.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint"]
CMD ["serve"]
