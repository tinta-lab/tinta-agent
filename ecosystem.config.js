module.exports = {
  apps: [{
    name: 'tinta-agent-vigol',
    script: 'dist/agent.js',
    cwd: '/home/tinta/tinta-agent-pub/tinta_agent',
    restart_delay: 5000,
    max_restarts: 20,
    env: {
      TINTA_CLIENT_ID: '03c75151-3851-4bc3-bb5e-8a80ca55cf7c',
      TINTA_AGENT_TOKEN: '<TINTA_AGENT_TOKEN_REDACTED>',
      TINTA_CORE_WS: 'wss://api.tinta-lab.de/tinta/ws',
      HA_HOST: '192.168.2.206',
      HA_PORT: '8123',
      SUPERVISOR_TOKEN: '<SUPERVISOR_TOKEN_REDACTED>',
    },
  }],
};
