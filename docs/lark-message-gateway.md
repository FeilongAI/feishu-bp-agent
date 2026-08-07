# Lark CLI Message Gateway

`feishu-bp-forwarder` provides the production message path:

```text
Feishu message
  -> lark-cli event consume im.message.receive_v1
  -> permission-restricted local spool
  -> POST /api/messages with INGRESS_API_KEY
  -> requirement conversation and PostgreSQL
  -> lark-cli im +messages-reply
```

The forwarder writes each normalized message to its spool before calling the core agent. It removes the file only after both core processing and Bot reply succeed. A restart replays remaining files. Core message idempotency prevents duplicate requirements, while the stable CLI idempotency key prevents duplicate replies.

## 1. Feishu application setup

Enable the Bot capability, add event `im.message.receive_v1`, and publish the application version. Grant these Bot permissions:

```text
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message:send_as_bot
```

The group permission name can vary slightly in the developer console. For the default `GROUP_REQUIRE_MENTION=true` behavior, choose the permission that allows receiving group messages that explicitly mention the Bot. Do not grant all group-message access unless the business requires it.

Set the application's availability range to the people who may use the agent. To allow any employee in the tenant, make the application available to the whole tenant. The Bot must be added to each group where it should respond.

## 2. Server configuration

Set these values in the server `.env`:

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=server_side_secret
BOT_OPEN_ID=ou_bot_xxx
INGRESS_API_KEY=a_unique_random_value_with_at_least_24_characters
RUN_LARK_CONSUMER=false
LARK_EVENT_KEY=im.message.receive_v1
```

Leave `ALLOWED_USER_IDS`, `ALLOWED_CHAT_IDS`, and `ALLOWED_TENANT_KEYS` empty to avoid restricting those dimensions. Group messages still require `@Bot` by default. Never commit `.env` or print `FEISHU_APP_SECRET` and `INGRESS_API_KEY` in logs.

## 3. Docker deployment

Build and start the entire stack:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
```

The forwarder image pins the official `@larksuite/cli` version through `LARK_CLI_VERSION`. Its entrypoint initializes the CLI from `FEISHU_APP_ID` and secret stdin. CLI state and undelivered messages live in separate named volumes.

Verify both services:

```bash
curl http://127.0.0.1:8090/healthz
docker exec feishu-bp-forwarder wget -qO- http://127.0.0.1:8091/healthz
docker compose logs --tail=100 feishu-bp-forwarder
```

Healthy forwarder output contains:

```text
lark_consumer_ready
```

The health response must have `ok:true`, `ready:true`, and normally `pending:0`. A positive `pending` value means messages are safely spooled but core processing or Bot reply is still failing.

## 4. End-to-end verification

1. Send the Bot a P2P message such as `你好`.
2. Confirm the Bot replies with its capabilities.
3. Send `我想做一个 Meta 消耗看板` and complete the clarification flow.
4. Send `确认提交` and verify a new requirement appears in PostgreSQL/Base.
5. Add the Bot to a test group, send `@Bot 我的需求`, and verify it replies only when mentioned.
6. Send the same normalized `message_id` twice through the ingress test and verify only one requirement/reply is created.

## 5. Reliability and scaling

- Run exactly one forwarder for an application profile. `lark-cli` permits one active event-bus connection and duplicate consumers can cause conflicts.
- The core service may have multiple HTTP replicas because PostgreSQL advisory locks and processed-message records provide cross-instance consistency.
- The spool volume contains message text. Protect it with host access controls and include it in the same data-handling policy as PostgreSQL.
- Delivery retries use exponential backoff. Failed entries remain on disk and are retried periodically and after restart.
- Graceful shutdown closes CLI stdin or sends SIGTERM. Do not use `kill -9`, because it can bypass event subscription cleanup.

## 6. Troubleshooting

No `lark_consumer_ready`:

```bash
docker compose logs --tail=200 feishu-bp-forwarder
docker compose restart feishu-bp-forwarder
```

Check App ID/secret, application publication, network access to Feishu, and the event subscription. The entrypoint rejects missing/example secrets.

Ready but no events: verify `im.message.receive_v1`, receive-message scopes, application availability, Bot group membership, and explicit group mention.

Events arrive but there is no reply: inspect `pending` and both service logs. HTTP `401` usually means the forwarder's `INGRESS_API_KEY` does not match the core. A reply permission error usually means `im:message:send_as_bot` is missing or the Bot cannot access that chat.

Pending files remain after fixing configuration:

```bash
docker compose restart feishu-bp-forwarder
docker exec feishu-bp-forwarder wget -qO- http://127.0.0.1:8091/healthz
```

Do not delete the forwarder state volume while `pending` is positive unless you explicitly accept losing those messages.
