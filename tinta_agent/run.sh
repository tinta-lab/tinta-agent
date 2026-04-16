#!/usr/bin/with-contenv bashio

bashio::log.info "Starting Tinta Agent..."

# Read config options
export TINTA_CLIENT_ID=$(bashio::config 'tinta_client_id')
export TINTA_CORE_WS=$(bashio::config 'tinta_core_ws')
export TINTA_AGENT_TOKEN=$(bashio::config 'tinta_agent_token')
export LOG_LEVEL=$(bashio::config 'log_level' 'info')

# Home Assistant Supervisor token
export SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"

bashio::log.info "Client ID: ${TINTA_CLIENT_ID}"
bashio::log.info "Core WS: ${TINTA_CORE_WS}"

exec node dist/agent.js
