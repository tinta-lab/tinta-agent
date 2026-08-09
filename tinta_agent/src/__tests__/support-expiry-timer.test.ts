import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Isolated timer logic extracted from agent.ts for testability
function makeExpiryController(onExpire: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function schedule(expiresAt: string) {
    clear();
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return;
    timer = setTimeout(onExpire, ms);
  }

  return { schedule, clear };
}

describe('support expiry timer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('calls onExpire after TTL elapses', () => {
    const onExpire = vi.fn();
    const ctrl = makeExpiryController(onExpire);

    const expiresAt = new Date(Date.now() + 60_000).toISOString(); // 60 s
    ctrl.schedule(expiresAt);

    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('does not call onExpire if cleared before TTL', () => {
    const onExpire = vi.fn();
    const ctrl = makeExpiryController(onExpire);

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    ctrl.schedule(expiresAt);
    ctrl.clear();

    vi.advanceTimersByTime(120_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('does not schedule if expiresAt is already in the past', () => {
    const onExpire = vi.fn();
    const ctrl = makeExpiryController(onExpire);

    const expiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
    ctrl.schedule(expiresAt);

    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('replaces existing timer when rescheduled', () => {
    const onExpire = vi.fn();
    const ctrl = makeExpiryController(onExpire);

    ctrl.schedule(new Date(Date.now() + 30_000).toISOString());
    ctrl.schedule(new Date(Date.now() + 60_000).toISOString()); // replace

    vi.advanceTimersByTime(30_000); // first timer would have fired
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000); // now 60s elapsed
    expect(onExpire).toHaveBeenCalledOnce();
  });
});
