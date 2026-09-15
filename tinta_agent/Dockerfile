# syntax=docker/dockerfile:1.7

# ── Pinned per-architecture Home Assistant base images ───────────────────
# TARGETARCH alone can't parameterize an image NAME — Home Assistant
# publishes separate amd64-base / aarch64-base / armv7-base images, not one
# multi-arch name — so each architecture gets its own explicitly
# --platform-pinned stage, selected below via `base-${TARGETARCH}`. This
# replaces the old single `ARG BUILD_FROM=.../amd64-base:3.19` used
# unconditionally for every platform (see P2.0.2 root-cause below).
#
# Pinned to 3.21 — the newest tag that exists for ALL THREE of these
# per-arch images (confirmed 2026-09-15 directly against the GHCR v2 API:
# amd64-base/aarch64-base/armv7-base all top out at 3.21). Newer releases
# (3.22/3.23/3.24) exist only under home-assistant's new unified
# ghcr.io/home-assistant/base multi-arch image, which dropped armv7
# entirely — HA's own docker-base README now lists amd64/arm64 as the only
# "officially supported" architectures, with armv7-base kept as a frozen
# legacy image. Do not bump past 3.21 without re-checking whether
# armv7-base still gets a matching release, and consider at that point
# whether armv7 support should be dropped from config.yaml's `arch:` list
# to match upstream's direction — that's a product decision, not made here.
#
# Why this needs three explicit stages, not just a version bump (a prior
# attempt — commit 91581ab, reverted by bfdf44e — only changed the tag and
# kept BUILD_FROM hardcoded to amd64-base for every platform): the three
# per-arch images don't even fail the same way when given the wrong
# platform. amd64-base:3.21 and aarch64-base:3.21 are strict OCI indices
# (single real platform entry each) — requesting the wrong platform against
# them HARD-FAILS with "no match for platform in manifest: not found",
# which is exactly what commit 91581ab hit and got misdiagnosed as "3.21 is
# broken". armv7-base:3.21, by contrast, is a bare non-indexed Docker v2
# manifest — requesting the wrong platform against it does NOT fail, it
# just warns ("InvalidBaseImagePlatform") and silently proceeds. That
# inconsistency is exactly why amd64-base:3.19 (also non-indexed) let every
# release through at least 2026.8.3 build and PUSH amd64-content images
# mislabeled linux/arm64 and linux/arm/v7 to ghcr.io/tinta-lab/tinta-agent —
# confirmed via that build's own provenance attestation. The fix is to
# never depend on manifest-strictness catching a mistake: each stage below
# pins its own correct platform explicitly, so the right image is selected
# by construction regardless of how strict any given tag's manifest is.
ARG BASE_TAG=3.21
FROM --platform=linux/amd64  ghcr.io/home-assistant/amd64-base:${BASE_TAG}   AS base-amd64
FROM --platform=linux/arm64  ghcr.io/home-assistant/aarch64-base:${BASE_TAG} AS base-arm64
FROM --platform=linux/arm/v7 ghcr.io/home-assistant/armv7-base:${BASE_TAG}   AS base-arm

# TARGETARCH is provided automatically by BuildKit per platform in
# `--platform linux/amd64,linux/arm64,linux/arm/v7` — amd64/arm64/arm
# respectively — no manual --build-arg wiring needed (and none was ever
# actually supplied by build.yml's docker/build-push-action call, which is
# exactly how the old hardcoded-to-amd64 BUILD_FROM/BUILD_ARCH went
# unnoticed for as long as it did).
ARG TARGETARCH
FROM base-${TARGETARCH} AS base

# Install Node.js 20 + npm
RUN apk add --no-cache nodejs npm wget ca-certificates

# Bundle cloudflared itself — the agent manages its own tunnel process (see
# src/cloudflared-tunnel.ts) using the token Tinta Core hands back on
# enroll/register, so clients never need to install a separate Cloudflared
# add-on or paste a tunnel token by hand.
#
# Pinned to an exact release + per-architecture SHA-256, not
# releases/latest/download/... — this binary gets full control of the
# agent's network tunnel path, so an unpinned "latest" fetch is a real
# supply-chain risk (non-reproducible builds, no integrity check on a
# privileged binary). cloudflare/cloudflared does not publish an official
# checksums file per release, so the hashes below were computed directly
# from the exact release assets on first pinning this version:
#   version:   2026.9.1  (https://github.com/cloudflare/cloudflared/releases/tag/2026.9.1)
#   verified:  2026-09-15, by downloading each linux-<arch> asset from that
#              tagged release and running sha256sum locally (not copied from
#              a third party) — re-derive the same way when bumping.
#
# Uses TARGETARCH directly (amd64/arm64/arm) — this already matches
# cloudflared's own release asset naming (cloudflared-linux-amd64/arm64/arm)
# with no translation table needed, unlike the HA base image names above.
ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.9.1
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) CF_SHA256=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc ;; \
      arm64) CF_SHA256=3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3 ;; \
      arm)   CF_SHA256=093ffa3638ab2b636de63c43a8c68f96a69cf71f9699dd8277a91b160b0f4fc0 ;; \
      *) echo "Unsupported TARGETARCH for cloudflared: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -q -O /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}"; \
    echo "${CF_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c -; \
    chmod +x /usr/local/bin/cloudflared; \
    /usr/local/bin/cloudflared --version

WORKDIR /app

# Install ALL deps (including devDeps for tsc build)
COPY package.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

COPY assets /app/assets
COPY run.sh /
RUN chmod a+x /run.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["/run.sh"]
