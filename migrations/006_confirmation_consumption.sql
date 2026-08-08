CREATE TABLE IF NOT EXISTS bp_confirmation_consumption (
  jti TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bp_confirmation_consumption_expiry_idx
  ON bp_confirmation_consumption (expires_at);
