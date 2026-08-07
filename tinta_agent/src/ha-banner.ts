import { HAWebSocketClient } from './websocket-ha';

const NOTIFICATION_ID = 'tinta_support_active';

const log = (m: string) => console.log(`[HA Banner] ${m}`);

function formatTime(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

// Shown the moment a client opens support access — before anyone has connected.
export async function showAccessOpenBanner(
  haClient: HAWebSocketClient,
  expiresAt?: string,
): Promise<void> {
  const until = formatTime(expiresAt);
  const message = until
    ? `Доступ Tinta Support открыт до ${until}. Пока никто не подключился. Остановить можно переключателем «Tinta Support Access».`
    : 'Доступ Tinta Support открыт. Остановить можно переключателем «Tinta Support Access».';
  await createOrUpdate(haClient, message);
}

// Shown once a specific support employee actually connects.
export async function showConnectedBanner(
  haClient: HAWebSocketClient,
  accessedByName: string,
  expiresAt?: string,
): Promise<void> {
  const until = formatTime(expiresAt);
  const message = until
    ? `Tinta Support активен до ${until}. Доступ имеет ${accessedByName}. Остановить можно переключателем «Tinta Support Access».`
    : `Tinta Support активен. Доступ имеет ${accessedByName}. Остановить можно переключателем «Tinta Support Access».`;
  await createOrUpdate(haClient, message);
}

export async function dismissBanner(haClient: HAWebSocketClient): Promise<void> {
  try {
    await haClient.callService('persistent_notification', 'dismiss', {
      notification_id: NOTIFICATION_ID,
    });
    log('Banner dismissed ✓');
  } catch (e: any) {
    log(`Warning dismissing banner: ${e.message}`);
  }
}

async function createOrUpdate(haClient: HAWebSocketClient, message: string): Promise<void> {
  try {
    // persistent_notification.create with the same notification_id replaces
    // the existing banner rather than stacking a new one.
    await haClient.callService('persistent_notification', 'create', {
      notification_id: NOTIFICATION_ID,
      title: 'Tinta Support',
      message,
    });
    log('Banner shown ✓');
  } catch (e: any) {
    log(`Warning showing banner: ${e.message}`);
  }
}
