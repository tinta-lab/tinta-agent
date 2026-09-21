// Extracted from agent.ts (2026-09-21) for the same reason
// support-expiry-timer.ts was: agent.ts itself exports nothing, so this
// logic could only ever be tested by hand against a real backend.
//
// Real incident this fixes (V&T home / hub-nx5g9c): the previous version of
// this enrollment call did `if (!res.ok) { log error; process.exit(1); }` —
// any non-2xx response, including the completely expected "consent not
// given yet" 403, crashed the process. HA Supervisor then restarted the
// add-on almost immediately (config.yaml: startup: services, boot: auto),
// so a client who took even a few minutes to read and accept the § 356 BGB
// consent screen produced a tight crash-restart loop: each restart burned
// one more of the 10 requests/15min GET /install/:token has
// (install.controller.ts's @Throttle), until the rate limiter kicked in and
// returned 429 — at which point even the BROWSER's own legitimate request
// (right after the client clicked "Bestätigen und fortfahren") got a 429
// too, which the frontend displayed as "Ссылка недействительна" (link
// invalid), even though the token was completely valid and consent had
// just succeeded. Three real bugs chained together; this module fixes the
// root one — the agent must never crash-loop on an expected, temporary
// condition.

export interface Credentials {
  clientId: string;
  agentToken: string;
  externalUrl: string;
  tunnelToken?: string | null;
}

export interface EnrollLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface EnrollDeps extends EnrollLogger {
  fetchFn: typeof fetch;
  sleepFn: (ms: number) => Promise<void>;
  exit: (code: number) => never;
  random?: () => number;
}

// Backend throttles GET /install/:token to 10 requests / 15 min per route.
// A capped exponential backoff (max 120s) keeps the sustained retry rate
// under 8 requests/15min even if this loop runs forever — safely inside
// that budget with margin, so a slow-to-consent installer can never itself
// trigger the 429 that used to cascade into a "link invalid" message for a
// completely unrelated concurrent browser tab.
export function enrollBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(2_000 * 2 ** attempt, 120_000);
  return base + random() * base * 0.3; // jitter so many agents don't retry in lockstep
}

export async function enrollWithRetry(
  coreBase: string,
  installToken: string,
  deps: EnrollDeps,
): Promise<Credentials> {
  const { fetchFn, sleepFn, log, warn, error, exit, random } = deps;
  let attempt = 0;
  log('[Tinta Agent] Enrolling via install token...');

  for (;;) {
    let res: Response;
    try {
      res = await fetchFn(`${coreBase}/install/${installToken}`);
    } catch (e: any) {
      // Network error (Core unreachable, DNS, etc.) — transient, same
      // backoff as everything else that isn't a terminal token state.
      const waitMs = enrollBackoffMs(attempt++, random);
      warn(`[Tinta Agent] Enrollment request failed (${e.message}) — retrying in ${Math.round(waitMs / 1000)}s`);
      await sleepFn(waitMs);
      continue;
    }

    if (res.ok) {
      const cfg = await res.json() as any;
      return {
        clientId: cfg.clientId,
        agentToken: cfg.agentToken,
        externalUrl: cfg.externalUrl ?? '',
        tunnelToken: cfg.tunnelToken ?? null,
      };
    }

    if (res.status === 404 || res.status === 410) {
      // Terminal: the token was never valid, was already consumed by a
      // previous successful enrollment, or has expired. No amount of
      // retrying can ever succeed — a human needs to issue a fresh install
      // link. Exiting here (unlike the other branches) is correct, not a
      // bug: there is nothing to wait for.
      const body = await res.text().catch(() => '');
      error(`[Tinta Agent] Install token is invalid or expired (HTTP ${res.status}: ${body}). Request a new install link — this agent will not retry.`);
      exit(1);
    }

    if (res.status === 403) {
      // WAITING_FOR_CONSENT: the backend deliberately withholds config
      // until POST /install/:token/consent has succeeded (§ 356 BGB — see
      // ProvisioningService.getInstallConfig). This is not an error, just a
      // normal wait for a human to read and accept the consent screen in
      // their browser — log it plainly so it doesn't look like a fault,
      // and back off on the same safe schedule as everything else.
      const waitMs = enrollBackoffMs(attempt++, random);
      log(`[Tinta Agent] Waiting for service-start consent to be confirmed in the browser — checking again in ${Math.round(waitMs / 1000)}s`);
      await sleepFn(waitMs);
      continue;
    }

    if (res.status === 429) {
      // Rate limited — honor Retry-After when the server sends one, since
      // it knows the exact remaining window; otherwise fall back to the
      // same capped backoff.
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const waitMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : enrollBackoffMs(attempt++, random);
      warn(`[Tinta Agent] Rate limited (429) — waiting ${Math.round(waitMs / 1000)}s before retrying`);
      await sleepFn(waitMs);
      continue;
    }

    // Anything else (5xx, unexpected 4xx) — treat as transient.
    const waitMs = enrollBackoffMs(attempt++, random);
    const body = await res.text().catch(() => '');
    warn(`[Tinta Agent] Enrollment failed (HTTP ${res.status}: ${body}) — retrying in ${Math.round(waitMs / 1000)}s`);
    await sleepFn(waitMs);
  }
}
