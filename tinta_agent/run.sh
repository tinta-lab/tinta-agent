#!/usr/bin/with-contenv bashio

bashio::log.info "Starting Tinta Agent..."

# Tinta Lab config
export TINTA_CLIENT_ID=$(bashio::config 'tinta_client_id')
export TINTA_AGENT_TOKEN=$(bashio::config 'tinta_agent_token')
export TINTA_CORE_WS=$(bashio::config 'tinta_core_ws')
export TINTA_EXTERNAL_URL=$(bashio::config 'tinta_external_url' '')
export LOG_LEVEL=$(bashio::config 'log_level' 'info')

# Home Assistant connection — fixed inside Supervisor
export HA_HOST="homeassistant"
export HA_PORT="8123"
# SUPERVISOR_TOKEN is injected automatically by HA Supervisor

bashio::log.info "Client: ${TINTA_CLIENT_ID}"
bashio::log.info "Core:   ${TINTA_CORE_WS}"
bashio::log.info "Ext:    ${TINTA_EXTERNAL_URL}"

exec node /app/dist/agent.js
