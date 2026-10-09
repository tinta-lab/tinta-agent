// Extracted from agent.ts for the same reason support-expiry-timer.ts was:
// agent.ts itself exports nothing, so this logic could only ever be tested
// by hand against a real backend.
//
// Regression this fixes: the previous version of this enrollment call did
// `if (!res.ok) { log error; process.exit(1); }` — any non-2xx response,
// including the completely expected "consent not given yet" 403, crashed
// the process. HA Supervisor then restarted the add-on almost immediately
// (config.yaml: startup: services, boot: auto), so a client who took even
// a few minutes to read and accept the § 356 BGB consent screen produced a
// tight crash-restart loop: each restart burned one more of the 10
// requests/15min GET /install/:token has (install.controller.ts's
// @Throttle), until the rate limiter kicked in and returned 429 — at which
// point even the browser's own legitimate request (right after the client
// completed consent) got a 429 too, which the frontend displayed as an
// "invalid link" error, even though the token was completely valid and
// consent had just succeeded. Three real bugs chained together; this
// module fixes the root one — the agent must never crash-loop on an
// expected, temporary condition.

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

// What the installer should be told right now. Surfaced as a Home Assistant
// notification by agent.ts — before this, every one of these states was only
// visible in the add-on log, which nobody on site reads (2026-09-30: an
// install sat waiting for consent until its link expired, and looked like a
// network problem from the outside).
export type EnrollStatus =
  | { kind: 'waiting_consent' }
  | { kind: 'unreachable'; error: string }
  | { kind: 'invalid'; httpStatus: number };

export interface EnrollDeps extends EnrollLogger {
  fetchFn: typeof fetch;
  sleepFn: (ms: number) => Promise<void>;
  onStatus?: (status: EnrollStatus) => void;
  random?: () => number;
}

// How long to park after a terminal 404/410 before checking again. The token
// can't become valid by itself (changing it in the add-on config restarts the
// add-on anyway), so this is only a slow heartbeat — the point is to stay
// running with a clear notification instead of exiting into a "stopped"
// add-on that tells the installer nothing.
export const INVALID_TOKEN_RECHECK_MS = 30 * 60 * 1000;

// Report "can't reach Tinta" only after this many consecutive network
// failures, so a single blip during boot doesn't flash a scary notification.
const UNREACHABLE_NOTICE_AFTER = 3;

// Installers paste whatever they were sent — often the whole install URL
// (https://app.tinta-lab.de/install/<uuid>) or the code with stray spaces.
// The backend only knows the bare UUID; anything else is a guaranteed 404.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function normalizeInstallToken(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(UUID_RE);
  return m ? m[0].toLowerCase() : trimmed;
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
  const { fetchFn, sleepFn, log, warn, error, onStatus, random } = deps;
  installToken = normalizeInstallToken(installToken);
  let attempt = 0;
  let networkFailures = 0;
  let consentNoticeShown = false;
  log('[Tinta Agent] Enrolling via install token...');

  for (;;) {
    let res: Response;
    try {
      res = await fetchFn(`${coreBase}/install/${installToken}`);
    } catch (e: any) {
      // Network error (Core unreachable, DNS, etc.) — transient, same
      // backoff as everything else that isn't a terminal token state.
      networkFailures++;
      if (networkFailures === UNREACHABLE_NOTICE_AFTER) {
        onStatus?.({ kind: 'unreachable', error: e.message });
      }
      const waitMs = enrollBackoffMs(attempt++, random);
      warn(`[Tinta Agent] Enrollment request failed (${e.message}) — retrying in ${Math.round(waitMs / 1000)}s`);
      await sleepFn(waitMs);
      continue;
    }
    networkFailures = 0;

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
      // Terminal for this token: never valid, already consumed by a previous
      // successful enrollment, or expired. Retrying can't fix it — a human
      // has to enter a fresh code. Stay alive and say so (see
      // INVALID_TOKEN_RECHECK_MS) rather than exiting.
      const body = await res.text().catch(() => '');
      error(`[Tinta Agent] Install token is invalid or expired (HTTP ${res.status}: ${body}). Enter a new install code in the add-on configuration.`);
      onStatus?.({ kind: 'invalid', httpStatus: res.status });
      await sleepFn(INVALID_TOKEN_RECHECK_MS);
      continue;
    }

    if (res.status === 403) {
      // WAITING_FOR_CONSENT: the backend deliberately withholds config
      // until POST /install/:token/consent has succeeded (§ 356 BGB — see
      // ProvisioningService.getInstallConfig). This is not an error, just a
      // normal wait for a human to read and accept the consent screen in
      // their browser — log it plainly so it doesn't look like a fault,
      // and back off on the same safe schedule as everything else.
      if (!consentNoticeShown) { consentNoticeShown = true; onStatus?.({ kind: 'waiting_consent' }); }
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
