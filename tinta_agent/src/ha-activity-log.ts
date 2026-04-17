import * as http from 'http';

interface LogbookEntry {
  when: string;
  name?: string;
  message?: string;
  entity_id?: string;
  context_user_id?: string;
  domain?: string;
}

const DOMAIN_LABELS: Record<string, string> = {
  light:               'Свет',
  switch:              'Выключатель',
  automation:          'Автоматизация',
  script:              'Скрипт',
  climate:             'Климат',
  cover:               'Шторы/жалюзи',
  lock:                'Замок',
  media_player:        'Медиаплеер',
  sensor:              'Датчик',
  binary_sensor:       'Датчик',
  input_boolean:       'Переключатель',
  input_number:        'Настройка',
  input_select:        'Список',
  scene:               'Сцена',
  fan:                 'Вентилятор',
  vacuum:              'Пылесос',
  alarm_control_panel: 'Охранная система',
};

const MESSAGE_RU: [RegExp, string][] = [
  [/turned on/i,          'включён'],
  [/turned off/i,         'выключен'],
  [/triggered/i,          'запущена'],
  [/locked/i,             'заблокирован'],
  [/unlocked/i,           'разблокирован'],
  [/opened/i,             'открыто'],
  [/closed/i,             'закрыто'],
  [/started/i,            'запущено'],
  [/paused/i,             'на паузе'],
  [/resumed/i,            'продолжено'],
  [/stopped/i,            'остановлено'],
  [/armed away/i,         'охрана: режим "вне дома"'],
  [/armed home/i,         'охрана: режим "дома"'],
  [/armed/i,              'поставлено на охрану'],
  [/disarmed/i,           'снято с охраны'],
  [/changed to (.+)/i,    'изменено → $1'],
  [/changed/i,            'изменено'],
  [/reloaded/i,           'перезагружено'],
  [/edited/i,             'отредактировано'],
  [/created/i,            'создано'],
  [/deleted/i,            'удалено'],
];

function translateMessage(msg: string): string {
  if (!msg) return 'изменено';
  for (const [re, ru] of MESSAGE_RU) {
    const m = msg.match(re);
    if (m) return ru.replace('$1', m[1] ?? '');
  }
  return msg;
}

function formatEntry(e: LogbookEntry): string | null {
  if (!e.name && !e.entity_id) return null;
  const domain = e.domain ?? e.entity_id?.split('.')[0] ?? '';
  const domainLabel = DOMAIN_LABELS[domain] ?? '';
  const name = e.name ?? e.entity_id ?? '';
  const action = translateMessage(e.message ?? '');
  const time = new Date(e.when).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  return domainLabel
    ? `${time} · ${domainLabel} «${name}»: ${action}`
    : `${time} · «${name}»: ${action}`;
}

export async function fetchSupportActivityLog(config: {
  host: string;
  port: number;
  token: string;
  supervisorProxy: boolean;
  supportUserId: string;
  from: string;
}): Promise<string[]> {
  const { host, port, token, supervisorProxy, supportUserId, from } = config;
  const to = new Date().toISOString();
  const prefix = supervisorProxy ? '/core' : '';
  const path = `${prefix}/api/logbook/${encodeURIComponent(from)}?end_time=${encodeURIComponent(to)}`;

  return new Promise(resolve => {
    const req = http.get(
      { host, port, path, headers: { Authorization: `Bearer ${token}` } },
      res => {
        let body = '';
        res.on('data', d => (body += d));
        res.on('end', () => {
          try {
            const entries: LogbookEntry[] = JSON.parse(body);
            if (!Array.isArray(entries)) { resolve([]); return; }
            const logs = entries
              .filter(e => e.context_user_id === supportUserId)
              .map(formatEntry)
              .filter((s): s is string => s !== null);
            resolve(logs);
          } catch { resolve([]); }
        });
      },
    );
    req.on('error', () => resolve([]));
    req.setTimeout(15_000, () => { req.destroy(); resolve([]); });
  });
}
