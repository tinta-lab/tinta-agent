import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { HAWebSocketClient } from './websocket-ha';

// RFC1918 ranges cover cloudflared running anywhere on the local network.
// Cloudflare CDN IPs are included for reverse-proxy setups (non-tunnel).
const TRUSTED_PROXIES = [
  '127.0.0.1',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

export interface HAConfiguratorOptions {
  haHost: string;
  haPort: number;
  token: string;
  ssl: boolean;
  externalUrl: string;
  supervisorProxy?: boolean;
}

// HAWebSocketClient.sendCommand() has no timeout of its own, and a
// disconnect mid-flight never rejects an in-flight command (websocket-ha.ts
// only flips `connected = false` and schedules a reconnect — it doesn't
// walk pendingMap). Without this, a WS drop between any two of the three
// sendCommand() calls below would hang this function — and therefore
// configureHAForTunnel(), which agent.ts's main() awaits before subscribing
// to HA events — forever. external_url is a best-effort improvement, not
// an enrollment precondition, so it must fail fast, not hang the Agent.
const HA_WS_COMMAND_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// config/core/update (external_url/internal_url) has never existed as a
// REST route — HA only ever exposed it as a WebSocket command, the one its
// own frontend "General" settings page uses. The previous implementation
// called POST /api/config/core/update over plain HTTP and always got a 404,
// on every HA version, not just a specific one. Both read (get_config) and
// write (config/core/update) go through the Agent's own already-connected
// HA WebSocket client instead — no second connection is opened here, and a
// failed/absent HA WS simply skips this step (see configureHAForTunnel).
async function setExternalUrl(haClient: HAWebSocketClient, opts: HAConfiguratorOptions): Promise<void> {
  const config = await withTimeout(
    haClient.sendCommand<{ external_url?: string }>({ type: 'get_config' }),
    HA_WS_COMMAND_TIMEOUT_MS,
    'get_config',
  );
  const currentExternal = config?.external_url ?? '';

  if (currentExternal === opts.externalUrl) {
    console.log(`[HA Configurator] external_url already set to ${opts.externalUrl} ✓`);
    return;
  }

  // In supervisor proxy mode haHost is 'supervisor' — use HA_INTERNAL_URL env or skip internal_url.
  const internalUrl = process.env.HA_INTERNAL_URL ?? (opts.supervisorProxy ? undefined : `http${opts.ssl ? 's' : ''}://${opts.haHost}:${opts.haPort}`);
  await withTimeout(
    haClient.sendCommand({
      type: 'config/core/update',
      external_url: opts.externalUrl,
      ...(internalUrl ? { internal_url: internalUrl } : {}),
    }),
    HA_WS_COMMAND_TIMEOUT_MS,
    'config/core/update',
  );

  // Trust but verify: config/core/update resolving doesn't by itself prove
  // HA actually applied it, so re-read the same way applications page would.
  const confirmed = await withTimeout(
    haClient.sendCommand<{ external_url?: string }>({ type: 'get_config' }),
    HA_WS_COMMAND_TIMEOUT_MS,
    'get_config (verify)',
  );
  if (confirmed?.external_url !== opts.externalUrl) {
    throw new Error(
      `HA accepted config/core/update but external_url reads back as ` +
        `${JSON.stringify(confirmed?.external_url)}, not ${JSON.stringify(opts.externalUrl)}`,
    );
  }
  console.log(`[HA Configurator] external_url configured ✓`);
}

// Returns true if configuration needs a restart (was changed).
function ensureHttpTrustedProxies(configDir: string): boolean {
  const log = (m: string) => console.log(`[HA Configurator] ${m}`);

  // Clean up old package file if we created it before (causes duplicate key errors).
  const pkgFile = path.join(configDir, 'packages', 'tinta_http.yaml');
  try {
    if (fs.existsSync(pkgFile)) {
      fs.unlinkSync(pkgFile);
      log('Removed stale packages/tinta_http.yaml');
    }
  } catch { /* ignore */ }

  const configFile = path.join(configDir, 'configuration.yaml');
  let content: string;
  try { content = fs.readFileSync(configFile, 'utf8'); }
  catch { log('Could not read configuration.yaml — skipping http config'); return false; }

  const hasHttpSection = /^http:/m.test(content);
  const hasTrustedProxies = /trusted_proxies:/m.test(content);
  // If RFC1918 or the Cloudflare ranges are already present, we consider it configured.
  const hasRfc1918 = content.includes('192.168.0.0/16') || content.includes('10.0.0.0/8');

  if (hasHttpSection && hasTrustedProxies && hasRfc1918) {
    log('http.trusted_proxies already configured ✓');
    return false;
  }

  if (hasHttpSection && hasTrustedProxies && !hasRfc1918) {
    // Patch: add RFC1918 ranges right after 'trusted_proxies:' line.
    const patched = content.replace(
      /([ \t]*trusted_proxies:[ \t]*\n)/,
      `$1    - 10.0.0.0/8\n    - 172.16.0.0/12\n    - 192.168.0.0/16\n`,
    );
    if (patched !== content) {
      fs.writeFileSync(configFile, patched, 'utf8');
      log('Added RFC1918 ranges to existing trusted_proxies ✓');
      return true;
    }
    return false;
  }

  if (hasHttpSection && !hasTrustedProxies) {
    log('⚠ http: section exists but has no trusted_proxies — add manually');
    return false;
  }

  // No http: section at all — append a complete one.
  const httpBlock = [
    '',
    '# Tinta Agent — Cloudflare Tunnel proxy configuration',
    'http:',
    '  use_x_forwarded_for: true',
    '  trusted_proxies:',
    ...TRUSTED_PROXIES.map(ip => `    - ${ip}`),
    '',
  ].join('\n');

  fs.appendFileSync(configFile, httpBlock, 'utf8');
  log('Appended http.trusted_proxies to configuration.yaml ✓');
  return true;
}

async function restartHACore(supervisorToken: string): Promise<void> {
  return new Promise(resolve => {
    const req = http.request(
      { host: 'supervisor', port: 80, path: '/core/restart', method: 'POST',
        headers: { Authorization: `Bearer ${supervisorToken}`, 'Content-Type': 'application/json' } },
      res => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', e => {
      console.warn(`[HA Configurator] Could not trigger HA Core restart: ${e.message}`);
      resolve();
    });
    req.end();
  });
}

