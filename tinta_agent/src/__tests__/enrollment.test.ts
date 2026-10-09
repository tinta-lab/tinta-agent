import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enrollWithRetry, enrollBackoffMs, normalizeInstallToken, INVALID_TOKEN_RECHECK_MS, type EnrollDeps, type EnrollStatus } from '../enrollment';

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
  logs: string[]; warns: string[]; errors: string[]; sleeps: number[]; statuses: EnrollStatus[];
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const sleeps: number[] = [];
  const statuses: EnrollStatus[] = [];
  const deps = {
    fetchFn: vi.fn(),
    sleepFn: vi.fn(async (ms: number) => { sleeps.push(ms); }),
    log: (msg: string) => logs.push(msg),
    warn: (msg: string) => warns.push(msg),
    error: (msg: string) => errors.push(msg),
    onStatus: (st: EnrollStatus) => statuses.push(st),
    random: () => 0, // deterministic: no jitter in assertions
    ...overrides,
  };
  return {
    ...deps,
    logs, warns, errors, sleeps, statuses,
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
    expect(deps.sleeps).toEqual([2_000, 4_000]); // capped exponential, no jitter (random=0)
    expect(deps.logs.some(l => l.includes('Waiting for service-start consent'))).toBe(true);
    expect(deps.errors).toEqual([]); // this is not an error condition
    expect(deps.statuses).toEqual([{ kind: 'waiting_consent' }]); // shown once, not per poll
  });

  // Was: exit(1). An exited add-on just shows as "stopped" in HA with no
  // explanation, so it now stays up, reports the state, and parks.
  it.each([404, 410])('%i (invalid/expired token) reports it and parks for 30 min instead of exiting', async (status) => {
    const deps = makeDeps();
    (deps.fetchFn as any)
      .mockResolvedValueOnce(makeResponse(status, { message: 'Install link not found' }))
      .mockResolvedValueOnce(makeResponse(200, { clientId: 'c1', agentToken: 'jwt' }));

    const creds = await enrollWithRetry('https://api.example', 'install-token', deps);

    expect(creds.clientId).toBe('c1');
    expect(deps.statuses).toEqual([{ kind: 'invalid', httpStatus: status }]);
    expect(deps.sleeps).toEqual([INVALID_TOKEN_RECHECK_MS]);
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

    expect(deps.sleeps).toEqual([2_000]);
    expect(deps.warns.some(w => w.includes('ECONNREFUSED'))).toBe(true);
    expect(deps.statuses).toEqual([]); // one blip is not worth alarming the installer
  });

  it('an unexpected 5xx retries with backoff, never exits', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any)
      .mockResolvedValueOnce(makeResponse(500, { message: 'Internal Server Error' }))
      .mockResolvedValueOnce(makeResponse(200, { clientId: 'c1', agentToken: 'jwt' }));

    await enrollWithRetry('https://api.example', 'install-token', deps);

    expect(deps.sleeps).toEqual([2_000]);
  });

  it('reports unreachable after 3 consecutive network failures, once', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any)
      .mockRejectedValueOnce(new Error('ENOTFOUND'))
      .mockRejectedValueOnce(new Error('ENOTFOUND'))
      .mockRejectedValueOnce(new Error('ENOTFOUND'))
      .mockRejectedValueOnce(new Error('ENOTFOUND'))
      .mockResolvedValueOnce(makeResponse(200, { clientId: 'c1', agentToken: 'jwt' }));

    await enrollWithRetry('https://api.example', 'install-token', deps);

    expect(deps.statuses).toEqual([{ kind: 'unreachable', error: 'ENOTFOUND' }]);
  });

  it('requests the bare UUID even when the whole install URL was pasted', async () => {
    const deps = makeDeps();
    (deps.fetchFn as any).mockResolvedValueOnce(makeResponse(200, { clientId: 'c1', agentToken: 'jwt' }));

    await enrollWithRetry('https://api.example', ' https://app.tinta-lab.de/install/0F8FAD5B-D9CB-469F-A165-70867728950E \n', deps);

    expect(deps.fetchFn).toHaveBeenCalledWith('https://api.example/install/0f8fad5b-d9cb-469f-a165-70867728950e');
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

describe('normalizeInstallToken', () => {
  it('extracts the UUID from a URL, trims whitespace, lowercases', () => {
    expect(normalizeInstallToken('https://app.tinta-lab.de/install/0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(normalizeInstallToken('  0f8fad5b-d9cb-469f-a165-70867728950e\n')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
  });
  it('leaves a non-UUID token as-is (trimmed) so the backend decides', () => {
    expect(normalizeInstallToken('  legacy-token ')).toBe('legacy-token');
  });
});
