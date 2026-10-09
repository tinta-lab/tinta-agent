import { HAWebSocketClient } from './websocket-ha';
import type { EnrollStatus } from './enrollment';

// Installer-facing setup status as a Home Assistant notification (the bell /
// sidebar badge), in the language the household's HA is set to. Everything
// here used to exist only in the add-on log.

const NOTIFICATION_ID = 'tinta_agent_setup';

export type SetupNotice =
  | EnrollStatus
  | { kind: 'missing_code' };

export type Lang = 'de' | 'en' | 'ru' | 'it';

const TITLE: Record<Lang, string> = {
  de: 'Tinta Agent – Einrichtung',
  en: 'Tinta Agent – setup',
  ru: 'Tinta Agent — настройка',
  it: 'Tinta Agent – configurazione',
};

function message(lang: Lang, n: SetupNotice, installUrl: string | null): string {
  const link = installUrl ? `[${installUrl}](${installUrl})` : '';
  switch (n.kind) {
    case 'waiting_consent':
      return {
        de: `Fast fertig: Bitte öffnen Sie den Installationslink und bestätigen Sie den Start der Leistung. Danach verbindet sich Tinta automatisch.\n\n${link}`,
        en: `Almost done: open the install link and confirm the service start. Tinta connects automatically afterwards.\n\n${link}`,
        ru: `Почти готово: откройте ссылку установки и подтвердите начало услуги. После этого Tinta подключится автоматически.\n\n${link}`,
        it: `Quasi fatto: apri il link di installazione e conferma l'avvio del servizio. Poi Tinta si connette automaticamente.\n\n${link}`,
      }[lang];
    case 'invalid':
      return {
        de: 'Der Installationscode ist ungültig, abgelaufen oder wurde bereits verwendet. Fordern Sie bei Tinta Lab einen neuen Code an, tragen Sie ihn unter Einstellungen → Add-ons → Tinta Agent → Konfiguration ein und starten Sie das Add-on neu.',
        en: 'The install code is invalid, expired or already used. Ask Tinta Lab for a new code, enter it under Settings → Add-ons → Tinta Agent → Configuration and restart the add-on.',
        ru: 'Код установки недействителен, истёк или уже использован. Запросите новый код у Tinta Lab, введите его в «Настройки → Дополнения → Tinta Agent → Конфигурация» и перезапустите дополнение.',
        it: "Il codice di installazione non è valido, è scaduto o è già stato usato. Richiedi un nuovo codice a Tinta Lab, inseriscilo in Impostazioni → Componenti aggiuntivi → Tinta Agent → Configurazione e riavvia l'add-on.",
      }[lang];
    case 'unreachable':
      return {
        de: `Tinta Lab ist von diesem Gerät aus nicht erreichbar (${n.error}). Prüfen Sie die Internetverbindung des Geräts. Der Agent versucht es automatisch weiter.`,
        en: `Tinta Lab can't be reached from this device (${n.error}). Check the device's internet connection. The Agent keeps retrying automatically.`,
        ru: `Сервер Tinta Lab недоступен с этого устройства (${n.error}). Проверьте подключение устройства к интернету. Агент продолжает попытки автоматически.`,
        it: `Tinta Lab non è raggiungibile da questo dispositivo (${n.error}). Controlla la connessione a internet del dispositivo. L'Agent continua a riprovare automaticamente.`,
      }[lang];
    case 'missing_code':
      return {
        de: 'Kein Installationscode eingetragen. Tragen Sie den Code von Tinta Lab unter Einstellungen → Add-ons → Tinta Agent → Konfiguration ein und starten Sie das Add-on neu.',
        en: 'No install code entered. Enter the code from Tinta Lab under Settings → Add-ons → Tinta Agent → Configuration and restart the add-on.',
        ru: 'Код установки не введён. Введите код от Tinta Lab в «Настройки → Дополнения → Tinta Agent → Конфигурация» и перезапустите дополнение.',
        it: "Nessun codice di installazione inserito. Inserisci il codice di Tinta Lab in Impostazioni → Componenti aggiuntivi → Tinta Agent → Configurazione e riavvia l'add-on.",
      }[lang];
  }
}

export function pickLang(haLanguage: string | undefined): Lang {
  const base = (haLanguage ?? '').slice(0, 2).toLowerCase();
  return (['de', 'en', 'ru', 'it'] as const).includes(base as Lang) ? (base as Lang) : 'en';
}

// Where the client confirms consent. Derived from the Core endpoint the
// Agent already talks to (api.<domain> → app.<domain>), overridable for
// non-standard deployments.
export function installPageUrl(coreBase: string, installToken: string): string {
  const app = process.env.TINTA_APP_URL ?? coreBase.replace('://api.', '://app.');
  return `${app}/install/${installToken}`;
}

export function buildSetupNotice(haLanguage: string | undefined, notice: SetupNotice, installUrl: string | null) {
  const lang = pickLang(haLanguage);
  return { notification_id: NOTIFICATION_ID, title: TITLE[lang], message: message(lang, notice, installUrl) };
}

// HA's configured UI language, cached for the process lifetime (changing it
// in HA is rare enough that the next add-on restart picking it up is fine).
let cachedHaLanguage: string | undefined;
export async function getHaLanguage(haClient: HAWebSocketClient): Promise<string> {
  if (cachedHaLanguage === undefined && haClient.isConnected()) {
    try {
      // sendCommand has no timeout of its own (see ha-configurator.ts)
      const cfg = await Promise.race([
        haClient.sendCommand<{ language?: string }>({ type: 'get_config' }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
      ]);
      cachedHaLanguage = cfg?.language ?? '';
    } catch { return ''; }
  }
  return cachedHaLanguage ?? '';
}

// Best-effort: HA may not be connected (yet), in which case the log line the
// caller already wrote is all there is.
export function createSetupNotifier(haClient: HAWebSocketClient) {
  return {
    async show(notice: SetupNotice, installUrl: string | null): Promise<void> {
      if (!haClient.isConnected()) return;
      try {
        await haClient.callService('persistent_notification', 'create',
          buildSetupNotice(await getHaLanguage(haClient), notice, installUrl));
      } catch (e: any) {
        console.warn(`[Setup Notice] Could not show notification: ${e.message}`);
      }
    },
    async clear(): Promise<void> {
      if (!haClient.isConnected()) return;
      try {
        await haClient.callService('persistent_notification', 'dismiss', { notification_id: NOTIFICATION_ID });
      } catch { /* nothing to dismiss */ }
    },
  };
}
