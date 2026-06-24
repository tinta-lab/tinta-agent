/**
 * PM2 конфигурация агентов Tinta Lab
 *
 * Добавление нового клиента:
 *   1. cp clients/.env.example clients/SUBDOMAIN.env
 *   2. Заполнить TINTA_CLIENT_ID, TINTA_AGENT_TOKEN, HA_HOST, SUPERVISOR_TOKEN
 *   3. Добавить строку  app('SUBDOMAIN')  в список ниже
 *   4. pm2 start ecosystem.config.js --only tinta-agent-SUBDOMAIN
 *   5. pm2 save
 */

const path = require('path');
const fs   = require('fs');

/** Загружает clients/SUBDOMAIN.env → объект { KEY: 'value' } */
function loadClient(subdomain) {
  const file = path.join(__dirname, 'clients', `${subdomain}.env`);
  if (!fs.existsSync(file)) throw new Error(`Файл клиента не найден: ${file}`);
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}

function app(subdomain) {
  return {
    name:          `tinta-agent-${subdomain}`,
    script:        'dist/agent.js',
    cwd:           '/home/tinta/tinta-agent-pub/tinta_agent',
    restart_delay: 5000,
    max_restarts:  20,
    env:           loadClient(subdomain),
  };
}

// ─── Список клиентов ──────────────────────────────────────────────────────────
// Каждый клиент = одна строка app('SUBDOMAIN')
// Настройки клиента → clients/SUBDOMAIN.env
module.exports = {
  apps: [
    app('vigol'),
    // app('mueller'),  ← добавить после: cp clients/.env.example clients/mueller.env
    // app('schmidt'),
  ],
};
