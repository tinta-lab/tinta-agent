module.exports = {
  apps: [{
    name: 'tinta-agent-vigol',
    script: 'dist/agent.js',
    cwd: '/home/tinta/tinta-agent-pub/tinta_agent',
    restart_delay: 5000,
    max_restarts: 20,
    env: {
      TINTA_CLIENT_ID: '03c75151-3851-4bc3-bb5e-8a80ca55cf7c',
      TINTA_AGENT_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwM2M3NTE1MS0zODUxLTRiYzMtYmI1ZS04YTgwY2E1NWNmN2MiLCJ0eXBlIjoidGludGEtYWdlbnQiLCJpYXQiOjE3NzYzNjU0NzIsImV4cCI6MTgwNzkwMTQ3Mn0.bVnxnsxI7EiY_wzMbLLoBIZYOQc9kdPEUQkbiuQRuh0',
      TINTA_CORE_WS: 'wss://api.tinta-lab.de/tinta/ws',
      TINTA_EXTERNAL_URL: 'https://viktor-goloviznin.tinta-lab.de',
      HA_HOST: '192.168.2.206',
      HA_PORT: '8123',
      SUPERVISOR_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkY2Q5YmMwYzI3NzU0YzI5YWQ1NjNkM2JhN2E5NGFjNSIsImlhdCI6MTc3NjM2Njc2MywiZXhwIjoyMDkxNzI2NzYzfQ.XhfnHZXsLAKm38h9Wykm3B-SdqPfWbPScI_a_zUxlzI',
    },
  }],
};
