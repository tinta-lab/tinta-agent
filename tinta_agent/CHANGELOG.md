# Changelog

## 2026.4.12
- Activity log: агент отправляет журнал действий поддержки при отзыве доступа
- HA Access Toggle: клиент может управлять доступом поддержки из HA UI (`input_boolean.tinta_support_access`)
- Multi-client ecosystem: `ecosystem.config.js` поддерживает несколько клиентов через `clients/*.env`

## 2026.4.11
- Fix: пересоздание HA-пользователя при каждом grant вместо смены пароля

## 2026.4.10
- Fix: корректная активация/деактивация HA-пользователя через `auth/update`

## 2026.4.9
- Удаление HA-пользователя при отзыве доступа для немедленного завершения всех сессий

## 2026.4.8
- Ротация пароля `tinta-support` при каждом переключении доступа

## 2026.4.7
- Привязка toggle доступа поддержки к `is_active` HA-пользователя

## 2026.4.6
- Auto-create `tinta-support` HA-пользователь с аватаром при старте агента

## 2026.4.5
- Fix: корректный патчинг `trusted_proxies` (RFC1918), `external_url` через Supervisor API

## 2026.4.4
- Автоконфигурация HA для работы через Cloudflare Tunnel

## 2026.4.3
- HA Supervisor add-on: Dockerfile, run.sh, config.yaml, icon.png

## 2026.4.2
- Release channels, поддержка ARM/v7, удалённая диагностика, self-heal при потере соединения

## 2026.4.1
- Первый релиз: подключение к Tinta Core, метрики, управление сущностями, поддержка Supervisor
