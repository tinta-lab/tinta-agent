# Tinta Agent

> The device runtime layer for [Tinta Lab](https://tinta-lab.de) — managed Home Assistant for MSPs.

[![Build & Push](https://github.com/tinta-lab/tinta-agent/actions/workflows/build.yml/badge.svg)](https://github.com/tinta-lab/tinta-agent/actions/workflows/build.yml)
[![CI](https://github.com/tinta-lab/tinta-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/tinta-lab/tinta-agent/actions/workflows/ci.yml)

---

## What it does

Tinta Agent runs as a Home Assistant add-on and connects it to the Tinta Lab control plane:

```
Client Device (Home Assistant OS)
         ↓  HA Supervisor
   Tinta Agent Add-on
         ↓  wss://api.tinta-lab.de
   Tinta Core (Control Plane)
         ↓
   MSP Dashboard (app.tinta-lab.de)
```

- **Heartbeat** — reports online/offline status every 30 seconds
- **Metrics** — CPU, RAM, disk, device count, automation count every 5 min
- **State sync** — pushes controllable entity state changes in real time
- **Remote commands** — execute HA service calls from the MSP dashboard
- **Golden templates** — receive and apply automation blueprints
- **Support access** — time-limited remote access for MSP technicians (auto-expires)
- **Remote diagnostics** — on-demand system report without SSH
- **Self-heal** — automatically reconnects to HA if connection drops

---

## Installation (HA Add-on — recommended)

1. In Home Assistant go to **Settings → Add-ons → Add-on Store**
2. Click the menu (⋮) → **Repositories** → add `https://github.com/tinta-lab/tinta-agent`
3. Install **Tinta Agent** from the store
4. Configure the add-on with credentials from your Tinta Lab admin panel:

```yaml
tinta_client_id: "<client-uuid>"
tinta_agent_token: "<jwt-from-tinta-lab>"
tinta_core_ws: "wss://api.tinta-lab.de/tinta/ws"
tinta_external_url: ""   # optional — HA external URL for Cloudflare tunnel
```

5. Start the add-on

Credentials are generated in **Admin → Agents → New Client** in the Tinta Lab dashboard.

---

## Installation (Docker — standalone HA)

```bash
docker run -d \
  --name tinta-agent \
  --restart unless-stopped \
  -e TINTA_CLIENT_ID='<client-uuid>' \
  -e TINTA_AGENT_TOKEN='<jwt-from-tinta-lab>' \
  -e TINTA_CORE_WS='wss://api.tinta-lab.de/tinta/ws' \
  -e HA_HOST='<ha-ip-or-hostname>' \
  -e HA_PORT='8123' \
  -e SUPERVISOR_TOKEN='<ha-long-lived-token>' \
  ghcr.io/tinta-lab/tinta-agent:stable
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TINTA_CLIENT_ID` | ✅ | — | Client UUID from Tinta Lab |
| `TINTA_AGENT_TOKEN` | ✅ | — | JWT issued by Tinta Core |
| `TINTA_CORE_WS` | — | `wss://api.tinta-lab.de/tinta/ws` | Control plane WebSocket URL |
| `TINTA_EXTERNAL_URL` | — | — | HA external URL (used by Cloudflare tunnel setup) |
| `HA_HOST` | — | `homeassistant` | Home Assistant hostname (add-on default) or IP |
| `HA_PORT` | — | `8123` | Home Assistant port |
| `HA_SSL` | — | `false` | Use WSS for HA connection |
| `SUPERVISOR_TOKEN` | — | — | HA long-lived access token (Docker only; add-on uses Supervisor API) |

---

## Supported architectures

| Architecture | Device |
|---|---|
| `linux/amd64` | x86 mini PCs, VMs, Proxmox |
| `linux/arm64` | Raspberry Pi 4/5, Odroid, HAOS |
| `linux/arm/v7` | Raspberry Pi 2/3, older ARM devices |

---

## Release channels

| Tag | Purpose |
|-----|---------|
| `stable` | Production — recommended for all clients |
| `beta` | Pre-release testing |
| `dev` | Latest main branch build |
| `2026.8.1` | Pinned version — zero-surprise deployments |

Pin to `stable` or a specific version in production. Never use `latest`.

---

## Health check

The agent exposes a health endpoint on port `3100`:

```bash
curl http://localhost:3100/
# {"status":"ok","haConnected":true,"coreConnected":true,"uptimeSeconds":3600}
```

`200` = HA connected. `503` = HA disconnected (agent still running).

---

## Security

- Agent token is a per-client signed JWT issued by Tinta Core
- All communication uses WSS (TLS 1.3) over Cloudflare tunnels — no open inbound ports
- `tinta-support` HA user is created with `system-users` role (not admin) — technicians can control devices but cannot access HA admin panel or Supervisor
- Support access auto-expires client-side via local TTL timer, even if backend goes offline
- Container images scanned with [Trivy](https://trivy.dev) on every build — results in the Security tab

---

## Privacy

Tinta Agent transmits:
- HA entity state changes (controllable entities only: light, switch, climate, cover, security)
- System metrics (CPU / RAM / disk percentages, device and automation counts)
- HA and agent version strings

Tinta Agent does **not** transmit:
- HA user credentials or passwords
- Raw sensor or binary sensor data
- Camera feeds or media content
- Personal data from HA users

---

## Changelog

See [CHANGELOG.md](tinta_agent/CHANGELOG.md) for the full history.

### 2026.8.1 — Security hardening
- `tinta-support` HA user now created with `system-users` role (was `system-admin`)
- `buildHACommand` throws on unknown entity types — prevents arbitrary HA service calls
- Local TTL timer auto-revokes support access if backend goes offline
- Unit tests for privilege scope, entity allowlist, and TTL timer
- CI pipeline: type check + tests on every push

### 2026.4.15
- Support session banner shows technician name and expiry time in HA

### 2026.4.14
- Fix: agent no longer forwards raw sensor / binary_sensor state to Tinta Core

### 2026.4.13
- Fix: toggle state synced after Core socket connected, not before

### 2026.4.12
- Activity log sent to backend on support access revoke
- HA Access Toggle: client can control support access from HA UI
- Multi-client ecosystem via `clients/*.env`
