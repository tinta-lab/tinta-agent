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

async function createSupportUser(haClient: HAWebSocketClient, password: string): Promise<void> {
  const result = await haClient.sendCommand<{ user: { id: string } }>({
    type: 'config/auth/create',
    name: SUPPORT_NAME,
    group_ids: ['system-admin'],
    is_active: false, // inactive until explicitly granted
  });
  const userId = result.user.id;

  await haClient.sendCommand({
    type: 'config/auth_provider/homeassistant/create',
    user_id: userId,
    username: SUPPORT_USERNAME,
    password,
  });

  copyAvatar();

  try {
    await haClient.sendCommand({
      type: 'person/create',
      name: SUPPORT_NAME,
      user_id: userId,
      picture: AVATAR_HA_URL,
    });
    log('Person entity created ✓');
  } catch (e: any) {
    log(`Person creation skipped: ${e.message}`);
  }

  log(`Created user "${SUPPORT_USERNAME}" (inactive) ✓`);
}

// Called at startup: ensure user exists but stays INACTIVE until access is granted
export async function ensureSupportUser(
  haClient: HAWebSocketClient,
  password: string,
): Promise<void> {
  try {
    const existing = await findSupportUser(haClient);
    if (existing) {
      log(`"${SUPPORT_NAME}" already exists ✓`);
      // Keep current is_active state — managed by access grants
      return;
    }
    await createSupportUser(haClient, password);
  } catch (err: any) {
    log(`Warning: ${err.message}`);
  }
}

// Called when client opens or closes support access
export async function setSupportUserActive(
  haClient: HAWebSocketClient,
  enabled: boolean,
  password?: string,
): Promise<void> {
  try {
    if (enabled && password) {
      // Activate: ensure user exists with fresh password
      let user = await findSupportUser(haClient);

      if (!user) {
        // User was deleted on previous revoke — recreate
        await createSupportUser(haClient, password);
        user = await findSupportUser(haClient);
      }

      if (user) {
        // Activate and rotate password
        await haClient.sendCommand({
          type: 'config/auth/update',
          user_id: user.id,
          name: user.name,
          group_ids: user.group_ids,
          is_active: true,
        });
        await haClient.sendCommand({
          type: 'config/auth_provider/homeassistant/admin_change_password',
          user_id: user.id,
          password,
        });
        log(`"${SUPPORT_NAME}" ACTIVATED with fresh password ✓`);
      }
    } else {
      // Revoke: DELETE user entirely — immediately invalidates all active sessions
      const user = await findSupportUser(haClient);
      if (user) {
        await haClient.sendCommand({
          type: 'config/auth/delete',
          user_id: user.id,
        });
        log(`"${SUPPORT_NAME}" DELETED — all sessions invalidated ✓`);
      } else {
        log(`"${SUPPORT_NAME}" not found — nothing to revoke`);
      }
    }
  } catch (err: any) {
    log(`Warning: ${err.message}`);
  }
}
