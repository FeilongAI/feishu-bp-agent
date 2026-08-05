# feishu-bp-agent

飞书 BP 需求收集与工作进度播报智能体 MVP。

当前版本包含：

- 多轮需求澄清：需求草稿 -> 补充信息 -> 用户确认 -> 正式需求
- “我的需求”和“当前工作”查询
- HTTP 测试入口，便于后续接入飞书 Base
- `lark-cli event consume` 消息监听与机器人回复适配
- PostgreSQL 生产存储，以及本地 JSON 开发后备
- 管理端/消息入口独立 API Key、飞书租户/用户/群聊白名单
- 消息幂等、跨实例会话锁、高风险管理操作二次确认
- JSON 结构化日志与敏感字段脱敏
- PostgreSQL outbox 驱动的飞书 Base 可靠同步

## Run

Node.js 22.6+ is required for native TypeScript stripping.

```bash
cp .env.example .env
npm run migrate
npm test
npm run dev
```

默认 HTTP 端口为 `8090`。测试消息入口：

```bash
curl -X POST http://127.0.0.1:8090/api/messages \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $INGRESS_API_KEY" \
  -d '{"chat_id":"oc_demo","sender_id":"ou_demo","message_id":"om_demo_1","content":"我想做一个 Meta 消耗看板","sender_type":"user"}'
```

真实飞书监听需要先完成应用事件订阅和 Bot 权限，然后设置 `RUN_LARK_CONSUMER=true`。生产环境必须配置 PostgreSQL，并把 Base/任务系统写入放到受控的工具适配器中。

配置 `DATABASE_URL` 后服务自动使用 PostgreSQL；不配置时才使用 `DATA_FILE`。首次启动 PostgreSQL 环境前必须运行 `npm run migrate`。

Docker 手动构建与实例创建参见 [docs/docker-deploy.md](docs/docker-deploy.md)。容器内通过 `HOST=0.0.0.0` 对宿主机暴露服务；本地开发默认只监听 `127.0.0.1`。

飞书 Base 同步使用应用身份直连 OpenAPI，不依赖个人 `lark-cli` 登录态。Base 字段、权限和环境变量参见 [docs/feishu-base-sync.md](docs/feishu-base-sync.md)。

管理接口：

```bash
curl 'http://127.0.0.1:8090/api/requirements?status=进行中' \
  -H "authorization: Bearer $ADMIN_API_KEY"
curl -X POST http://127.0.0.1:8090/api/admin/confirmations \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"action":"PATCH_REQUIREMENT","resourceId":"REQ-xxx","body":{"status":"进行中"}}'
```

签发结果中的 `token` 必须通过 `x-confirmation-token` 传给完全相同的 PATCH/DELETE 请求；令牌默认 5 分钟过期，并绑定操作人、需求 ID 和请求正文。管理查询必须携带 `ADMIN_API_KEY`，消息入口必须携带独立的 `INGRESS_API_KEY`。

群聊默认只有明确 `@` 当前机器人时才处理。生产环境应至少配置 `BOT_OPEN_ID`，并按需设置 `ALLOWED_TENANT_KEYS`、`ALLOWED_USER_IDS`、`ALLOWED_CHAT_IDS`（逗号分隔）；空白名单表示不限制该维度。

## Conversation rules

The agent never creates a formal requirement from an unconfirmed draft. It asks for the business goal, scope, and acceptance criteria, then waits for an explicit confirmation.
