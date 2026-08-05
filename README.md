# feishu-bp-agent

飞书 BP 需求收集与工作进度播报智能体 MVP。

当前版本包含：

- 多轮需求澄清：需求草稿 -> 补充信息 -> 用户确认 -> 正式需求
- “我的需求”和“当前工作”查询
- HTTP 测试入口，便于后续接入飞书 Base
- `lark-cli event consume` 消息监听与机器人回复适配
- 本地 JSON 持久化，后续替换为 PostgreSQL/Base 适配器

## Run

Node.js 22.6+ is required for native TypeScript stripping.

```bash
cp .env.example .env
npm test
npm run dev
```

默认 HTTP 端口为 `8090`。测试消息入口：

```bash
curl -X POST http://127.0.0.1:8090/api/messages \
  -H 'content-type: application/json' \
  -d '{"chat_id":"oc_demo","sender_id":"ou_demo","message_id":"om_demo_1","content":"我想做一个 Meta 消耗看板","sender_type":"user"}'
```

真实飞书监听需要先完成应用事件订阅和 Bot 权限，然后设置 `RUN_LARK_CONSUMER=true`。生产环境建议替换 JSON 存储，并把写入 Base/任务系统放到受控的工具适配器中。

管理接口：

```bash
curl 'http://127.0.0.1:8090/api/requirements?status=进行中'
curl -X PATCH http://127.0.0.1:8090/api/requirements/REQ-xxx \
  -H 'content-type: application/json' \
  -d '{"status":"进行中","ownerId":"ou_owner","progress":"正在核对数据"}'
```

## Conversation rules

The agent never creates a formal requirement from an unconfirmed draft. It asks for the business goal, scope, and acceptance criteria, then waits for an explicit confirmation.
