# 生产部署与重新部署指南

本文用于 Docker 生产部署，以及代码更新后的重新部署。

## 服务组成

- `postgres`：保存需求、会话、幂等记录、确认状态和 Base outbox。
- `feishu-bp-agent`：智能体、需求澄清、MCP 调用和管理接口。
- `feishu-bp-forwarder`：使用 `lark-cli` 接收飞书消息并发送回复。

当前架构下两个应用容器都需要运行。MCP 负责调用飞书文档/Base 工具，不能替代消息转发器。

## 首次部署

服务器需要 Docker、Docker Compose Plugin 和 Git。

```bash
sudo mkdir -p /opt
sudo git clone git@github.com:FeilongAI/feishu-bp-agent.git /opt/feishu-bp-agent
sudo chown -R "$USER":"$(id -gn)" /opt/feishu-bp-agent
cd /opt/feishu-bp-agent
```

创建生产配置：

```bash
cp .env.example .env
chmod 600 .env
vi .env
```

至少配置：

```dotenv
POSTGRES_PASSWORD=随机的URL安全密码
ADMIN_API_KEY=至少24位随机字符串
INGRESS_API_KEY=另一组至少24位随机字符串
INGRESS_EVENT_SECRET=至少32位随机字符串
CONFIRMATION_SECRET=至少32位随机字符串
OWNER_OPEN_ID=管理员的飞书open_id
OWNER_NAME=管理员姓名
BOT_OPEN_ID=机器人open_id
FEISHU_APP_ID=飞书应用ID
FEISHU_APP_SECRET=飞书应用密钥
```

飞书应用还需要开通 `contact:user.base:readonly`，发布并审批包含该权限的新版本，同时确保应用通讯录可见范围包含所有允许使用智能体的人。默认部署由 forwarder 使用 Bot 身份按消息中的 `open_id` 查询姓名；即使不启用 MCP，这些权限和可见范围也必须配置。

密钥只放在服务器 `.env` 中，不要提交到 Git。`POSTGRES_PASSWORD` 建议只使用字母、数字和下划线。

校验、构建和启动：

```bash
docker compose config >/tmp/feishu-bp-agent-compose.yml
docker compose build --pull
docker compose up -d
```

核心服务启动时会自动执行未执行的数据库迁移。不要执行 `docker compose down -v`，否则会删除 PostgreSQL 数据卷。

检查服务：

```bash
docker compose ps
docker compose logs --tail=100 feishu-bp-agent
docker compose logs --tail=100 feishu-bp-forwarder
curl --fail http://127.0.0.1:8090/healthz
docker exec feishu-bp-forwarder wget -qO- http://127.0.0.1:8091/healthz
```

转发器启动时会自动使用 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 初始化 `lark-cli`。

## 代码更新后的重新部署

```bash
cd /opt/feishu-bp-agent
git status --short
git pull --ff-only origin main
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 feishu-bp-agent
docker compose logs --tail=200 feishu-bp-forwarder
curl --fail http://127.0.0.1:8090/healthz
docker exec feishu-bp-forwarder wget -qO- http://127.0.0.1:8091/healthz
```

如果 `git status` 显示服务器有本地修改，先备份并处理后再拉取。`docker compose up -d` 会重建需要更新的容器，但保留 PostgreSQL 数据卷。

## 启用本地 MCP

在 `.env` 中设置 `MCP_ENABLED=true`、`MCP_URL=http://lark-mcp:3000/mcp`、`MCP_ALLOWED_TOOLS=`，并配置 `MCP_TOOL_ALLOWLIST` 和 `MCP_LARK_TOOLS`。`MCP_ALLOWED_TOOLS` 请求头用于官方远程 MCP，本地 profile 依靠 `MCP_LARK_TOOLS` 和核心 allowlist 控制工具。然后执行：

```bash
docker compose --profile mcp build
docker compose --profile mcp up -d
```

MCP 写操作会要求发起人回复“确认执行”；取消时回复“取消操作”。`lark-mcp` 容器以非 root 用户运行。

如需让核心服务也通过 MCP 按 `open_id` 补全姓名，请确保 `MCP_LARK_TOOLS` 包含点号形式的 API 标识 `contact.v3.user.get`；如果配置了 `MCP_TOOL_ALLOWLIST`，其中必须填写 MCP 实际暴露的 snake 工具名 `contact_v3_user_get`。可设置 `SENDER_NAME_MCP_TOOL=contact_v3_user_get` 固定工具选择。配置修改后需要重建并重启 `lark-mcp` 与核心服务。

## 常用运维命令

```bash
docker compose ps
docker compose logs -f feishu-bp-agent
docker compose logs -f feishu-bp-forwarder
docker compose restart
docker compose down
docker compose up -d
```

`restart` 和 `down` 都会保留数据卷；除非确认要删除全部数据，否则不要执行 `docker compose down -v`。

## 故障排查

核心服务失败时查看 `docker compose logs feishu-bp-agent`，重点检查数据库连接、三个 API 密钥和 `INGRESS_EVENT_SECRET`。转发器失败时查看 `docker compose logs feishu-bp-forwarder`，重点检查飞书应用凭据、`im.message.receive_v1` 订阅、机器人可见范围，以及两个服务的 ingress 配置是否一致。

如果健康检查通过但没有回复，请检查核心服务 `8090`，并通过 `docker exec feishu-bp-forwarder wget -qO- http://127.0.0.1:8091/healthz` 检查转发器，再查看转发器日志中的 `pending`。群聊还要确认消息明确 `@` 了机器人。

如果数据消失，先检查是否误执行了 `docker compose down -v`，以及是否因为更换 Compose 项目名使用了新数据卷：

```bash
docker volume ls | grep feishu-bp-agent
docker compose config | grep -A3 volumes
```

生产环境应使用 PostgreSQL 工具定期备份数据库，不要只备份 Docker 镜像。

## 安全要求

- `.env` 权限保持为 `600`。
- 不要把 API Key、App Secret、TAT/UAT 提交到 Git。
- 核心服务 8090 只映射到宿主机回环地址；forwarder 的 8091 不映射到宿主机，只能从容器内检查。
- `/api/messages` 必须同时使用 `INGRESS_API_KEY` 和 `INGRESS_EVENT_SECRET`。
- `feishu-bp-forwarder` 只运行一个实例，避免重复消费飞书事件。
