# Docker Deployment

This project is designed for manual image builds and manual instance creation.

## 1. Prepare environment

Create an `.env` file on the server. Do not commit it:

```bash
cp .env.example .env
vi .env
```

Minimum values:

```dotenv
OWNER_OPEN_ID=ou_your_open_id
OWNER_NAME=韩飞龙
RUN_LARK_CONSUMER=false
```

`RUN_LARK_CONSUMER=true` is only valid when the image also contains a configured `lark-cli` binary and Bot identity. The Dockerfile intentionally fails fast when that binary is missing.

## 2. Build the image

```bash
docker build --pull -t feishu-bp-agent:0.1.0 .
```

For a private registry:

```bash
docker tag feishu-bp-agent:0.1.0 registry.example.com/feishu-bp-agent:0.1.0
docker push registry.example.com/feishu-bp-agent:0.1.0
```

## 3. Create the instance manually

```bash
docker volume create feishu-bp-agent-data
docker run -d \
  --name feishu-bp-agent \
  --restart unless-stopped \
  --env-file .env \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=8090 \
  -e DATA_FILE=/data/state.json \
  -p 8090:8090 \
  --mount type=volume,src=feishu-bp-agent-data,dst=/data \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --read-only \
  --tmpfs /tmp \
  feishu-bp-agent:0.1.0
```

Verify:

```bash
curl http://127.0.0.1:8090/healthz
docker logs -f feishu-bp-agent
```

## 4. Compose alternative

```bash
docker compose build
docker compose up -d
docker compose logs -f feishu-bp-agent
```

## Lark event modes

The core container exposes `POST /api/messages` for normalized incoming events. This keeps the image independent of local macOS Keychain state.

For a first remote deployment, run `lark-cli event consume` in a controlled sidecar or host process and forward each normalized event to the container. A later production iteration should replace this adapter with a direct Feishu OpenAPI/SDK listener and store Bot credentials in the server secret manager.

Do not expose `/api/messages` or `/api/requirements` publicly until request authentication and sender authorization are implemented.
