import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

const log = (m: string) => console.log(`[Cloudflared] ${m}`);

const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN ?? '/usr/local/bin/cloudflared';

let child: ChildProcessWithoutNullStreams | null = null;
let currentToken: string | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let stopping = false;
let restartAttempt = 0;

function pipeOutput(proc: ChildProcessWithoutNullStreams) {
  proc.stdout.on('data', (d) => process.stdout.write(`[Cloudflared] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[Cloudflared] ${d}`));
}

function scheduleRestart(token: string) {
  if (stopping) return;
  // Exponential backoff capped at 60s — mirrors the reconnect pattern used
  // elsewhere in the agent (HA WS / Tinta Core sockets) rather than hammering
  // Cloudflare's edge if the tunnel keeps failing to establish.
  const delayMs = Math.min(60_000, 5_000 * 2 ** restartAttempt);
  restartAttempt += 1;
  log(`Restarting in ${Math.round(delayMs / 1000)}s...`);
  restartTimer = setTimeout(() => spawnTunnel(token), delayMs);
}

function spawnTunnel(token: string) {
  if (stopping) return;
  log('Starting tunnel...');
  const proc = spawn(
    CLOUDFLARED_BIN,
    ['tunnel', '--no-autoupdate', 'run', '--token', token],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child = proc;
  pipeOutput(proc);

  proc.on('spawn', () => {
    restartAttempt = 0;
    log('Tunnel process started ✓');
  });

  proc.on('error', (err) => {
    log(`Failed to start cloudflared binary: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    log(`Tunnel process exited (code=${code}, signal=${signal})`);
    scheduleRestart(token);
  });
}

// Starts (or restarts, if the token changed) the managed cloudflared
// process. Idempotent — calling again with the same token while already
// running is a no-op, so it's safe to call this on every agent startup
// without worrying about double-spawning.
export function ensureTunnelRunning(token: string | null | undefined): void {
  if (!token) {
    log('No tunnel token available — skipping (client has no individual Cloudflare Tunnel provisioned, or this agent predates auto-managed tunnels)');
    return;
  }
  if (child && currentToken === token) {
    return; // already running the right tunnel
  }
  if (child) {
    log('Tunnel token changed — restarting with new token');
    stopTunnel();
  }
  stopping = false;
  restartAttempt = 0;
  currentToken = token;
  spawnTunnel(token);
}

export function stopTunnel(): void {
  stopping = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) {
    child.kill('SIGTERM');
    child = null;
  }
}

export function isTunnelRunning(): boolean {
  return child !== null;
}
