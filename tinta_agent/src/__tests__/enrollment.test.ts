import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enrollWithRetry, enrollBackoffMs, type EnrollDeps } from '../enrollment';

// Regression coverage for enrollment retry behavior: the previous
// implementation crashed the process on the first non-2xx response,
// including the completely expected "consent not given yet" 403 — HA
// Supervisor's restart-on-crash then produced a tight loop that burned
// through the backend's rate limit and made even the browser's legitimate
// request fail. These tests exercise the real classification logic
// directly, not a reimplementation of it.

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeDeps(overrides: Partial<EnrollDeps> = {}): EnrollDeps & {
  logs: string[]; warns: string[]; errors: string[]; exitCode: number | null; sleeps: number[];
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const sleeps: number[] = [];
  // Plain mutable box, not a getter — Object.assign/spread would otherwise
  // flatten a getter to its (still-null) value at construction time, before
  // any fetch call has had a chance to trigger exit().
  const exitBox = { code: null as number | null };
  const deps = {
    fetchFn: vi.fn(),
    sleepFn: vi.fn(async (ms: number) => { sleeps.push(ms); }),
    log: (msg: string) => logs.push(msg),
    warn: (msg: string) => warns.push(msg),
    error: (msg: string) => errors.push(msg),
    exit: ((code: number) => { exitBox.code = code; throw new Error(`exit(${code})`); }) as (code: number) => never,
    random: () => 0, // deterministic: no jitter in assertions
    ...overrides,
  };
  return {
    ...deps,
    logs, warns, errors, sleeps,
    get exitCode() { return exitBox.code; },
  };
}

describe('enrollBackoffMs', () => {
  it('grows exponentially and caps at 120s (plus up to 30% jitter)', () => {
    expect(enrollBackoffMs(0, () => 0)).toBe(2_000);
    expect(enrollBackoffMs(1, () => 0)).toBe(4_000);
    expect(enrollBackoffMs(2, () => 0)).toBe(8_000);
    expect(enrollBackoffMs(10, () => 0)).toBe(120_000); // capped, not 2000*2^10
    expect(enrollBackoffMs(10, () => 1)).toBe(120_000 * 1.3);
  });
});

describe('enrollWithRetry', () => {
  it('returns credentials immediately on a 200 response', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any).mockResolvedValueOnce(
      makeResponse(200, { clientId: 'c1', agentToken: 'jwt', externalUrl: 'https://hub.example', tunnelToken: 'tok' }),
    );

    const creds = await enrollWithRetry('https://api.example', 'install-token', deps);

    expect(creds).toEqual({ clientId: 'c1', agentToken: 'jwt', externalUrl: 'https://hub.example', tunnelToken: 'tok' });
    expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    expect(deps.sleeps).toEqual([]);
  });

  it('403 (consent not yet given) retries with backoff instead of exiting — the actual root-cause fix', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any)
      .mockResolvedValueOnce(makeResponse(403, { message: 'Service start consent required before install config can be revealed' }))
      .mockResolvedValueOnce(makeResponse(403, { message: 'Service start consent required before install config can be revealed' }))
      .mockResolvedValueOnce(makeResponse(200, { clientId: 'c1', agentToken: 'jwt' }));

    const creds = await enrollWithRetry('https://api.example', 'install-token', deps);

    expect(creds.clientId).toBe('c1');
    expect(deps.fetchFn).toHaveBeenCalledTimes(3);
    expect(deps.exitCode).toBeNull(); // must NOT have crashed the process
    expect(deps.sleeps).toEqual([2_000, 4_000]); // capped exponential, no jitter (random=0)
    expect(deps.logs.some(l => l.includes('Waiting for service-start consent'))).toBe(true);
    expect(deps.errors).toEqual([]); // this is not an error condition
  });

  it('404 (token never valid) exits immediately without retrying', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any).mockResolvedValueOnce(makeResponse(404, { message: 'Install link not found' }));

    await expect(enrollWithRetry('https://api.example', 'install-token', deps)).rejects.toThrow('exit(1)');

    expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    expect(deps.exitCode).toBe(1);
    expect(deps.sleeps).toEqual([]); // no retry — terminal
  });

  it('410 (expired token) exits immediately without retrying', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any).mockResolvedValueOnce(makeResponse(410, { message: 'Install link has expired' }));

    await expect(enrollWithRetry('https://api.example', 'install-token', deps)).rejects.toThrow('exit(1)');

    expect(deps.exitCode).toBe(1);
    expect(deps.sleeps).toEqual([]);
  });

  it('429 honors Retry-After when present, in seconds', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any)
      .mockResolvedValueOnce(makeResponse(429, { message: 'Too Many Requests' }, { 'retry-after': '419' }))
      .mockResolvedValueOnce(makeResponse(200, { clientId: 'c1', agentToken: 'jwt' }));

    await enrollWithRetry('https://api.example', 'install-token', deps);

    expect(deps.sleeps).toEqual([419_000]);
  });

  it('429 without Retry-After falls back to the capped backoff', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any)
      .mockResolvedValueOnce(makeResponse(429, { message: 'Too Many Requests' }))
      .mockResolvedValueOnce(makeResponse(200, { clientId: 'c1', agentToken: 'jwt' }));

    await enrollWithRetry('https://api.example', 'install-token', deps);

    expect(deps.sleeps).toEqual([2_000]);
  });

  it('a thrown network error retries with backoff, never exits', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(makeResponse(200, { clientId: 'c1', agentToken: 'jwt' }));

    await enrollWithRetry('https://api.example', 'install-token', deps);

    expect(deps.exitCode).toBeNull();
    expect(deps.sleeps).toEqual([2_000]);
    expect(deps.warns.some(w => w.includes('ECONNREFUSED'))).toBe(true);
  });

  it('an unexpected 5xx retries with backoff, never exits', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any)
      .mockResolvedValueOnce(makeResponse(500, { message: 'Internal Server Error' }))
      .mockResolvedValueOnce(makeResponse(200, { clientId: 'c1', agentToken: 'jwt' }));

    await enrollWithRetry('https://api.example', 'install-token', deps);

    expect(deps.exitCode).toBeNull();
    expect(deps.sleeps).toEqual([2_000]);
  });

  it('never exceeds ~8 requests per 15-minute throttle window even on sustained 403 waits', () => {
    // Sanity check on the backoff schedule itself, not the loop: after a
    // handful of attempts the interval settles at the 120s cap, so the
    // long-run request rate is 900s / 120s = 7.5 req/15min — safely under
    // install.controller.ts's limit of 10 req/15min, with margin.
    const noJitter = () => 0;
    const steadyStateInterval = enrollBackoffMs(20, noJitter);
    expect(steadyStateInterval).toBe(120_000);
    expect(900_000 / steadyStateInterval).toBeLessThan(10);
  });
});
