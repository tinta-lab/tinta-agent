import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import { HAWebSocketClient } from './websocket-ha';
import { TintaCoreSocket } from './websocket-core';
import { haStateToTintaEntity, buildHACommand } from './entities';
import { configureHAForTunnel } from './ha-configurator';
import { ensureSupportUser, setSupportUserActive, getSupportUserId } from './ha-support-user';
import { fetchSupportActivityLog } from './ha-activity-log';
import { ensureAccessToggleEntity, setAccessToggle, ACCESS_TOGGLE_ENTITY } from './ha-access-toggle';
import { showAccessOpenBanner, showConnectedBanner, dismissBanner } from './ha-banner';

const AGENT_VERSION    = '2026.8.3';
const CORE_WS          = process.env.TINTA_CORE_WS ?? 'wss://api.tinta-lab.de/tinta/ws';
const CREDENTIALS_PATH = '/data/tinta_credentials.json';

// When HA_HOST=homeassistant the agent is running as a HA Supervisor addon.
// In that case all HA traffic must go through the supervisor proxy (supervisor:80).
const SUPERVISOR_PROXY = process.env.HA_HOST === 'homeassistant';
const HA_HOST = SUPERVISOR_PROXY ? 'supervisor' : (process.env.HA_HOST ?? 'supervisor');
const HA_PORT = SUPERVISOR_PROXY ? 80 : parseInt(process.env.HA_PORT ?? '8123', 10);

// ── Enrollment ────────────────────────────────────────────────────────

interface Credentials {
  clientId: string;
  agentToken: string;
  externalUrl: string;
}

async function loadOrEnroll(): Promise<Credentials> {
  // 1. Persisted credentials from previous enrollment
  if (fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')) as Credentials;
      if (saved.clientId && saved.agentToken) {
        console.log('[Tinta Agent] Loaded credentials from storage');
        return saved;
      }
    } catch { /* corrupt file — fall through */ }
  }

  // 2. One-time install token enrollment
  const installToken = process.env.TINTA_INSTALL_TOKEN;
  if (installToken) {
    const coreBase = CORE_WS.replace('wss://', 'https://').replace('ws://', 'http://').replace('/tinta/ws', '');
    console.log(`[Tinta Agent] Enrolling via install token...`);
    const res = await fetch(`${coreBase}/install/${installToken}`);
    if (!res.ok) { console.error(`Enrollment failed: ${res.status} ${await res.text()}`); process.exit(1); }
    const cfg = await res.json() as any;
    const creds: Credentials = { clientId: cfg.clientId, agentToken: cfg.agentToken, externalUrl: cfg.externalUrl ?? '' };
    try { fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2)); }
    catch (e: any) { console.warn('[Tinta Agent] Could not persist credentials:', e.message); }
    console.log(`[Tinta Agent] Enrolled as client ${creds.clientId}`);
    return creds;
  }

  // 3. Legacy env vars
  const clientId = process.env.TINTA_CLIENT_ID;
  const agentToken = process.env.TINTA_AGENT_TOKEN;
  if (!clientId || !agentToken) {
    console.error('[Tinta Agent] No credentials: set tinta_install_token, or tinta_client_id + tinta_agent_token');
    process.exit(1);
  }
  return { clientId, agentToken, externalUrl: process.env.TINTA_EXTERNAL_URL ?? '' };
}

// ── Self-update via HA Supervisor ─────────────────────────────────────

