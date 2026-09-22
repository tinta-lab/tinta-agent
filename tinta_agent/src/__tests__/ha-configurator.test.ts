import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureHAForTunnel, type HAConfiguratorOptions } from '../ha-configurator';
import type { HAWebSocketClient } from '../websocket-ha';

// Regression coverage for the external_url 404: the previous implementation
// called POST /api/config/core/update as a plain REST request, but that
// route has never existed in Home Assistant — only the WebSocket command
// config/core/update does (the one HA's own "General" settings page uses).
// This suite pins the WS-based replacement: no HTTP call, no second HA
// connection, uses the Agent's own already-connected haClient, and never
// throws out of configureHAForTunnel regardless of what HA WS does.
function makeMockHA(connected = true) {
  const sendCommand = vi.fn();
  const isConnected = vi.fn(() => connected);
  const haClient = { sendCommand, isConnected } as unknown as HAWebSocketClient;
  return { haClient, sendCommand, isConnected };
}

const baseOpts: HAConfiguratorOptions = {
  haHost: 'supervisor',
  haPort: 80,
  token: 'supervisor-token',
  ssl: false,
  externalUrl: 'https://hub-test123.tinta-lab.de',
  supervisorProxy: true,
};

describe('configureHAForTunnel — external_url via HA WebSocket', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('does nothing when externalUrl is not configured', async () => {
    const { haClient, sendCommand } = makeMockHA();
    await configureHAForTunnel({ ...baseOpts, externalUrl: '' }, haClient);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('skips external_url step when the HA WebSocket is not connected — never opens a second one', async () => {
    const { haClient, sendCommand } = makeMockHA(false);
    await configureHAForTunnel(baseOpts, haClient);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('skips gracefully when no haClient is passed at all', async () => {
    await configureHAForTunnel(baseOpts, undefined);
    // No throw is the assertion; nothing else to check without a client.
  });

  it('is idempotent: already-correct external_url issues no update command', async () => {
    const { haClient, sendCommand } = makeMockHA();
    sendCommand.mockResolvedValueOnce({ external_url: baseOpts.externalUrl }); // get_config

    await configureHAForTunnel(baseOpts, haClient);

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith({ type: 'get_config' });
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'config/core/update' }),
    );
  });

  it('applies a real change via the WS command, then verifies it read back correctly', async () => {
    const { haClient, sendCommand } = makeMockHA();
    sendCommand
      .mockResolvedValueOnce({ external_url: 'https://old.tinta-lab.de' }) // get_config (before)
      .mockResolvedValueOnce({})                                          // config/core/update
      .mockResolvedValueOnce({ external_url: baseOpts.externalUrl });     // get_config (verify)

    await configureHAForTunnel(baseOpts, haClient);

    expect(sendCommand).toHaveBeenCalledTimes(3);
    expect(sendCommand.mock.calls[0][0]).toEqual({ type: 'get_config' });
    expect(sendCommand.mock.calls[1][0]).toMatchObject({
      type: 'config/core/update',
      external_url: baseOpts.externalUrl,
    });
    expect(sendCommand.mock.calls[2][0]).toEqual({ type: 'get_config' });
    // Never falls back to a raw HTTP call — this is the whole point of the fix.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('derives internal_url from haHost/haPort when not running behind the supervisor proxy', async () => {
    const { haClient, sendCommand } = makeMockHA();
    sendCommand
      .mockResolvedValueOnce({ external_url: 'https://old.tinta-lab.de' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ external_url: baseOpts.externalUrl });

    await configureHAForTunnel(
      { ...baseOpts, haHost: '192.168.1.50', haPort: 8123, ssl: false, supervisorProxy: false },
      haClient,
    );

    expect(sendCommand.mock.calls[1][0]).toMatchObject({
      type: 'config/core/update',
      external_url: baseOpts.externalUrl,
      internal_url: 'http://192.168.1.50:8123',
    });
  });

  it('never throws out of configureHAForTunnel when the WS command itself fails', async () => {
    const { haClient, sendCommand } = makeMockHA();
    sendCommand
      .mockResolvedValueOnce({ external_url: 'https://old.tinta-lab.de' })
      .mockRejectedValueOnce(new Error('unknown_command'));

    await expect(configureHAForTunnel(baseOpts, haClient)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not set external_url'));
  });

  it('never throws when HA accepts the update but reads back a different value', async () => {
    const { haClient, sendCommand } = makeMockHA();
    sendCommand
      .mockResolvedValueOnce({ external_url: 'https://old.tinta-lab.de' }) // before
      .mockResolvedValueOnce({})                                          // update "succeeds"
      .mockResolvedValueOnce({ external_url: 'https://old.tinta-lab.de' }); // verify: unchanged!

    await expect(configureHAForTunnel(baseOpts, haClient)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not set external_url'));
  });

  it('treats a null external_url from HA the same as absent — triggers the update, not a crash', async () => {
    const { haClient, sendCommand } = makeMockHA();
    sendCommand
      .mockResolvedValueOnce({ external_url: null })                     // HA reports genuinely unset
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ external_url: baseOpts.externalUrl });

    await configureHAForTunnel(baseOpts, haClient);

    expect(sendCommand.mock.calls[1][0]).toMatchObject({
      type: 'config/core/update',
      external_url: baseOpts.externalUrl,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Regression coverage for the reviewer-flagged race: HAWebSocketClient.send()
  // has no timeout of its own, and a disconnect mid-flight never rejects an
  // in-flight sendCommand() (websocket-ha.ts only flips `connected = false`
  // and schedules a reconnect — it doesn't touch pendingMap). Without a local
  // timeout here, a WS drop between get_config and config/core/update would
  // hang this function — and therefore configureHAForTunnel(), which agent.ts
  // main() awaits before subscribing to HA events — forever.
  it('fails fast instead of hanging forever when a WS command never resolves (dropped mid-flight)', async () => {
    vi.useFakeTimers();
    try {
      const { haClient, sendCommand } = makeMockHA();
      sendCommand
        .mockResolvedValueOnce({ external_url: 'https://old.tinta-lab.de' }) // get_config OK
        .mockReturnValueOnce(new Promise(() => {})); // config/core/update: never settles

      const run = configureHAForTunnel(baseOpts, haClient);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(run).resolves.toBeUndefined(); // caught by configureHAForTunnel, not a hang/throw

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('config/core/update timed out after 10000ms'),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
