ALTER TABLE bp_conversation
  ADD COLUMN IF NOT EXISTS pending_base_field_delete JSONB;
