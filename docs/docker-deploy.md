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
INGRESS_EVENT_SECRET=a_different_random_value_with_at_least_32_characters
CONFIRMATION_SECRET=a_random_value_with_at_least_32_characters
OWNER_OPEN_ID=ou_your_open_id
BOT_OPEN_ID=ou_your_bot_open_id
```

Use URL-safe alphanumeric database passwords in Compose, or percent-encode reserved URI characters in `DATABASE_URL`. Production startup rejects missing values and example placeholders.

To enable semantic requirement understanding, add an OpenAI-compatible provider:

```dotenv
LLM_ENABLED=true
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=your_server_side_api_key
LLM_MODEL=your_model_name
```

The provider must implement `POST /chat/completions` and tool calling. Keep `LLM_API_KEY` only in the server environment. Requirement messages and a bounded amount of recent conversation context are sent to this provider, so choose the provider and data-retention policy according to your privacy requirements. Timeout, retry and context limits have production defaults in code and only need environment overrides for advanced tuning.

When agent mode is enabled, the model owns the conversation loop. It receives the current message, recent context, and draft, then decides whether to ask a question or call a BP tool. For Feishu operations it searches the live MCP catalog with `find_feishu_tools`, then invokes the selected tool through `call_feishu_tool`. The service executes tools and sends results back to the model. Requirement submission, Base field deletion, MCP mutation confirmation, permissions, idempotency, and locks remain service-side security boundaries.

## Official Lark MCP bridge

The bundled Compose profile runs the official `@larksuiteoapi/lark-mcp` package and exposes every API tool included in that installed version:

```dotenv
MCP_ENABLED=true
MCP_URL=http://lark-mcp:3000/mcp
```

```bash
docker compose --profile mcp build
docker compose --profile mcp up -d
```

The MCP profile uses `FEISHU_APP_ID` and `FEISHU_APP_SECRET`, registers tools in automatic token mode, and runs as the unprivileged `app` user. There is no `MCP_LARK_TOOLS`, request-header allowlist, or second core allowlist to maintain. The model sees two stable broker tools instead of receiving more than a thousand schemas in every prompt: it searches the complete catalog, then calls the exact returned tool. Read operations execute immediately; mutation tools are held for requester confirmation. The existing Base field deletion path also remains protected by `OWNER_OPEN_ID` and explicit `确认删除` confirmation. Feishu APIs that only accept user identity still require a valid user OAuth token; granting every application scope cannot turn an application token into a user token.

Private-chat name lookup automatically finds `contact_v3_user_get` in the same complete catalog. The Feishu app still needs `contact:user.base:readonly`, a published/approved app version, and contact visibility that includes the sender; MCP does not bypass Feishu's server-side permissions.

The core can also connect to a separately managed remote MCP endpoint by changing `MCP_URL` and optionally setting `MCP_TAT` or `MCP_UAT`. It accepts every tool returned by that server and does not send a client-side allowlist header.

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
In production the forwarder must also sign the exact JSON request body with `INGRESS_EVENT_SECRET`; keep the same value in the core and forwarder environments. Requests without a valid `x-ingress-signature: sha256=<hex>` are rejected before parsing.

## Lark message gateway

Compose builds a separate `feishu-bp-forwarder` image containing the pinned official `lark-cli`. The core image intentionally remains free of personal CLI/Keychain state and accepts normalized events at `POST /api/messages`.

The forwarder initializes its Bot application profile from secret stdin, maintains the long-running event consumer, persists messages before delivery, retries failures, and sends idempotent replies. Keep `RUN_LARK_CONSUMER=false` on the core service to avoid duplicate consumers. Full setup and verification are documented in [lark-message-gateway.md](lark-message-gateway.md).

Feishu Base sync is different: it runs inside the service through application credentials and direct OpenAPI. See [feishu-base-sync.md](feishu-base-sync.md).

To allow the administrator to delete Base columns from chat, set `BASE_ADMIN_ENABLED=true` and configure `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_BASE_TOKEN`, `FEISHU_BASE_TABLE_ID`, and `OWNER_OPEN_ID`. Grant the Base field read/delete scopes to the application. The agent always shows the exact field and requires `确认删除`; it never deletes the primary field or accepts this operation from another sender. Confirmation state is stored in PostgreSQL.
