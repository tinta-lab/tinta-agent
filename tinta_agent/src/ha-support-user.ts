import * as fs from 'fs';
import { HAWebSocketClient } from './websocket-ha';

const SUPPORT_USERNAME = 'tinta-support';
const SUPPORT_NAME     = 'Tinta Support';
const AVATAR_SRC       = '/app/assets/tinta_support.png';
const AVATAR_WWW       = '/config/www/tinta_support.png';
const AVATAR_HA_URL    = '/local/tinta_support.png';

const log = (m: string) => console.log(`[HA Support User] ${m}`);

function copyAvatar(): void {
  try {
    if (!fs.existsSync(AVATAR_SRC)) return;
    fs.mkdirSync('/config/www', { recursive: true });
    fs.copyFileSync(AVATAR_SRC, AVATAR_WWW);
    log('Avatar copied ✓');
  } catch { /* optional */ }
}

// Returns every matching user, not just one — repeated failed grant cycles
// (e.g. the username_already_exists bug fixed alongside this) each left
// behind an orphan "Tinta Support" user with no credential attached, and a
// single .find() only ever cleaned up the most recent one.
async function findSupportUsers(haClient: HAWebSocketClient): Promise<any[]> {
  const users = await haClient.sendCommand<any[]>({ type: 'config/auth/list' });
  return users.filter(u => u.name === SUPPORT_NAME && !u.system_generated);
}

export async function getSupportUserId(haClient: HAWebSocketClient): Promise<string | null> {
  try {
    const users = await findSupportUsers(haClient);
    return users[0]?.id ?? null;
  } catch { return null; }
}

async function ensurePersonLinked(haClient: HAWebSocketClient, userId: string): Promise<void> {
  try {
    const result = await haClient.sendCommand<any>({ type: 'person/list' });
    // HA returns { storage: [...], config: [...] } or just an array
    const all: any[] = result?.storage ?? result?.persons ?? (Array.isArray(result) ? result : []);
    const existing = all.find((p: any) => p.name === SUPPORT_NAME);

    if (existing) {
      await haClient.sendCommand({
        type: 'person/update',
        person_id: existing.id,
        name: SUPPORT_NAME,
        user_id: userId,
        picture: AVATAR_HA_URL,
        device_trackers: existing.device_trackers ?? [],
      });
      log('Person entity re-linked ✓');
    } else {
      await haClient.sendCommand({
        type: 'person/create',
        name: SUPPORT_NAME,
        user_id: userId,
        picture: AVATAR_HA_URL,
      });
      log('Person entity created ✓');
    }
  } catch (e: any) {
    log(`Person entity: ${e.message}`);
  }
}

// Called at agent startup — just copy avatar; user lifecycle is managed per access cycle
export async function ensureSupportUser(
  haClient: HAWebSocketClient,
): Promise<void> {
  copyAvatar();
  log('Ready ✓');
}

// Called when client opens or closes support access
export async function setSupportUserActive(
  haClient: HAWebSocketClient,
  enabled: boolean,
  password?: string,
): Promise<void> {
  try {
    if (enabled && password) {
      // Delete existing user(s) first (clean slate — avoids stale credentials
      // and any duplicates left over from earlier failed cycles)
      const existing = await findSupportUsers(haClient);
      for (const u of existing) {
        await haClient.sendCommand({ type: 'config/auth/delete', user_id: u.id });
      }
      if (existing.length) log(`Old user(s) deleted (${existing.length}) ✓`);

      // `config/auth/delete` removes the User but does NOT free the
      // username/password credential in the homeassistant auth provider's own
      // storage — reproduced live: after deleting the user above, re-creating
      // the credential still failed with "username_already_exists" because
      // the old credential record was left orphaned. Free the username
      // explicitly before recreating it; harmless (and expected to throw,
      // hence the catch) when no such credential exists yet.
      try {
        await haClient.sendCommand({
          type: 'config/auth_provider/homeassistant/delete',
          username: SUPPORT_USERNAME,
        });
        log('Orphaned credential cleared ✓');
      } catch { /* no existing credential for this username — nothing to clean up */ }

      // Create fresh user. Deliberately system-admin, not system-users: support
      // needs to actually fix things (edit automations/integrations, restart
      // add-ons), not just view dashboards. Tradeoff accepted by the client
      // owner — the account is short-lived (deleted on revoke/TTL expiry) and
      // every session is logged in AccessLog with a fresh password each time.
      const result = await haClient.sendCommand<{ user: { id: string } }>({
        type: 'config/auth/create',
        name: SUPPORT_NAME,
        group_ids: ['system-admin'],
      });
      const userId = result.user.id;

      // Link username + access-specific password
      await haClient.sendCommand({
        type: 'config/auth_provider/homeassistant/create',
        user_id: userId,
        username: SUPPORT_USERNAME,
        password,
      });

      // Ensure person entity exists and is linked to new user
      await ensurePersonLinked(haClient, userId);

      log(`"${SUPPORT_NAME}" ACTIVATED with fresh credentials ✓`);
    } else {
      // Delete user(s) entirely — immediately invalidates all active sessions
      const users = await findSupportUsers(haClient);
      if (users.length) {
        for (const u of users) {
          await haClient.sendCommand({ type: 'config/auth/delete', user_id: u.id });
        }
        log(`"${SUPPORT_NAME}" DELETED (${users.length}) — all sessions invalidated ✓`);
      } else {
        log(`"${SUPPORT_NAME}" not found — nothing to revoke`);
      }
    }
  } catch (err: any) {
    log(`Warning: ${err.message}`);
  }
}
