FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8090 \
    REQUIRE_DATABASE_URL=true \
    RUN_MIGRATIONS=true \
    RUN_LARK_CONSUMER=false

COPY package.json package-lock.json tsconfig.json README.md ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY src ./src
COPY migrations ./migrations
COPY docker-entrypoint.sh /usr/local/bin/feishu-bp-agent-entrypoint

RUN addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app \
    && chmod +x /usr/local/bin/feishu-bp-agent-entrypoint

USER app

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8090/healthz || exit 1

ENTRYPOINT ["feishu-bp-agent-entrypoint"]
