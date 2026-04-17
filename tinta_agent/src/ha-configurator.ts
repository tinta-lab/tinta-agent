import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

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

function haRequest(opts: HAConfiguratorOptions, method: string, apiPath: string, body?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const prefix = opts.supervisorProxy ? '/core' : '';
    const options: http.RequestOptions = {
      host: opts.haHost,
      port: opts.haPort,
      path: `${prefix}${apiPath}`,
      method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const client = opts.ssl ? https : http;
    const req = client.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function setExternalUrl(opts: HAConfiguratorOptions): Promise<void> {
  const res = await haRequest(opts, 'GET', '/api/config');
  if (res.status !== 200) throw new Error(`HA /api/config returned ${res.status}`);
  const currentExternal = res.body?.external_url ?? '';

  if (currentExternal === opts.externalUrl) {
    console.log(`[HA Configurator] external_url already set to ${opts.externalUrl} ✓`);
    return;
  }

  // In supervisor proxy mode haHost is 'supervisor' — use HA_INTERNAL_URL env or skip internal_url.
  const internalUrl = process.env.HA_INTERNAL_URL ?? (opts.supervisorProxy ? undefined : `http${opts.ssl ? 's' : ''}://${opts.haHost}:${opts.haPort}`);
  const upd = await haRequest(opts, 'POST', '/api/config/core/update', {
    external_url: opts.externalUrl,
    ...(internalUrl ? { internal_url: internalUrl } : {}),
  });
  if (upd.status !== 200) throw new Error(`Failed to set external_url: ${upd.status}`);
  console.log(`[HA Configurator] external_url set to ${opts.externalUrl}`);
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

export async function configureHAForTunnel(opts: HAConfiguratorOptions): Promise<void> {
  const log = (msg: string) => console.log(`[HA Configurator] ${msg}`);

  if (!opts.externalUrl) {
    log('TINTA_EXTERNAL_URL not set — skipping HA auto-configuration');
    return;
  }

  // external_url — best-effort; don't abort trusted_proxies setup if this fails
  try {
    await setExternalUrl(opts);
  } catch (err: any) {
    console.warn(`[HA Configurator] Could not set external_url: ${err.message}`);
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