export async function configureHAForTunnel(
  opts: HAConfiguratorOptions,
  haClient: HAWebSocketClient | undefined,
): Promise<void> {
  const log = (msg: string) => console.log(`[HA Configurator] ${msg}`);

  if (!opts.externalUrl) {
    log('TINTA_EXTERNAL_URL not set — skipping HA auto-configuration');
    return;
  }

  // external_url — best-effort; don't abort trusted_proxies setup if this
  // fails, or if the HA WebSocket itself isn't up (it retries on its own
  // 5s reconnect loop — see websocket-ha.ts — so this just runs again on
  // the Agent's next restart/reconnect rather than blocking startup here).
  if (!haClient?.isConnected()) {
    log('HA WebSocket not connected — skipping external_url configuration');
  } else {
    try {
      await setExternalUrl(haClient, opts);
    } catch (err: any) {
      console.warn(`[HA Configurator] Could not set external_url: ${err.message}`);
    }
  }

  // trusted_proxies — runs independently of external_url result
  try {
    const configDir = process.env.HA_CONFIG_DIR ?? '/config';
    const needsRestart = ensureHttpTrustedProxies(configDir);

    if (needsRestart && opts.supervisorProxy && opts.token) {
      log('Restarting HA Core to apply trusted_proxies...');
      await restartHACore(opts.token);
      log('HA Core restart triggered ✓');
    } else if (needsRestart) {
      log('⚠ Restart HA Core manually to apply trusted_proxies');
    }
  } catch (err: any) {
    console.warn(`[HA Configurator] trusted_proxies setup failed: ${err.message}`);
  }
}
