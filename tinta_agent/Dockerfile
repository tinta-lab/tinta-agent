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

# Security fixes on top of the frozen 3.21 bases (see BASE_TAG above), found
# by Trivy 2026-10-28 — armv7-base is the most outdated (alpine 3.21.5:
# CRITICAL in bind and in 32-bit OpenSSL). Only the affected packages are
# upgraded, and only where the base actually has them — not a blanket
# `apk upgrade` — so the rest stays exactly as HA ships it. curl/libcurl are
# used by bashio for the Supervisor API.
RUN set -eu; pkgs=""; \
    for p in curl libcurl libssl3 libcrypto3 brotli-libs bind-libs bind-tools musl musl-utils; do \
      if apk info -e "$p" >/dev/null; then pkgs="$pkgs $p"; fi; \
    done; \
    apk add --no-cache --upgrade $pkgs

# tempio (HA's templating CLI) ships in the base image built with Go 1.23.3
# — 1 CRITICAL + 38 HIGH stdlib/x/crypto findings. Nothing here uses it:
# not run.sh, not bashio, not the s6 init scripts (checked 2026-10-28 by
# grepping the 3.21 base for references). Re-check before relying on it.
RUN rm -f /usr/bin/tempio

# Bundle cloudflared itself — the agent manages its own tunnel process (see
# src/cloudflared-tunnel.ts) using the token Tinta Core hands back on
# enroll/register, so clients never need to install a separate Cloudflared
# add-on or paste a tunnel token by hand.
#
# Pinned to an exact release + per-architecture SHA-256, not
# releases/latest/download/... — this binary gets full control of the
# agent's network tunnel path, so an unpinned "latest" fetch is a real
# supply-chain risk (non-reproducible builds, no integrity check on a
# privileged binary). There is no separate checksums file, but the release
# notes list a SHA-256 per asset, and GitHub reports its own `digest` for
# each uploaded asset. The hashes below match all three independent sources:
#   version:   2026.10.5  (https://github.com/cloudflare/cloudflared/releases/tag/2026.10.5)
#   verified:  2026-10-28 — release-notes checksum == GitHub asset digest
#              (gh api repos/cloudflare/cloudflared/releases/tags/<v>) ==
#              sha256sum of the downloaded asset. Re-check all three when
#              bumping. (2026.9.1 had Trivy HIGHs in its Go dependencies.)
#
# Uses TARGETARCH directly (amd64/arm64/arm) — this already matches
# cloudflared's own release asset naming (cloudflared-linux-amd64/arm64/arm)
# with no translation table needed, unlike the HA base image names above.
ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.10.5
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) CF_SHA256=e1bc0cf084fd9e590554fe769a86b1db46701c3f847a43d902f7b974a4e16298 ;; \
      arm64) CF_SHA256=72e0d05a67e09da87cf495e409a28c3cc5994dd23fc66a982eebea6a55923b7d ;; \
      arm)   CF_SHA256=a018911e1bbfd739937f3011f589e9e73245baeee14742f8b3413472bb007adc ;; \
      *) echo "Unsupported TARGETARCH for cloudflared: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -q -O /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}"; \
    echo "${CF_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c -; \
    chmod +x /usr/local/bin/cloudflared; \
    /usr/local/bin/cloudflared --version

WORKDIR /app

# Install ALL deps (including devDeps for tsc build) exactly as locked —
# `npm install` without the lockfile resolved fresh versions on every build.
#
# The arm64/armv7 stages run under QEMU in CI, where Node's libuv io_uring
# backend can hang forever (2026-10-28: arm64 `npm ci` sat for 30+ minutes
# while amd64/armv7 finished in a minute). io_uring off (this ENV also
# stays set at runtime — harmless, libuv falls back to epoll), and each
# attempt bounded so a hang becomes a retry instead of a stuck job.
COPY package.json package-lock.json ./
ENV UV_USE_IO_URING=0
RUN for i in 1 2 3; do \
      timeout 300 npm ci --no-audit --no-fund && exit 0; \
      echo "npm ci attempt $i failed or timed out" >&2; \
    done; exit 1

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Remove devDependencies after build
RUN npm prune --omit=dev

COPY assets /app/assets
COPY run.sh /
RUN chmod a+x /run.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["/run.sh"]
