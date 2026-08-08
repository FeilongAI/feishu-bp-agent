ALTER TABLE bp_conversation
  ADD COLUMN IF NOT EXISTS pending_mcp_action JSONB;
