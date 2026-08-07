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

To run the CLI message gateway under PM2, first install the pinned official CLI and initialize the Bot profile as the service user. Pass the secret over stdin, not in command arguments:

```bash
sudo npm install -g @larksuite/cli@1.0.83
sudo install -d -m 700 -o feishu-bp-agent -g feishu-bp-agent /var/lib/feishu-bp-forwarder
sudo -u feishu-bp-agent env HOME=/var/lib/feishu-bp-forwarder /bin/sh -c '
  set -a
  . /etc/feishu-bp-agent.env
  set +a
  printf "%s\n" "$FEISHU_APP_SECRET" | lark-cli config init --app-id "$FEISHU_APP_ID" --app-secret-stdin --brand "${FEISHU_BRAND:-feishu}"
'
sudo -u feishu-bp-agent /bin/sh -c '
  set -a
  . /etc/feishu-bp-agent.env
  set +a
  HOME=/var/lib/feishu-bp-forwarder pm2 start ecosystem.forwarder.config.cjs --update-env
'
sudo -u feishu-bp-agent env HOME=/var/lib/feishu-bp-forwarder pm2 save
```

Run one forwarder instance only. Its default health endpoint is `http://127.0.0.1:8091/healthz`.

## systemd

The supplied unit expects the repository at `/opt/feishu-bp-agent`, environment values at `/etc/feishu-bp-agent.env`, and a dedicated unprivileged user.

```bash
sudo useradd --system --home /var/lib/feishu-bp-agent --shell /usr/sbin/nologin feishu-bp-agent
sudo install -d -o feishu-bp-agent -g feishu-bp-agent /var/lib/feishu-bp-agent
sudo chown -R feishu-bp-agent:feishu-bp-agent /opt/feishu-bp-agent
sudo chmod 600 /etc/feishu-bp-agent.env
sudo cp deploy/systemd/feishu-bp-agent.service /etc/systemd/system/
sudo cp deploy/systemd/feishu-bp-forwarder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now feishu-bp-agent
sudo systemctl enable --now feishu-bp-forwarder
```

The unit runs migrations in `ExecStartPre`, restarts on failure, writes logs to journald, and applies filesystem/kernel hardening. Verify with:

```bash
systemctl status feishu-bp-agent
journalctl -u feishu-bp-agent -f
systemctl status feishu-bp-forwarder
journalctl -u feishu-bp-forwarder -f
curl http://127.0.0.1:8090/healthz
curl http://127.0.0.1:8091/healthz
```

Install `@larksuite/cli@1.0.83` globally before starting the forwarder unit. The unit initializes the Bot profile from `/etc/feishu-bp-agent.env`, stores CLI/spool state under `/var/lib/feishu-bp-forwarder`, waits for the core service, and applies the same system hardening controls.
