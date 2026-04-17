import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import { HAWebSocketClient } from './websocket-ha';
import { TintaCoreSocket } from './websocket-core';
import { haStateToTintaEntity, buildHACommand } from './entities';
import { configureHAForTunnel } from './ha-configurator';
import { ensureSupportUser, setSupportUserActive, getSupportUserId } from './ha-support-user';
import { fetchSupportActivityLog } from './ha-activity-log';

const CLIENT_ID        = process.env.TINTA_CLIENT_ID!;
const CORE_WS          = process.env.TINTA_CORE_WS ?? 'wss://api.tinta-lab.de/tinta/ws';
const AGENT_TOKEN      = process.env.TINTA_AGENT_TOKEN!;
const EXTERNAL_URL     = process.env.TINTA_EXTERNAL_URL ?? '';
const SUPPORT_PASSWORD = process.env.TINTA_SUPPORT_PASSWORD ?? 'TintaLab2026!';
const AGENT_VERSION    = '2026.4.12';

// When HA_HOST=homeassistant the agent is running as a HA Supervisor addon.
// In that case all HA traffic must go through the supervisor proxy (supervisor:80).
const SUPERVISOR_PROXY = process.env.HA_HOST === 'homeassistant';
const HA_HOST = SUPERVISOR_PROXY ? 'supervisor' : (process.env.HA_HOST ?? 'supervisor');
const HA_PORT = SUPERVISOR_PROXY ? 80 : parseInt(process.env.HA_PORT ?? '8123', 10);

if (!CLIENT_ID)   { console.error('TINTA_CLIENT_ID is required');   process.exit(1); }
if (!AGENT_TOKEN) { console.error('TINTA_AGENT_TOKEN is required'); process.exit(1); }

let haClient: HAWebSocketClient;
let coreSocket: TintaCoreSocket;
const startTime = Date.now();

// ── System metrics ────────────────────────────────────────────────────

function getCpuPercent(): number {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return 100 - (100 * idle / total);
}

function getMemPercent(): number {
  const t = os.totalmem(), f = os.freemem();
  return ((t - f) / t) * 100;
}

function getDiskPercent(): number {
  try {
    const statfs = (fs as any).statfsSync;
    if (typeof statfs === 'function') {
      const s = statfs('/');
      return ((s.blocks - s.bfree) / s.blocks) * 100;
    }
    return 0;
  } catch { return 0; }
}

function getUptimeSeconds(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}

// ── HA version via REST API ───────────────────────────────────────────

async function getHAVersion(): Promise<string> {
  return new Promise(resolve => {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) { resolve('unknown'); return; }
    const apiPath = SUPERVISOR_PROXY ? '/core/api/config' : '/api/config';
    const req = http.get(
      { host: HA_HOST, port: HA_PORT, path: apiPath, headers: { Authorization: `Bearer ${token}` } },
      res => {
        let body = '';
        res.on('data', d => (body += d));
        res.on('end', () => {
          try { resolve(JSON.parse(body)?.version ?? 'unknown'); }
          catch { resolve('unknown'); }
        });
      },
    );
    req.on('error', () => resolve('unknown'));
  });
}

// ── HA automation create ──────────────────────────────────────────────

