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
LLM_TIMEOUT_MS=8000
LLM_MAX_RETRIES=1
LLM_MAX_INPUT_CHARS=6000
LLM_AGENT_ENABLED=true
```

The provider must implement `POST /chat/completions` and JSON object response mode. Keep `LLM_API_KEY` only in the server environment. Requirement messages and a bounded amount of recent conversation context are sent to this provider, so choose the provider and data-retention policy according to your privacy requirements. If the provider times out, returns an error, or returns malformed data, the service continues with the built-in deterministic rules.

When agent mode is enabled, the model owns the conversation loop. It receives the current message, recent context, and draft, then decides whether to ask a question or call `save_requirement_draft`, `submit_requirement`, the allowlisted BP query tools, or an MCP tool. The service executes tools and sends results back to the model. It does not expose arbitrary shell commands or Feishu API paths to the model. Requirement submission, Base field deletion, MCP mutation confirmation, permissions, idempotency, and locks remain service-side security boundaries.

## Official remote Lark MCP bridge

The preferred integration uses Feishu's official remote MCP endpoint. It dynamically lists and calls the tools allowed by the request headers; no Feishu tool schema is hard-coded in this service:

```dotenv
MCP_ENABLED=true
MCP_URL=https://mcp.feishu.cn/mcp
MCP_TAT=t-gxxxxxxxxxxxxxxxxxxxxx
MCP_ALLOWED_TOOLS=search-user,get-user,fetch-file,search-doc,create-doc,fetch-doc,update-doc,list-docs,get-comments,add-comments
MCP_TOOL_ALLOWLIST=search-user,get-user,fetch-file,search-doc,create-doc,fetch-doc,update-doc,list-docs,get-comments,add-comments
```

`MCP_TAT` uses application identity. Use `MCP_UAT` when the tools must act as a specific user. Request only the permissions required by the selected tools. The remote service currently documents cloud-document tools; field and record operations in Base are not part of this remote endpoint yet.

The two tool lists serve different boundaries: `MCP_ALLOWED_TOOLS` is sent to Feishu in `X-Lark-MCP-Allowed-Tools`, while `MCP_TOOL_ALLOWLIST` is enforced again by this service after `tools/list`. Keep both lists identical and use the exact hyphenated names from the remote MCP documentation. Read-only tools can run immediately. Tools whose names indicate a mutation (for example `create-doc` or `update-doc`) are intercepted by the service; the requester must reply `确认执行` (or `取消操作`) within 10 minutes before the remote `tools/call` is sent.

For Base or other tool domains, the repository also includes an optional local `lark-mcp` Compose profile. It runs the official `@larksuiteoapi/lark-mcp` package in streamable HTTP mode and keeps its Feishu credentials in the MCP container:

```dotenv
MCP_URL=http://lark-mcp:3000/mcp
MCP_TAT=
MCP_UAT=
MCP_ALLOWED_TOOLS=
```

```bash
docker compose --profile mcp build
docker compose --profile mcp up -d
```

The MCP profile is optional and does not participate in normal Compose interpolation. When it is enabled, set `FEISHU_APP_ID` and `FEISHU_APP_SECRET`; the MCP image validates them when it starts. The container runs as the unprivileged `app` user.

The local profile exposes only the tools named by `MCP_LARK_TOOLS`; clear `MCP_ALLOWED_TOOLS` because that header is for the official remote endpoint. The core client applies a second `MCP_TOOL_ALLOWLIST` filter. Any MCP tool whose name indicates a mutation is held for application-level confirmation before execution. The existing Base field deletion path remains protected by `OWNER_OPEN_ID` and the explicit `确认删除` confirmation.

To resolve a private-chat sender's display name from `open_id`, expose the API identifier `contact.v3.user.get` in `MCP_LARK_TOOLS`. Because the Compose MCP process uses `--tool-name-case snake`, put `contact_v3_user_get` (not the dotted API identifier) in `MCP_TOOL_ALLOWLIST` when that allowlist is set. `SENDER_NAME_MCP_TOOL=contact_v3_user_get` can pin discovery to that exact tool. The core service performs this read-only lookup before calling the model, validates that the returned `open_id` matches the sender, and caches the result with bounded size and concurrency. The Feishu app still needs `contact:user.base:readonly`, a published/approved app version, and contact visibility that includes the sender; MCP does not bypass those controls. `SENDER_NAME_CACHE_TTL_MS`, `SENDER_NAME_NEGATIVE_CACHE_TTL_MS`, `SENDER_NAME_CACHE_MAX_ENTRIES`, and `SENDER_NAME_MAX_CONCURRENT_LOOKUPS` control the cache and lookup load.

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
