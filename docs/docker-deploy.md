# Docker Deployment

The image is intended for manual builds and manual instance creation. It requires PostgreSQL, runs pending migrations before startup, and runs as an unprivileged user on a read-only filesystem.

## 1. Prepare secrets

```bash
cp .env.example .env
vi .env
```

Replace every `change_me` / `replace_with` value. At minimum configure:

```dotenv
DATABASE_URL=postgresql://feishu_bp_agent:url_safe_password@database-host:5432/feishu_bp_agent
ADMIN_API_KEY=a_random_value_with_at_least_24_characters
INGRESS_API_KEY=a_different_random_value_with_24_characters
CONFIRMATION_SECRET=a_random_value_with_at_least_32_characters
OWNER_OPEN_ID=ou_your_open_id
BOT_OPEN_ID=ou_your_bot_open_id
```

Use URL-safe alphanumeric database passwords in Compose, or percent-encode reserved URI characters in `DATABASE_URL`. Production startup rejects missing values and example placeholders.

## 2. Build and run against an existing PostgreSQL

```bash
docker build --pull -t feishu-bp-agent:0.2.0 .
docker run -d \
  --name feishu-bp-agent \
  --restart unless-stopped \
  --env-file .env \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -p 127.0.0.1:8090:8090 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --read-only \
  --tmpfs /tmp \
  feishu-bp-agent:0.2.0
```

`DATABASE_URL` must be reachable from inside the container; `127.0.0.1` points to the container itself.

## 3. Compose with PostgreSQL

Set `POSTGRES_PASSWORD` in `.env` to a URL-safe alphanumeric value. Compose creates a private PostgreSQL service and persistent volume, waits for database health, then migrates and starts the agent.

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f feishu-bp-agent
```

Back up `feishu-bp-agent-postgres` using standard PostgreSQL backup tooling. Do not treat a container image or volume snapshot taken during writes as the only database backup.

## 4. Verify

```bash
curl http://127.0.0.1:8090/healthz
curl http://127.0.0.1:8090/api/requirements \
  -H "authorization: Bearer $ADMIN_API_KEY"
```

Only `/healthz` is public. Place the service behind TLS and restrict `/api/messages` to the trusted event forwarder even though it also requires `INGRESS_API_KEY`.

## Lark event modes

The image intentionally does not bundle `lark-cli` or a personal Keychain session. The core container accepts normalized events at `POST /api/messages`.

For the current CLI event mode, run `lark-cli event consume` in a controlled host process or sidecar and forward normalized events with `INGRESS_API_KEY`. If `RUN_LARK_CONSUMER=true` is set on the core image without installing `LARK_CLI_BIN`, the entrypoint fails immediately.

Feishu Base sync is different: it runs inside the service through application credentials and direct OpenAPI. See [feishu-base-sync.md](feishu-base-sync.md).