async function applyAutomationToHA(automation: Record<string, any>): Promise<void> {
  if (!haClient.isConnected()) throw new Error('HA not connected');
  await haClient.callService('automation', 'create', {
    alias: automation.alias ?? automation.name ?? 'Tinta Template',
    trigger: automation.trigger,
    action: automation.action,
    mode: automation.mode ?? 'single',
  });
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const haVersion = await getHAVersion();
  log(`Starting v${AGENT_VERSION} | HA ${haVersion} | client ${CLIENT_ID}`);

  // Connect to HA WebSocket
  haClient = new HAWebSocketClient({
    host: HA_HOST,
    port: HA_PORT,
    token: process.env.SUPERVISOR_TOKEN ?? '',
    ssl: !SUPERVISOR_PROXY && process.env.HA_SSL === 'true',
    supervisorProxy: SUPERVISOR_PROXY,
  });

  try {
    await haClient.connect();
    log('Connected to Home Assistant');
  } catch (err: any) {
    log('Failed to connect to HA:', err.message, '— continuing anyway');
  }

  // Ensure tinta-support HA user exists
  if (haClient.isConnected()) {
    await ensureSupportUser(haClient, SUPPORT_PASSWORD);
  }

  // Auto-configure HA for Cloudflare tunnel on every startup
  await configureHAForTunnel({
    haHost: HA_HOST,
    haPort: HA_PORT,
    token: process.env.SUPERVISOR_TOKEN ?? '',
    ssl: !SUPERVISOR_PROXY && process.env.HA_SSL === 'true',
    externalUrl: EXTERNAL_URL,
    supervisorProxy: SUPERVISOR_PROXY,
  });

  // Subscribe to HA state changes
  if (haClient.isConnected()) {
    await haClient.subscribeEvents('state_changed');
    haClient.onEvent(event => {
      const newState = event.data?.new_state;
      if (newState) {
        const entity = haStateToTintaEntity(newState);
        if (entity) coreSocket?.sendStateUpdate([entity]);
      }
    });
  }

  // Connect to Tinta Core
  coreSocket = new TintaCoreSocket(CORE_WS, CLIENT_ID, AGENT_TOKEN, AGENT_VERSION, haVersion);

  // Remote command handler
  coreSocket.onCommand(async cmd => {
    if (!haClient.isConnected()) throw new Error('HA not connected');
    const { domain, service, serviceData } = buildHACommand(cmd.haEntityId, cmd.action, cmd.data ?? {});
    await haClient.callService(domain, service, serviceData);
    log(`Executed: ${domain}.${service} on ${cmd.haEntityId}`);
  });

  // Template apply handler
  coreSocket.onApplyTemplate(async template => {
    await applyAutomationToHA(template.automation);
    log(`Applied template: ${template.slug}`);
  });

  // Support access toggle handler
  coreSocket.onSupportAccess(async (enabled, password, grantedAt, accessLogId) => {
    if (!haClient.isConnected()) return;
    if (!enabled && grantedAt && accessLogId) {
      // Fetch activity log BEFORE deleting the user (need user ID for filtering)
      const supportUserId = await getSupportUserId(haClient);
      if (supportUserId) {
        const entries = await fetchSupportActivityLog({
          host: HA_HOST,
          port: HA_PORT,
          token: process.env.SUPERVISOR_TOKEN ?? '',
          supervisorProxy: SUPERVISOR_PROXY,
          supportUserId,
          from: grantedAt,
        });
        coreSocket.sendActivityLog(accessLogId, entries);
        log(`Activity log: ${entries.length} entries sent`);
      }
    }
    await setSupportUserActive(haClient, enabled, password);
  });

  // Remote diagnostics provider
  coreSocket.onDiagnostics(() => ({
    clientId: CLIENT_ID,
    agentVersion: AGENT_VERSION,
    haVersion,
    haConnected: haClient.isConnected(),
    uptimeSeconds: getUptimeSeconds(),
    nodeVersion: process.version,
    platform: `${os.platform()}/${os.arch()}`,
    cpuPercent: getCpuPercent(),
    memPercent: getMemPercent(),
    diskPercent: getDiskPercent(),
    timestamp: new Date().toISOString(),
  }));

  coreSocket.connect();

  // Health server for Docker HEALTHCHECK / Proxmox monitoring
  http.createServer((req, res) => {
    const status = {
      status: 'ok',
      clientId: CLIENT_ID,
      agentVersion: AGENT_VERSION,
      haConnected: haClient.isConnected(),
      coreConnected: coreSocket.isConnected(),
      uptimeSeconds: getUptimeSeconds(),
    };
    res.writeHead(haClient.isConnected() ? 200 : 503);
    res.end(JSON.stringify(status));
  }).listen(3100, () => log('Health server on :3100'));

  // Periodic state sync + metrics every 5 minutes
  setInterval(async () => {
    if (!haClient.isConnected()) return;
    try {
      const states = await haClient.getStates();
      const entities = states.map(haStateToTintaEntity).filter(Boolean);
      coreSocket.sendStateUpdate(entities as any[]);

      const deviceCount     = states.filter(s => !s.entity_id.startsWith('automation.')).length;
      const automationCount = states.filter(s => s.entity_id.startsWith('automation.')).length;

      coreSocket.sendMetrics({
        clientId: CLIENT_ID,
        cpuPercent: getCpuPercent(),
        memPercent: getMemPercent(),
        diskPercent: getDiskPercent(),
        deviceCount,
        automationCount,
        uptimeSeconds: getUptimeSeconds(),
      });

      log(`State sync: ${entities.length} entities, ${deviceCount} devices, ${automationCount} automations`);
    } catch (err: any) {
      log('State sync error:', err.message);
    }
  }, 5 * 60 * 1000);

  // Self-heal: restart HA connection if it drops for >2 min
  setInterval(async () => {
    if (!haClient.isConnected()) {
      log('HA disconnected — attempting reconnect');
      try {
        await haClient.connect();
        await haClient.subscribeEvents('state_changed');
        log('HA reconnected');
      } catch { /* will retry next tick */ }
    }
  }, 2 * 60 * 1000);
}

function log(...args: any[]) {
  console.log(`[Tinta Agent] ${args.join(' ')}`);
}

main().catch(err => {
  console.error('[Tinta Agent] Fatal:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  log('Shutting down...');
  haClient?.disconnect();
  coreSocket?.disconnect();
  process.exit(0);
});
