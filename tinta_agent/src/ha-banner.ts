import { HAWebSocketClient } from './websocket-ha';
import { getHaLanguage, pickLang, type Lang } from './setup-notice';

const NOTIFICATION_ID = 'tinta_support_active';

const log = (m: string) => console.log(`[HA Banner] ${m}`);

// Shown to the household, so it follows HA's own UI language — these used
// to be Russian-only regardless of who lives there.
const LOCALE: Record<Lang, string> = { de: 'de-DE', en: 'en-GB', ru: 'ru-RU', it: 'it-IT' };

const TEXT = {
  openUntil: {
    de: (t: string) => `Tinta Support-Zugang ist bis ${t} geöffnet. Bisher hat sich niemand verbunden. Beenden mit dem Schalter „Tinta Support Access“.`,
    en: (t: string) => `Tinta Support access is open until ${t}. Nobody has connected yet. Turn it off with the “Tinta Support Access” switch.`,
    ru: (t: string) => `Доступ Tinta Support открыт до ${t}. Пока никто не подключился. Остановить можно переключателем «Tinta Support Access».`,
    it: (t: string) => `L'accesso Tinta Support è aperto fino alle ${t}. Nessuno si è ancora connesso. Disattivalo con l'interruttore “Tinta Support Access”.`,
  },
  open: {
    de: () => 'Tinta Support-Zugang ist geöffnet. Beenden mit dem Schalter „Tinta Support Access“.',
    en: () => 'Tinta Support access is open. Turn it off with the “Tinta Support Access” switch.',
    ru: () => 'Доступ Tinta Support открыт. Остановить можно переключателем «Tinta Support Access».',
    it: () => "L'accesso Tinta Support è aperto. Disattivalo con l'interruttore “Tinta Support Access”.",
  },
  connectedUntil: {
    de: (n: string, t: string) => `Tinta Support ist bis ${t} aktiv. Zugriff hat ${n}. Beenden mit dem Schalter „Tinta Support Access“.`,
    en: (n: string, t: string) => `Tinta Support is active until ${t}. ${n} has access. Turn it off with the “Tinta Support Access” switch.`,
    ru: (n: string, t: string) => `Tinta Support активен до ${t}. Доступ имеет ${n}. Остановить можно переключателем «Tinta Support Access».`,
    it: (n: string, t: string) => `Tinta Support è attivo fino alle ${t}. Ha accesso ${n}. Disattivalo con l'interruttore “Tinta Support Access”.`,
  },
  connected: {
    de: (n: string) => `Tinta Support ist aktiv. Zugriff hat ${n}. Beenden mit dem Schalter „Tinta Support Access“.`,
    en: (n: string) => `Tinta Support is active. ${n} has access. Turn it off with the “Tinta Support Access” switch.`,
    ru: (n: string) => `Tinta Support активен. Доступ имеет ${n}. Остановить можно переключателем «Tinta Support Access».`,
    it: (n: string) => `Tinta Support è attivo. Ha accesso ${n}. Disattivalo con l'interruttore “Tinta Support Access”.`,
  },
};

function formatTime(lang: Lang, iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(LOCALE[lang], { hour: '2-digit', minute: '2-digit' });
}

// Shown the moment a client opens support access — before anyone has connected.
export async function showAccessOpenBanner(
  haClient: HAWebSocketClient,
  expiresAt?: string,
): Promise<void> {
  const lang = pickLang(await getHaLanguage(haClient));
  const until = formatTime(lang, expiresAt);
  const message = until ? TEXT.openUntil[lang](until) : TEXT.open[lang]();
  await createOrUpdate(haClient, message);
}

// Shown once a specific support employee actually connects.
export async function showConnectedBanner(
  haClient: HAWebSocketClient,
  accessedByName: string,
  expiresAt?: string,
): Promise<void> {
  const lang = pickLang(await getHaLanguage(haClient));
  const until = formatTime(lang, expiresAt);
  const message = until
    ? TEXT.connectedUntil[lang](accessedByName, until)
    : TEXT.connected[lang](accessedByName);
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
