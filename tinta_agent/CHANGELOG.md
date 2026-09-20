# Changelog

## 2026.9.1
- Feature: агент теперь сам управляет своим Cloudflare Tunnel (`src/cloudflared-tunnel.ts`), используя токен, который Tinta Core уже возвращает при enroll/register. Отдельный add-on Cloudflared или ручная вставка tunnel token клиенту больше не нужны; токен переподтверждается при каждом успешном register, поэтому агенты, установленные до этой версии, или туннели, пересозданные на стороне сервера, донастраиваются автоматически.
- Security: пост-сессионный аудит HA (`src/ha-security-audit.ts`) — при каждой support-сессии агент снимает снимок состояния аутентификации HA сразу после выдачи доступа и ещё раз перед отзывом, сравнивает их (новые admin-пользователи, новые входы, изменённые учётные данные), автоматически удаляет любого обнаруженного нового admin-пользователя и сообщает о каждой находке в Tinta Core событием `security_alert`.
- Security: `cloudflared` теперь закреплён на конкретный релиз (2026.9.1) с SHA-256 для каждой архитектуры, вместо `releases/latest/download/...` — этот бинарник получает полный контроль над сетевым туннелем агента, поэтому нефиксированная загрузка "latest" была реальным риском цепочки поставок.
- **Fix (важно): каждая multi-arch сборка минимум с 2026.8.1 публиковала под тегами `linux/arm64` и `linux/arm/v7` фактически amd64-содержимое** — базовый образ Home Assistant всегда выбирался как `amd64-base` независимо от целевой платформы. Любая установка этого add-on на ARM-оборудовании не могла запуститься. Исправлено: каждая архитектура теперь собирается из явно закреплённого по платформе базового образа (`amd64-base`/`aarch64-base`/`armv7-base`), выбираемого автоматически через BuildKit.
- Fix: `config.yaml` больше не показывает `tinta_client_id`/`tinta_agent_token` как поля для заполнения — они самостоятельно заполняются агентом при первом enroll через install-токен и сохраняются в `/data`; показ их как пустых обязательных полей только запутывал при установке.

## 2026.8.3
- Security: `tinta-support` HA user reverted to `system-admin` (from the `system-users` change in 2026.8.1). Home Assistant enforces `require_admin` at the backend for editing automations/integrations, restarting HA, and Supervisor/add-on operations — `system-users` blocked support staff from actually fixing anything, not just from a UI panel. Client owner accepted the tradeoff; the account remains short-lived (deleted on revoke/TTL expiry) with a fresh password every grant, and every session is logged in AccessLog.
- Fix: clean up every duplicate orphaned `tinta-support` user left behind by failed grant cycles, not just the most recent one.

## 2026.8.1
- Security: `tinta-support` HA user now created with `system-users` role (was `system-admin`). Support staff can control devices but cannot access HA admin panel, user management or Supervisor.
- Security: `buildHACommand` now throws on unknown entity types instead of forwarding arbitrary HA service calls.
- Security: local TTL timer — agent auto-revokes `tinta-support` user when access expires, even if backend is offline.

## 2026.4.15
- Баннер в HA показывает имя сотрудника поддержки и время истечения доступа
- Время истечения доступа отображается клиенту в реальном времени

## 2026.4.14
- Fix: агент больше не пересылает состояния сенсоров/бинарных сенсоров в Tinta Core (только управляемые сущности)

## 2026.4.13
- Fix: синхронизация toggle состояния при подключении к Core (а не до)
- Docker-образ пересобран

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
