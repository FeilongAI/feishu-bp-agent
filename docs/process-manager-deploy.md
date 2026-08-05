# PM2 and systemd Deployment

Both process-manager options require Node.js 22.6+, a reachable PostgreSQL database, and a production environment file containing the values documented in `.env.example`.

## PM2

Install production dependencies and run migrations before starting the process:

```bash
cd /opt/feishu-bp-agent
npm ci --omit=dev
set -a
. /etc/feishu-bp-agent.env
set +a
npm run migrate
pm2 start ecosystem.config.cjs --update-env
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup` with the required system privileges. The supplied ecosystem file intentionally uses one fork process. If the built-in `lark-cli` consumer is enabled, multiple PM2 instances would start duplicate consumers. Horizontal HTTP instances are supported only when event consumption is externalized; PostgreSQL protects message processing and Base outbox delivery across those instances.

Deploy an update with:

```bash
git pull --ff-only
npm ci --omit=dev
npm run migrate
pm2 reload feishu-bp-agent --update-env
```

## systemd

The supplied unit expects the repository at `/opt/feishu-bp-agent`, environment values at `/etc/feishu-bp-agent.env`, and a dedicated unprivileged user.

```bash
sudo useradd --system --home /var/lib/feishu-bp-agent --shell /usr/sbin/nologin feishu-bp-agent
sudo install -d -o feishu-bp-agent -g feishu-bp-agent /var/lib/feishu-bp-agent
sudo chown -R feishu-bp-agent:feishu-bp-agent /opt/feishu-bp-agent
sudo chmod 600 /etc/feishu-bp-agent.env
sudo cp deploy/systemd/feishu-bp-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now feishu-bp-agent
```

The unit runs migrations in `ExecStartPre`, restarts on failure, writes logs to journald, and applies filesystem/kernel hardening. Verify with:

```bash
systemctl status feishu-bp-agent
journalctl -u feishu-bp-agent -f
curl http://127.0.0.1:8090/healthz
```
