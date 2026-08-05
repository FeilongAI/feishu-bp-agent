CREATE TABLE IF NOT EXISTS bp_processed_message (
  message_id TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  status TEXT NOT NULL,
  reply JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bp_processed_message_status CHECK (status IN ('processing','completed','failed'))
);

CREATE INDEX IF NOT EXISTS bp_processed_message_updated_idx ON bp_processed_message (updated_at);

CREATE TABLE IF NOT EXISTS bp_admin_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT,
  payload JSONB,
  result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bp_admin_audit_result CHECK (result IN ('success','denied','failed'))
);

CREATE INDEX IF NOT EXISTS bp_admin_audit_created_idx ON bp_admin_audit (created_at DESC);
