# feishu-bp-agent

飞书 BP 需求收集与工作进度播报智能体 MVP。

当前版本包含：

- 多轮需求澄清：需求草稿 -> 补充信息 -> 用户确认 -> 正式需求
- 可选的 OpenAI-compatible 语义理解，异常或关闭时自动使用规则引擎
- “我的需求”和“当前工作”查询
- HTTP 测试入口，便于后续接入飞书 Base
- `lark-cli event consume` 消息监听与机器人回复适配
- 独立 `lark-cli` 消息网关：持久化事件、失败重试、崩溃重放、幂等回复和健康检查
- PostgreSQL 生产存储，以及本地 JSON 开发后备
- 管理端/消息入口独立 API Key、飞书租户/用户/群聊白名单
- 消息幂等、跨实例会话锁、高风险管理操作二次确认
- JSON 结构化日志与敏感字段脱敏
- PostgreSQL outbox 驱动的飞书 Base 可靠同步

## Run

Node.js 22.6+ is required for native TypeScript stripping.

```bash
cp .env.example .env
vi .env
set -a
. ./.env
set +a
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

真实飞书监听由 `feishu-bp-forwarder` 容器负责，核心容器保持 `RUN_LARK_CONSUMER=false`。执行 `docker compose up -d --build` 会启动 PostgreSQL、核心服务和消息网关；网关通过 CLI 长连接收消息，调用核心 `/api/messages`，再以 Bot 身份回复。完整权限、验证和排障步骤参见 [docs/lark-message-gateway.md](docs/lark-message-gateway.md)。

配置 `DATABASE_URL` 后服务自动使用 PostgreSQL；不配置时才使用 `DATA_FILE`。首次启动 PostgreSQL 环境前必须运行 `npm run migrate`。

Docker 手动构建与实例创建参见 [docs/docker-deploy.md](docs/docker-deploy.md)，PM2/systemd 参见 [docs/process-manager-deploy.md](docs/process-manager-deploy.md)。容器内通过 `HOST=0.0.0.0` 对宿主机暴露服务；本地开发默认只监听 `127.0.0.1`。消息网关只允许单实例运行，核心 HTTP 服务仍可水平扩容。

飞书 Base 同步使用应用身份直连 OpenAPI，不依赖个人 `lark-cli` 登录态。Base 字段、权限和环境变量参见 [docs/feishu-base-sync.md](docs/feishu-base-sync.md)。

启用语义理解时设置 `LLM_ENABLED=true`，并配置 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL`。服务调用兼容的 `/chat/completions` 接口，只接受经过校验的意图和需求字段；模型无法直接写数据库或操作飞书。`LLM_TIMEOUT_MS`、`LLM_MAX_RETRIES`、`LLM_MAX_INPUT_CHARS` 分别控制超时、瞬时错误重试次数和发送给模型的最大上下文。详细部署说明参见 [docs/docker-deploy.md](docs/docker-deploy.md)。

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

The agent never creates a formal requirement from an unconfirmed draft. It asks for the business goal, scope, and acceptance criteria, then waits for an explicit confirmation. LLM output is advisory structured data only; confirmation and persistence remain deterministic application logic.
