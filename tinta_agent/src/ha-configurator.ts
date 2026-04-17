import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

const CLOUDFLARE_TRUSTED_PROXIES = [
  '127.0.0.1',
  '::1',
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

const PROXY_FILE_CONTENT = [
  '# Auto-configured by Tinta Agent — do not edit manually',
  'http:',
  '  use_x_forwarded_for: true',
  '  trusted_proxies:',
  ...CLOUDFLARE_TRUSTED_PROXIES.map(ip => `    - ${ip}`),
  '',
].join('\n');

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

  const internalUrl = `http${opts.ssl ? 's' : ''}://${opts.haHost}:${opts.haPort}`;
  const upd = await haRequest(opts, 'POST', '/api/config/core/update', {
    external_url: opts.externalUrl,
    internal_url: internalUrl,
  });
  if (upd.status !== 200) throw new Error(`Failed to set external_url: ${upd.status}`);
  console.log(`[HA Configurator] external_url set to ${opts.externalUrl}`);
}

function writeTrustedProxiesFile(configDir: string): boolean {
  try {
    const packagesDir = path.join(configDir, 'packages');
    const proxyFile = path.join(packagesDir, 'tinta_http.yaml');

    let existing = '';
    try { existing = fs.readFileSync(proxyFile, 'utf8'); } catch { /* doesn't exist */ }

    if (existing === PROXY_FILE_CONTENT) return false; // already up to date

    fs.mkdirSync(packagesDir, { recursive: true });
    fs.writeFileSync(proxyFile, PROXY_FILE_CONTENT, 'utf8');
    console.log(`[HA Configurator] Written trusted_proxies to ${proxyFile}`);
    return true;
  } catch (err: any) {
    console.warn(`[HA Configurator] Could not write trusted_proxies file: ${err.message}`);
    return false;
  }
}

function ensurePackagesInclude(configDir: string): void {
  const configFile = path.join(configDir, 'configuration.yaml');
  try {
    let content = '';
    try { content = fs.readFileSync(configFile, 'utf8'); } catch { return; }

    if (content.includes('!include_dir_named packages') || content.includes('!include_dir_merge_named packages')) {
      return; // already has packages include
    }

    const packageLine = '\nhomeassistant:\n  packages: !include_dir_named packages\n';
    fs.appendFileSync(configFile, packageLine, 'utf8');
    console.log('[HA Configurator] Added packages include to configuration.yaml');
  } catch (err: any) {
    console.warn(`[HA Configurator] Could not update configuration.yaml: ${err.message}`);
  }
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

  try {
    // 1. Set external_url via HA REST API
    await setExternalUrl(opts);

    // 2. Write trusted_proxies directly to /config (addon has config:rw)
    const configDir = process.env.HA_CONFIG_DIR ?? '/config';
    const wrote = writeTrustedProxiesFile(configDir);

    if (wrote) {
      // Ensure configuration.yaml has packages include
      ensurePackagesInclude(configDir);

      // Restart HA Core so trusted_proxies takes effect
      if (opts.supervisorProxy && opts.token) {
        log('Restarting HA Core to apply trusted_proxies...');
        await restartHACore(opts.token);
        log('HA Core restart triggered ✓');
      } else {
        log('⚠ Restart HA Core manually to apply trusted_proxies');
      }
    } else {
      log('trusted_proxies already configured ✓');
    }
  } catch (err: any) {
    console.warn(`[HA Configurator] Warning: ${err.message} — skipping auto-configuration`);
  }
}
