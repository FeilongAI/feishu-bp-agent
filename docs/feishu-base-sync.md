# Feishu Base Sync

Requirement changes are persisted to PostgreSQL and `bp_base_outbox` in the same transaction. A background worker leases pending rows, writes them to Feishu Base, and records the resulting `record_id` in `bp_base_sync_state`.

This gives the service these guarantees:

- Feishu downtime does not block requirement creation.
- Multiple service instances do not consume the same outbox row concurrently.
- Events for one requirement are processed in database order.
- Create retries reuse a deterministic UUIDv4 `client_token`, so an ambiguous timeout does not create a second Base record.
- Update and delete retries are idempotent; deleting an already missing record is treated as complete.

## Base preparation

Create a Base table and add the application as a document application with edit permission. In the developer console grant the minimal scopes required by the enabled workflow:

- `base:record:create`
- `base:record:update`
- `base:record:delete`

For chat-driven field administration, also grant the Base field read/delete scopes exposed by your tenant (the console may label these as field schema read and field delete). Enable it with:

```dotenv
BASE_ADMIN_ENABLED=true
FEISHU_BASE_TABLE_LABEL=需求表
```

`OWNER_OPEN_ID` is the only administrator allowlist entry. A field deletion request from any other sender is rejected. The agent first lists fields, refuses to delete the primary field, shows the exact field name and ID, and only deletes after the administrator replies `确认删除` within 10 minutes. The pending confirmation is stored in PostgreSQL, so `DATABASE_URL` is required when this feature is enabled.

The adapter uses the official `base/v3` record and field APIs with `tenant_access_token`. It does not use a developer laptop's `lark-cli` session or macOS Keychain.

The default field names and recommended field types are:

| Field | Type |
| --- | --- |
| 需求ID | Text |
| 需求标题 | Primary text |
| 业务目标、需求范围、验收标准、当前进展 | Text |
| 提出人ID、提出人、负责人ID、负责人 | Text |
| 投放平台 | Multi-select |
| 期望时间 | Text |
| 优先级、状态、可见范围 | Single-select |
| 来源会话ID | Text |
| 创建时间、更新时间 | Date/time |

Do not configure the ID fields as Feishu user/group fields. The IDs originate from incoming events, and the Base application may not have permission to resolve those identities as user field values.

## Configuration

```dotenv
BASE_SYNC_ENABLED=true
BASE_ADMIN_ENABLED=false
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=server_secret
FEISHU_BASE_TOKEN=bascn_xxx
FEISHU_BASE_TABLE_ID=tbl_xxx
FEISHU_BASE_TABLE_LABEL=需求表
FEISHU_BASE_URL=https://feishu.cn/base/bascn_xxx?table=tbl_xxx
BASE_SYNC_BATCH_SIZE=20
BASE_SYNC_POLL_MS=5000
```

To use different field names, set `FEISHU_BASE_FIELD_MAP` to a one-line JSON object. Unspecified keys keep their defaults:

```dotenv
FEISHU_BASE_FIELD_MAP={"title":"标题","status":"处理状态"}
```

Run `npm run migrate` before enabling sync. Existing pending outbox events are retained while sync is disabled and will be delivered after it is enabled.
