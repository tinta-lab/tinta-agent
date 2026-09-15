import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HAWebSocketClient } from '../websocket-ha';

const setSupportUserActive = vi.fn();
const dismissBanner = vi.fn();
const setAccessToggle = vi.fn();

vi.mock('../ha-support-user', () => ({ setSupportUserActive: (...args: any[]) => setSupportUserActive(...args) }));
vi.mock('../ha-banner', () => ({ dismissBanner: (...args: any[]) => dismissBanner(...args) }));
vi.mock('../ha-access-toggle', () => ({ setAccessToggle: (...args: any[]) => setAccessToggle(...args) }));

// P2.2: import the actual production lifecycle unit extracted from agent.ts,
// rather than a hand-copied reimplementation of its scheduling logic — the
// previous version of this file tested a lookalike `makeExpiryController`
// that never called setSupportUserActive/dismissBanner/setAccessToggle at
// all, so it couldn't catch a regression in the real revoke-on-expiry path.
import { createSupportExpiryTimer } from '../support-expiry-timer';

function makeMockHA(connected = true) {
  return { isConnected: () => connected } as unknown as HAWebSocketClient;
}

describe('createSupportExpiryTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSupportUserActive.mockReset().mockResolvedValue(undefined);
    dismissBanner.mockReset().mockResolvedValue(undefined);
    setAccessToggle.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('revokes support access after TTL elapses', async () => {
    const haClient = makeMockHA(true);
    let toggleKnownState: 'on' | 'off' | null = 'on';
    const timer = createSupportExpiryTimer({
      haClient,
      getToggleKnownState: () => toggleKnownState,
      setToggleKnownState: (s) => { toggleKnownState = s; },
      log: () => {},
    });

    timer.schedule(new Date(Date.now() + 60_000).toISOString());
    expect(setSupportUserActive).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(setSupportUserActive).toHaveBeenCalledOnce();
    expect(setSupportUserActive).toHaveBeenCalledWith(haClient, false);
    expect(dismissBanner).toHaveBeenCalledOnce();
    expect(dismissBanner).toHaveBeenCalledWith(haClient);
    expect(setAccessToggle).toHaveBeenCalledOnce();
    expect(setAccessToggle).toHaveBeenCalledWith(haClient, false);
    expect(toggleKnownState).toBe('off');
  });

  it('does not revoke if cleared before TTL', async () => {
    const haClient = makeMockHA(true);
    const timer = createSupportExpiryTimer({
      haClient,
      getToggleKnownState: () => 'on',
      setToggleKnownState: () => {},
      log: () => {},
    });

    timer.schedule(new Date(Date.now() + 60_000).toISOString());
    timer.clear();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(setSupportUserActive).not.toHaveBeenCalled();
  });

  it('does not schedule if expiresAt is already in the past', async () => {
    const haClient = makeMockHA(true);
    const timer = createSupportExpiryTimer({
      haClient,
      getToggleKnownState: () => 'on',
      setToggleKnownState: () => {},
      log: () => {},
    });

    timer.schedule(new Date(Date.now() - 1000).toISOString());

    await vi.advanceTimersByTimeAsync(10_000);
    expect(setSupportUserActive).not.toHaveBeenCalled();
  });

  it('replaces existing timer when rescheduled', async () => {
    const haClient = makeMockHA(true);
    const timer = createSupportExpiryTimer({
      haClient,
      getToggleKnownState: () => 'on',
      setToggleKnownState: () => {},
      log: () => {},
    });

    timer.schedule(new Date(Date.now() + 30_000).toISOString());
    timer.schedule(new Date(Date.now() + 60_000).toISOString()); // replace

    await vi.advanceTimersByTimeAsync(30_000); // first timer would have fired
    expect(setSupportUserActive).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000); // now 60s elapsed
    expect(setSupportUserActive).toHaveBeenCalledOnce();
  });

  it('skips the revoke calls entirely if HA is not connected when the timer fires', async () => {
    const haClient = makeMockHA(false);
    const timer = createSupportExpiryTimer({
      haClient,
      getToggleKnownState: () => 'on',
      setToggleKnownState: () => {},
      log: () => {},
    });

    timer.schedule(new Date(Date.now() + 60_000).toISOString());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(setSupportUserActive).not.toHaveBeenCalled();
    expect(dismissBanner).not.toHaveBeenCalled();
    expect(setAccessToggle).not.toHaveBeenCalled();
  });

  it('does not call setAccessToggle again if the toggle is already off', async () => {
    const haClient = makeMockHA(true);
    let toggleKnownState: 'on' | 'off' | null = 'off';
    const timer = createSupportExpiryTimer({
      haClient,
      getToggleKnownState: () => toggleKnownState,
      setToggleKnownState: (s) => { toggleKnownState = s; },
      log: () => {},
    });

    timer.schedule(new Date(Date.now() + 60_000).toISOString());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(setSupportUserActive).toHaveBeenCalledOnce();
    expect(dismissBanner).toHaveBeenCalledOnce();
    expect(setAccessToggle).not.toHaveBeenCalled();
  });
});
