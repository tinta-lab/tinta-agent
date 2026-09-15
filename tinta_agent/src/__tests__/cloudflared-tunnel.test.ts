import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake child process: an EventEmitter with the stdout/stderr streams and
// kill() the module under test relies on.
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

describe('cloudflared-tunnel', () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when no token is provided', async () => {
    const { ensureTunnelRunning, isTunnelRunning } = await import('../cloudflared-tunnel');
    ensureTunnelRunning(null);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(isTunnelRunning()).toBe(false);
  });

  it('spawns cloudflared with the given token', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const { ensureTunnelRunning, isTunnelRunning } = await import('../cloudflared-tunnel');

    ensureTunnelRunning('my-token');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toContain('cloudflared');
    expect(args).toEqual(['tunnel', '--no-autoupdate', 'run', '--token', 'my-token']);
    expect(isTunnelRunning()).toBe(true);
  });

  it('is a no-op when called again with the same token', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const { ensureTunnelRunning } = await import('../cloudflared-tunnel');

    ensureTunnelRunning('same-token');
    ensureTunnelRunning('same-token');

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('restarts with the new token when the token changes', async () => {
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const { ensureTunnelRunning } = await import('../cloudflared-tunnel');

    ensureTunnelRunning('token-a');
    ensureTunnelRunning('token-b');

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnMock.mock.calls[1][1]).toEqual(['tunnel', '--no-autoupdate', 'run', '--token', 'token-b']);
  });

  it('schedules a restart when the process exits unexpectedly', async () => {
    vi.useFakeTimers();
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const { ensureTunnelRunning, isTunnelRunning } = await import('../cloudflared-tunnel');

    ensureTunnelRunning('flaky-token');
    child1.emit('exit', 1, null);
    expect(isTunnelRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not restart after stopTunnel() was called', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const { ensureTunnelRunning, stopTunnel } = await import('../cloudflared-tunnel');

    ensureTunnelRunning('token');
    stopTunnel();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
