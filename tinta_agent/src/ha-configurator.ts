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

interface HAConfiguratorOptions {
  haHost: string;
  haPort: number;
  token: string;
  ssl: boolean;
  externalUrl: string;
}

function haRequest(opts: HAConfiguratorOptions, method: string, path: string, body?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      host: opts.haHost,
      port: opts.haPort,
      path,
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

async function getCurrentHAConfig(opts: HAConfiguratorOptions): Promise<Record<string, any>> {
  const res = await haRequest(opts, 'GET', '/api/config');
  if (res.status !== 200) throw new Error(`HA /api/config returned ${res.status}`);
  return res.body;
}

async function setExternalUrl(opts: HAConfiguratorOptions): Promise<void> {
  const internalUrl = `http${opts.ssl ? 's' : ''}://${opts.haHost}:${opts.haPort}`;
  const res = await haRequest(opts, 'POST', '/api/config/core/update', {
    external_url: opts.externalUrl,
    internal_url: internalUrl,
  });
  if (res.status !== 200) throw new Error(`Failed to set external_url: ${res.status} ${JSON.stringify(res.body)}`);
}

async function readConfigFile(opts: HAConfiguratorOptions): Promise<string | null> {
  // Try HA's built-in file API (requires File Editor or Studio Code Server addon)
  const res = await haRequest(opts, 'GET', '/api/file_editor?file=/config/configuration.yaml');
  if (res.status === 200 && typeof res.body === 'string') return res.body;
  // Fallback: try newer Studio Code Server path
  const res2 = await haRequest(opts, 'GET', '/api/hassio/ingress/a0d7b954_vscode');
  return null;
}

async function writeHttpConfig(opts: HAConfiguratorOptions): Promise<boolean> {
  // Try to write a package file via HA packages feature
  const packageContent = [
    '# Auto-configured by Tinta Agent — do not edit manually',
    'http:',
    '  use_x_forwarded_for: true',
    '  trusted_proxies:',
    ...CLOUDFLARE_TRUSTED_PROXIES.map(ip => `    - ${ip}`),
    '',
  ].join('\n');

  // Attempt via HA REST API (requires File Editor addon)
  const res = await haRequest(opts, 'POST', '/api/file_editor', {
    file: '/config/packages/tinta_proxy.yaml',
    content: packageContent,
  });

  if (res.status === 200 || res.status === 201) return true;

  // Try alternate file editor API format
  const res2 = await haRequest(opts, 'POST', '/api/hassio/addons/a0d7b954_vscode/api/editor/file', {
    path: '/config/packages/tinta_proxy.yaml',
    content: packageContent,
  });

  return res2.status === 200 || res2.status === 201;
}

function proxyAlreadyConfigured(haConfig: Record<string, any>): boolean {
  // HA /api/config doesn't expose http section directly,
  // but if external_url matches we assume it was set before
  return false; // always check — lightweight operation
}

export async function configureHAForTunnel(opts: HAConfiguratorOptions): Promise<void> {
  const log = (msg: string) => console.log(`[HA Configurator] ${msg}`);

  if (!opts.externalUrl) {
    log('TINTA_EXTERNAL_URL not set — skipping HA auto-configuration');
    return;
  }

  try {
    // 1. Read current HA config
    const haConfig = await getCurrentHAConfig(opts);
    const currentExternal = haConfig.external_url ?? '';

    // 2. Set external_url if different
    if (currentExternal !== opts.externalUrl) {
      await setExternalUrl(opts);
      log(`external_url set to ${opts.externalUrl}`);
    } else {
      log(`external_url already set to ${opts.externalUrl} ✓`);
    }

    // 3. Try to write trusted_proxies package file
    const written = await writeHttpConfig(opts);
    if (written) {
      log('http.trusted_proxies package written to /config/packages/tinta_proxy.yaml ✓');
      log('NOTE: Add "packages: !include_dir_named packages" to configuration.yaml if not already present');
    } else {
      // Can't write — print clear manual instructions
      log('⚠ Could not auto-write trusted_proxies — add this to configuration.yaml manually:');
      log('');
      log('http:');
      log('  use_x_forwarded_for: true');
      log('  trusted_proxies:');
      for (const ip of CLOUDFLARE_TRUSTED_PROXIES) {
        log(`    - ${ip}`);
      }
      log('');
    }
  } catch (err: any) {
    console.warn(`[HA Configurator] Warning: ${err.message} — skipping auto-configuration`);
  }
}
