import * as fs from 'fs';
import { HAWebSocketClient } from './websocket-ha';

const SUPPORT_USERNAME = 'tinta-support';
const SUPPORT_NAME     = 'Tinta Support';
const AVATAR_SRC       = '/app/assets/tinta_support.png';
const AVATAR_WWW       = '/config/www/tinta_support.png';
const AVATAR_HA_URL    = '/local/tinta_support.png';

export async function setSupportUserActive(
  haClient: HAWebSocketClient,
  enabled: boolean,
  password?: string,
): Promise<void> {
  const log = (m: string) => console.log(`[HA Support User] ${m}`);
  try {
    const users = await haClient.sendCommand<any[]>({ type: 'config/auth/list' });
    const supportUser = users.find(u => u.name === SUPPORT_NAME && !u.system_generated);
    if (!supportUser) {
      log(`User "${SUPPORT_NAME}" not found — run ensureSupportUser first`);
      return;
    }
    await haClient.sendCommand({
      type: 'config/auth/update',
      user_id: supportUser.id,
      name: supportUser.name,
      group_ids: supportUser.group_ids,
      is_active: enabled,
    });
    // Rotate password — set fresh one on enable, scramble on disable
    if (password) {
      try {
        await haClient.sendCommand({
          type: 'config/auth_provider/homeassistant/admin_change_password',
          user_id: supportUser.id,
          password,
        });
        log(`Password rotated ✓`);
      } catch (e: any) {
        log(`Password rotation warning: ${e.message}`);
      }
    }
    log(`User "${SUPPORT_NAME}" ${enabled ? 'ACTIVATED ✓' : 'DEACTIVATED ✓'}`);
  } catch (err: any) {
    log(`Warning: ${err.message}`);
  }
}

function copyAvatar(): void {
  try {
    if (!fs.existsSync(AVATAR_SRC)) return;
    fs.mkdirSync('/config/www', { recursive: true });
    fs.copyFileSync(AVATAR_SRC, AVATAR_WWW);
    console.log('[HA Support User] Avatar copied to /config/www/tinta_support.png');
  } catch { /* optional */ }
}

export async function ensureSupportUser(
  haClient: HAWebSocketClient,
  password: string,
): Promise<void> {
  const log = (m: string) => console.log(`[HA Support User] ${m}`);

  try {
    // config/auth/list returns array of users directly
    const users = await haClient.sendCommand<any[]>({ type: 'config/auth/list' });
    const exists = users.some(u => u.name === SUPPORT_NAME && !u.system_generated);

    if (exists) {
      log(`"${SUPPORT_NAME}" already exists ✓`);
      copyAvatar();
      return;
    }

    // config/auth/create returns { user: { id, name, ... } }
    const result = await haClient.sendCommand<{ user: { id: string } }>({
      type: 'config/auth/create',
      name: SUPPORT_NAME,
      group_ids: ['system-admin'],
    });
    const userId = result.user.id;

    // Link username + password to the new user
    await haClient.sendCommand({
      type: 'config/auth_provider/homeassistant/create',
      user_id: userId,
      username: SUPPORT_USERNAME,
      password,
    });

    log(`Created user "${SUPPORT_USERNAME}" with admin role ✓`);

    // Copy avatar to /config/www/
    copyAvatar();

    // Create Person entity with profile picture
    try {
      await haClient.sendCommand({
        type: 'person/create',
        name: SUPPORT_NAME,
        user_id: userId,
        picture: AVATAR_HA_URL,
      });
      log('Person entity created with Tinta Support avatar ✓');
    } catch (e: any) {
      log(`Person creation skipped: ${e.message}`);
    }
  } catch (err: any) {
    log(`Warning: ${err.message}`);
  }
}
