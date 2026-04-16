ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.19
FROM $BUILD_FROM

# Install Node.js 20
RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

COPY run.sh /
RUN chmod a+x /run.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["/run.sh"]
