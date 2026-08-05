CREATE TABLE IF NOT EXISTS bp_base_outbox (
  id BIGSERIAL PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  lock_token UUID,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bp_base_outbox_operation CHECK (operation IN ('upsert','delete'))
);

CREATE INDEX IF NOT EXISTS bp_base_outbox_pending_idx
  ON bp_base_outbox (next_attempt_at, id)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS bp_base_sync_state (
  requirement_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bp_base_worker_lease (
  id SMALLINT PRIMARY KEY,
  lock_token UUID,
  locked_until TIMESTAMPTZ,
  CONSTRAINT bp_base_worker_lease_singleton CHECK (id = 1)
);

INSERT INTO bp_base_worker_lease (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
