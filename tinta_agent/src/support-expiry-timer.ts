import { HAWebSocketClient } from './websocket-ha';
import { setSupportUserActive } from './ha-support-user';
import { dismissBanner } from './ha-banner';
import { setAccessToggle } from './ha-access-toggle';

export interface SupportExpiryDeps {
  haClient: HAWebSocketClient;
  getToggleKnownState: () => 'on' | 'off' | null;
  setToggleKnownState: (state: 'on' | 'off' | null) => void;
  log: (...args: any[]) => void;
}

// Local TTL guard: auto-revokes support access if backend goes offline before
// expiry. Extracted from agent.ts (P2.2) so support-expiry-timer.test.ts
// exercises this exact function, not a hand-copied reimplementation of it.
export function createSupportExpiryTimer(deps: SupportExpiryDeps) {
  let timer: NodeJS.Timeout | null = null;

  function clear() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function schedule(expiresAt: string) {
    clear();
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return;
    timer = setTimeout(async () => {
      deps.log('Support access TTL expired locally — revoking');
      if (!deps.haClient.isConnected()) return;
      await setSupportUserActive(deps.haClient, false);
      await dismissBanner(deps.haClient);
      if (deps.getToggleKnownState() !== 'off') {
        deps.setToggleKnownState('off');
        await setAccessToggle(deps.haClient, false);
      }
    }, ms);
  }

  return { schedule, clear };
}
