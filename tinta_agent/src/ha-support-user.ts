import * as fs from 'fs';
import { HAWebSocketClient } from './websocket-ha';

const SUPPORT_USERNAME = 'tinta-support';
const SUPPORT_NAME     = 'Tinta Support';
const AVATAR_SRC       = '/app/assets/tinta_support.png';
const AVATAR_WWW       = '/config/www/tinta_support.png';
const AVATAR_HA_URL    = '/local/tinta_support.png';

function copyAvatar(): void {
  try {
    if (!fs.existsSync(AVATAR_SRC)) return;
    fs.mkdirSync('/config/www', { recursive: true });
    fs.copyFileSync(AVATAR_SRC, AVATAR_WWW);
    console.log('[HA Support User] Avatar copied to /config/www/tinta_support.png');
  } catch { /* optional step */ }
}

export async function ensureSupportUser(
  haClient: HAWebSocketClient,
  password: string,
): Promise<void> {
  const log = (m: string) => console.log(`[HA Support User] ${m}`);

  try {
    // Check if credentials already exist
    const credentials = await haClient.sendCommand<any[]>({
      type: 'config/auth_provider/homeassistant/list',
    });

    if (credentials.some((c: any) => c.username === SUPPORT_USERNAME)) {
      log(`${SUPPORT_USERNAME} already exists ✓`);
      copyAvatar();
      return;
    }

    // Create auth user with admin role
    const user = await haClient.sendCommand<any>({
      type: 'config/auth/create',
      name: SUPPORT_NAME,
      group_ids: ['system-admin'],
    });

    // Link username + password
    await haClient.sendCommand({
      type: 'config/auth_provider/homeassistant/create',
      user_id: user.id,
      username: SUPPORT_USERNAME,
      password,
    });

    log(`Created user "${SUPPORT_USERNAME}" with admin role ✓`);

    // Copy avatar and create Person entity with profile picture
    copyAvatar();
    try {
      await haClient.sendCommand({
        type: 'person/create',
        name: SUPPORT_NAME,
        user_id: user.id,
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
