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

async function findSupportUser(haClient: HAWebSocketClient): Promise<any | null> {
  const users = await haClient.sendCommand<any[]>({ type: 'config/auth/list' });
  return users.find(u => u.name === SUPPORT_NAME && !u.system_generated) ?? null;
}

export async function getSupportUserId(haClient: HAWebSocketClient): Promise<string | null> {
  try {
    const user = await findSupportUser(haClient);
    return user?.id ?? null;
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
  _password: string,
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
      // Delete existing user first (clean slate — avoids stale credentials)
      const existing = await findSupportUser(haClient);
      if (existing) {
        await haClient.sendCommand({ type: 'config/auth/delete', user_id: existing.id });
        log('Old user deleted ✓');
      }

      // Create fresh user
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
      // Delete user entirely — immediately invalidates all active sessions
      const user = await findSupportUser(haClient);
      if (user) {
        await haClient.sendCommand({ type: 'config/auth/delete', user_id: user.id });
        log(`"${SUPPORT_NAME}" DELETED — all sessions invalidated ✓`);
      } else {
        log(`"${SUPPORT_NAME}" not found — nothing to revoke`);
      }
    }
  } catch (err: any) {
    log(`Warning: ${err.message}`);
  }
}
