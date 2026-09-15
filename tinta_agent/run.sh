#!/usr/bin/with-contenv bashio

bashio::log.info "Starting Tinta Agent..."

# Tinta Lab config — client_id/agent_token are deliberately not add-on
# options: the agent self-enrolls with tinta_install_token on first start and
# persists the result to /data/tinta_credentials.json (see loadOrEnroll() in
# src/agent.ts). Same for the tunnel token — handed back by Core on
# enroll/register, never entered here.
export TINTA_INSTALL_TOKEN=$(bashio::config 'tinta_install_token' '')
export TINTA_CORE_WS=$(bashio::config 'tinta_core_ws' 'wss://api.tinta-lab.de/tinta/ws')
export TINTA_EXTERNAL_URL=$(bashio::config 'tinta_external_url' '')

# Home Assistant connection — fixed inside Supervisor
export HA_HOST="homeassistant"
export HA_PORT="8123"
# SUPERVISOR_TOKEN is injected automatically by HA Supervisor

if [ -n "${TINTA_INSTALL_TOKEN}" ]; then
  bashio::log.info "Install token provided — will self-enroll on first start"
else
  bashio::log.info "No install token — using credentials persisted from a previous enroll (if any)"
fi
bashio::log.info "Core:   ${TINTA_CORE_WS}"
bashio::log.info "Ext:    ${TINTA_EXTERNAL_URL}"

exec node /app/dist/agent.js
