# Tinta Agent

> The device runtime layer for [Tinta Lab](https://tinta-lab.de) — managed Home Assistant for MSPs.

[![Build](https://github.com/tinta-lab/tinta-agent/actions/workflows/build.yml/badge.svg)](https://github.com/tinta-lab/tinta-agent/actions/workflows/build.yml)

---

## What it does

Tinta Agent runs alongside Home Assistant and connects it to the Tinta Lab control plane:

```
Client Device (Home Assistant)
         ↓
   Tinta Agent
         ↓  wss://api.tinta-lab.de
   Tinta Core (Control Plane)
         ↓
   MSP Dashboard
```

- **Heartbeat** — reports online/offline status every 30 seconds
- **State sync** — pushes entity state changes in real time
- **Metrics** — CPU, RAM, disk, device count, automation count every 5 min
- **Remote commands** — execute HA service calls from the MSP dashboard
- **Golden templates** — receive and apply automation blueprints
- **Remote diagnostics** — on-demand system report without SSH
- **Self-heal** — automatically reconnects to HA if connection drops

---

## Release channels

| Tag | Purpose |
|-----|---------|
| `stable` | Production — recommended for all clients |
| `beta` | Pre-release testing |
| `dev` | Latest main branch build (unstable) |
| `2026.4.1` | Pinned version — for zero-surprise deployments |
| `2026.4` | Minor alias — auto-updated within the same minor |

**Always pin to `stable` or a specific version in production.**
Never use `latest` — it will be removed in future releases.

---

## Supported architectures

| Architecture | Device |
|---|---|
| `linux/amd64` | x86 mini PCs, VMs, Proxmox |
| `linux/arm64` | Raspberry Pi 4/5, Odroid, HAOS |
| `linux/arm/v7` | Raspberry Pi 2/3, older ARM devices |

---

## Installation (Docker)

```bash
docker run -d \
  --name tinta-agent \
  --restart unless-stopped \
  -e TINTA_CLIENT_ID='<your-client-id>' \
  -e TINTA_AGENT_TOKEN='<your-agent-token>' \
  -e TINTA_CORE_WS='wss://api.tinta-lab.de/tinta/ws' \
  -e HA_HOST='<ha-ip-or-hostname>' \
  -e HA_PORT='8123' \
  -e SUPERVISOR_TOKEN='<ha-long-lived-token>' \
  ghcr.io/tinta-lab/tinta-agent:stable
```

`TINTA_CLIENT_ID` and `TINTA_AGENT_TOKEN` are generated in the Tinta Lab admin dashboard under **Admin → Agents → New Client**.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TINTA_CLIENT_ID` | ✅ | — | Client UUID from Tinta Lab |
| `TINTA_AGENT_TOKEN` | ✅ | — | JWT issued by Tinta Core |
| `TINTA_CORE_WS` | — | `wss://api.tinta-lab.de/tinta/ws` | Control plane WebSocket URL |
| `HA_HOST` | — | `supervisor` | Home Assistant hostname or IP |
| `HA_PORT` | — | `8123` | Home Assistant port |
| `HA_SSL` | — | `false` | Use WSS for HA connection |
| `SUPERVISOR_TOKEN` | — | — | HA long-lived access token |

---

## Health check

The agent exposes a health endpoint on port `3100`:

```bash
curl http://localhost:3100/
# {"status":"ok","haConnected":true,"coreConnected":true,"uptimeSeconds":3600}
```

HTTP `200` = HA connected. HTTP `503` = HA disconnected (agent still running).

---

## Security

- Agent token is a signed JWT (365-day expiry) issued per client
- All communication uses WSS (TLS 1.3) via Cloudflare tunnel
- No inbound ports required on the client network
- Container images are scanned with [Trivy](https://trivy.dev) on every build
- Vulnerability reports published to GitHub Security tab

---

## Privacy

Tinta Agent transmits:
- HA entity state changes (entity IDs + state values)
- System metrics (CPU / RAM / disk percentages)
- HA and agent version strings

Tinta Agent does **not** transmit:
- HA user credentials or passwords
- Camera feeds or media content
- Personal data from HA users

---

## Changelog

### 2026.4.1
- Remote diagnostics (`diagnostics_request` event)
- Self-heal: automatic HA reconnection every 2 minutes
- HA version detection via REST API (works outside HAOS)
- Health endpoint returns `503` when HA is disconnected
- Multi-arch: added `linux/arm/v7`
- Release channels: `stable` / `beta` / `dev` (removed `latest`)