async function triggerSelfUpdate(targetVersion: string): Promise<void> {
  const supervisorToken = process.env.SUPERVISOR_TOKEN;
  if (!supervisorToken) { console.log('[Tinta Agent] No SUPERVISOR_TOKEN — skipping self-update'); return; }
  const body = targetVersion ? JSON.stringify({ version: targetVersion }) : '{}';
  return new Promise(resolve => {
    const req = http.request(
      { host: 'supervisor', port: 80, path: '/addons/self/update', method: 'POST',
        headers: { Authorization: `Bearer ${supervisorToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { console.log(`[Tinta Agent] Supervisor update: HTTP ${res.statusCode}`); resolve(); },
    );
    req.on('error', e => { console.warn('[Tinta Agent] Supervisor update error:', e.message); resolve(); });
    req.end(body);
  });
}

let haClient: HAWebSocketClient;
let coreSocket: TintaCoreSocket;
const startTime = Date.now();

// Tracks the last toggle state we set programmatically to suppress echo events
let toggleKnownState: 'on' | 'off' | null = null;

// Local TTL guard: auto-revokes support access if backend goes offline before expiry
let supportExpiryTimer: NodeJS.Timeout | null = null;

function clearSupportExpiryTimer() {
  if (supportExpiryTimer) { clearTimeout(supportExpiryTimer); supportExpiryTimer = null; }
}

function scheduleSupportExpiry(expiresAt: string) {
  clearSupportExpiryTimer();
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return;
  supportExpiryTimer = setTimeout(async () => {
    log('Support access TTL expired locally — revoking');
    if (!haClient.isConnected()) return;
    await setSupportUserActive(haClient, false);
    await dismissBanner(haClient);
    if (toggleKnownState !== 'off') { toggleKnownState = 'off'; await setAccessToggle(haClient, false); }
  }, ms);
}

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
  const creds = await loadOrEnroll();
  const CLIENT_ID   = creds.clientId;
  const AGENT_TOKEN = creds.agentToken;
  const EXTERNAL_URL = creds.externalUrl || process.env.TINTA_EXTERNAL_URL || '';

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

  // Ensure tinta-support HA user exists and access toggle helper entity
  if (haClient.isConnected()) {
    await ensureSupportUser(haClient);
    await ensureAccessToggleEntity(haClient);
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
      if (!newState) return;

      // Detect client toggling Tinta Support Access in HA
      if (newState.entity_id === ACCESS_TOGGLE_ENTITY) {
        const incoming = newState.state as 'on' | 'off';
        if (incoming !== toggleKnownState) {
          toggleKnownState = incoming;
          coreSocket?.sendAccessToggle(incoming === 'on');
          log(`Access toggle → ${incoming} (sent to Core)`);
        }
        return;
      }

      const entity = haStateToTintaEntity(newState);
      if (entity) coreSocket?.sendStateUpdate([entity]);
    });
  }

  // Connect to Tinta Core
  coreSocket = new TintaCoreSocket(CORE_WS, CLIENT_ID, AGENT_TOKEN, AGENT_VERSION, haVersion);

  // Sync toggle state after Core connection is established
  coreSocket.onConnected(async () => {
    if (!haClient.isConnected()) return;
    try {
      const states = await haClient.getStates();
      const toggle = states.find((s: any) => s.entity_id === ACCESS_TOGGLE_ENTITY);
      if (toggle) {
        const state = toggle.state as 'on' | 'off';
        toggleKnownState = state;
        if (state === 'on') {
          coreSocket.sendAccessToggle(true);
          log(`Toggle sync: ON → sent to Core`);
        } else {
          log(`Toggle sync: OFF`);
        }
      }
    } catch (e: any) {
      log(`Toggle sync failed: ${e.message}`);
    }
  });

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
  coreSocket.onSupportAccess(async (enabled, password, grantedAt, accessLogId, expiresAt) => {
    log(`Support access event received: enabled=${enabled}, haConnected=${haClient.isConnected()}`);
    if (!haClient.isConnected()) { log('HA not connected — skipping support access'); return; }
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

    if (enabled) {
      if (expiresAt) scheduleSupportExpiry(expiresAt);
      await showAccessOpenBanner(haClient, expiresAt);
    } else {
      clearSupportExpiryTimer();
      await dismissBanner(haClient);
    }

    // Sync the HA input_boolean toggle to reflect current access state
    const newToggleState = enabled ? 'on' : 'off';
    if (toggleKnownState !== newToggleState) {
      toggleKnownState = newToggleState;
      await setAccessToggle(haClient, enabled);
    }
  });

  // A specific support employee connected — name them in the banner
  coreSocket.onSupportConnected(async (accessedByName, expiresAt) => {
    if (!haClient.isConnected()) return;
    await showConnectedBanner(haClient, accessedByName, expiresAt);
  });

  // Self-update handler — Core instructs agent to trigger HA Supervisor update
  coreSocket.onSelfUpdate(async (targetVersion: string) => {
    log(`Self-update → v${targetVersion || 'latest'}`);
    await triggerSelfUpdate(targetVersion);
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
        await ensureAccessToggleEntity(haClient);
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
