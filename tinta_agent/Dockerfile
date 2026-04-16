ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.19
FROM $BUILD_FROM

# Install Node.js 20 + npm
RUN apk add --no-cache nodejs npm

WORKDIR /app

# Install ALL deps (including devDeps for tsc build)
COPY package.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

COPY run.sh /
RUN chmod a+x /run.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["/run.sh"]
