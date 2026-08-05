FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8090 \
    DATA_FILE=/data/state.json \
    RUN_LARK_CONSUMER=false

COPY package.json tsconfig.json README.md ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/feishu-bp-agent-entrypoint

RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /data \
    && chown -R app:app /app /data \
    && chmod +x /usr/local/bin/feishu-bp-agent-entrypoint

USER app

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8090/healthz || exit 1

ENTRYPOINT ["feishu-bp-agent-entrypoint"]
