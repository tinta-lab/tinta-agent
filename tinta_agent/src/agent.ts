import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import { HAWebSocketClient } from './websocket-ha';
import { TintaCoreSocket } from './websocket-core';
import { haStateToTintaEntity, buildHACommand } from './entities';

const CLIENT_ID = process.env.TINTA_CLIENT_ID!;
const CORE_WS = process.env.TINTA_CORE_WS ?? 'wss://api.tinta-lab.de/tinta/ws';
const AGENT_TOKEN = process.env.TINTA_AGENT_TOKEN!;
const AGENT_VERSION = '2026.4.1';

if (!CLIENT_ID) {
  console.error('TINTA_CLIENT_ID is required');
  process.exit(1);
}
if (!AGENT_TOKEN) {
  console.error('TINTA_AGENT_TOKEN is required');
  process.exit(1);
}

let haClient: HAWebSocketClient;
let coreSocket: TintaCoreSocket;

function getCpuPercent(): number {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type of Object.values(cpu.times)) totalTick += type;
    totalIdle += cpu.times.idle;
  }
  return 100 - (100 * totalIdle / totalTick);
}

function getMemPercent(): number {
  const total = os.totalmem();
  const free = os.freemem();
  return ((total - free) / total) * 100;
}

function getDiskPercent(): number {
  try {
    // fs.statfsSync available Node 19+; fallback gracefully
    const statfs = (fs as any).statfsSync;
    if (typeof statfs === 'function') {
      const stat = statfs('/');
      return ((stat.blocks - stat.bfree) / stat.blocks) * 100;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function getHAVersion(): Promise<string> {
  return new Promise(resolve => {
    const supervisorToken = process.env.SUPERVISOR_TOKEN;
    if (!supervisorToken) { resolve('unknown'); return; }
    const req = http.get(
      { host: 'supervisor', port: 80, path: '/core/info', headers: { Authorization: `Bearer ${supervisorToken}` } },
      res => {
        let body = '';
        res.on('data', d => (body += d));
        res.on('end', () => {
          try { resolve(JSON.parse(body)?.data?.version ?? 'unknown'); }
          catch { resolve('unknown'); }
        });
      },
    );
    req.on('error', () => resolve('unknown'));
  });
}

async function applyAutomationToHA(automation: Record<string, any>): Promise<void> {
  if (!haClient.isConnected()) throw new Error('HA not connected');
  // Create automation via HA config flow
  await haClient.callService('automation', 'create', {
    alias: automation.alias ?? automation.name ?? 'Tinta Template',
    trigger: automation.trigger,
    action: automation.action,
    mode: automation.mode ?? 'single',
  });
}

async function main() {
  console.log(`[Tinta Agent] Starting v${AGENT_VERSION} for client ${CLIENT_ID}`);

  const haVersion = await getHAVersion();
  console.log(`[Tinta Agent] HA version: ${haVersion}`);

  // Connect to HA WebSocket
  const haToken = process.env.SUPERVISOR_TOKEN ?? '';
  haClient = new HAWebSocketClient({
    host: process.env.HA_HOST ?? 'supervisor',
    port: 8123,
    token: haToken,
    ssl: false,
  });

  try {
    await haClient.connect();
    console.log('[Tinta Agent] Connected to Home Assistant');
  } catch (err: any) {
    console.error('[Tinta Agent] Failed to connect to HA:', err.message);
    // Continue anyway — agent still provides Core connection
  }

  // Subscribe to HA state changes
  if (haClient.isConnected()) {
    await haClient.subscribeEvents('state_changed');
    haClient.onEvent(event => {
      const newState = event.data?.new_state;
      if (newState) {
        const entity = haStateToTintaEntity(newState);
        if (entity) {
          coreSocket?.sendStateUpdate([entity]);
        }
      }
    });
  }

  // Connect to Tinta Core
  coreSocket = new TintaCoreSocket(CORE_WS, CLIENT_ID, AGENT_TOKEN, AGENT_VERSION, haVersion);

  coreSocket.onCommand(async cmd => {
    if (!haClient.isConnected()) throw new Error('HA not connected');
    const { domain, service, serviceData } = buildHACommand(cmd.haEntityId, cmd.action, cmd.data ?? {});
    await haClient.callService(domain, service, serviceData);
    console.log(`[Tinta Agent] Executed: ${domain}.${service} on ${cmd.haEntityId}`);
  });

  coreSocket.onApplyTemplate(async template => {
    await applyAutomationToHA(template.automation);
    console.log(`[Tinta Agent] Applied template: ${template.slug}`);
  });

  coreSocket.connect();

  // Minimal health server for Docker healthcheck
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      clientId: CLIENT_ID,
      haConnected: haClient.isConnected(),
      version: AGENT_VERSION,
    }));
  }).listen(3100, () => {
    console.log('[Tinta Agent] Health server on :3100');
  });

  const startTime = Date.now();

  // Periodic state sync + metrics every 5 minutes
  setInterval(async () => {
    if (haClient.isConnected()) {
      try {
        const states = await haClient.getStates();
        const entities = states.map(haStateToTintaEntity).filter(Boolean);
        coreSocket.sendStateUpdate(entities as any[]);

        // Count devices and automations
        const deviceCount = states.filter(s => !s.entity_id.startsWith('automation.')).length;
        const automationCount = states.filter(s => s.entity_id.startsWith('automation.')).length;

        coreSocket.sendMetrics({
          clientId: CLIENT_ID,
          cpuPercent: getCpuPercent(),
          memPercent: getMemPercent(),
          diskPercent: getDiskPercent(),
          deviceCount,
          automationCount,
          uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        });
      } catch (err: any) {
        console.error('[Tinta Agent] State sync error:', err.message);
      }
    }
  }, 5 * 60 * 1000);
}

main().catch(err => {
  console.error('[Tinta Agent] Fatal error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[Tinta Agent] Shutting down...');
  haClient?.disconnect();
  coreSocket?.disconnect();
  process.exit(0);
});
