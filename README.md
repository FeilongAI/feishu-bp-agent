# feishu-bp-agent

飞书 BP 需求收集、排期协作与工作进度播报智能体。

当前版本包含：

- 多轮需求澄清：需求草稿 -> 补充信息 -> 用户确认 -> 正式需求
- Agent-first 多轮对话：模型理解上下文并自主选择需求、进展、Base 或 MCP 工具
- “我的需求”和“当前工作”查询
- HTTP 测试入口，便于后续接入飞书 Base
- `lark-cli event consume` 消息监听与机器人回复适配
- 独立 `lark-cli` 消息网关：持久化事件、失败重试、崩溃重放、幂等回复和健康检查
- PostgreSQL 生产存储，以及本地 JSON 开发后备
- 管理端/消息入口独立 API Key、飞书租户/用户/群聊白名单
- 消息幂等、跨实例会话锁、高风险管理操作二次确认
- JSON 结构化日志与敏感字段脱敏
- PostgreSQL outbox 驱动的飞书 Base 可靠同步
- 管理员通过聊天查询身份，并在确认后删除 Base 字段
- v2 大模型对话核心：模型负责理解意图、多轮澄清、规划和工具选择，应用不再包含关键词分类器
- 可选的飞书官方远程 MCP 桥接：按服务端返回的工具定义动态发现和调用，不在本项目逐个手写飞书工具

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

生产服务器首次部署和代码更新后的重新部署步骤参见 [docs/production-redeploy.md](docs/production-redeploy.md)。

飞书 Base 同步和字段管理使用应用身份直连 OpenAPI，不依赖个人 `lark-cli` 登录态。`OWNER_OPEN_ID` 是唯一管理员身份来源；只有该用户可以执行删除列，且必须在机器人展示目标字段后回复“确认删除”。设置 `BASE_ADMIN_ENABLED=true` 开启聊天字段管理，设置 `FEISHU_BASE_TABLE_LABEL` 调整回复中的表名。Base 字段、权限和环境变量参见 [docs/feishu-base-sync.md](docs/feishu-base-sync.md)。字段管理与确认状态使用 PostgreSQL 持久化，因此开启 `BASE_ADMIN_ENABLED` 时必须配置 `DATABASE_URL`。

v2 必须设置 `LLM_ENABLED=true`，并配置 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL`。模型拿到当前消息、最近对话和需求草稿，自主决定是继续对话，还是调用需求、进展、管理员、Base 和 MCP 工具。应用只负责身份、权限、幂等、并发锁和高风险操作确认，不包含关键词分类器；模型不可用时会明确报错，不会切换到规则流程。正式需求提交、字段删除和 MCP 写操作仍由服务端校验，工具失败也不会被回复成成功。`FEISHU_BASE_URL` 可配置完整 Base 链接；未配置时，若已有 `FEISHU_BASE_TOKEN` 和 `FEISHU_BASE_TABLE_ID`，服务会生成默认链接。`LLM_TIMEOUT_MS`、`LLM_MAX_RETRIES`、`LLM_MAX_INPUT_CHARS` 分别控制超时、瞬时错误重试次数和发送给模型的最大上下文。架构说明参见 [docs/v2-architecture.md](docs/v2-architecture.md)，部署说明参见 [docs/docker-deploy.md](docs/docker-deploy.md)。
启用项目内官方 MCP 时，设置 `MCP_ENABLED=true`、`MCP_URL=http://lark-mcp:3000/mcp`，并通过 `docker compose --profile mcp up -d` 启动。MCP 容器会加载已安装版本提供的完整飞书工具目录；核心服务不再维护第二套工具白名单。模型通过 `find_feishu_tools` 搜索真实工具和参数结构，再通过 `call_feishu_tool` 调用，因此不需要在代码或环境变量中逐个登记工具。涉及写入的 MCP 工具仍会先进入服务侧确认，发起人回复“确认执行”后才会真正调用，回复“取消操作”则清除待执行操作。

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

## Security boundaries

The model owns the conversation and may call any tool exposed by the service. Application code still validates requirement ownership and explicit submission, permissions, high-risk confirmations, idempotency, and concurrency. A tool result with `ok != true` can never be presented as a completed operation.
