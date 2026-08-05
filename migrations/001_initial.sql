CREATE TABLE IF NOT EXISTS bp_conversation (
  conversation_key TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  thread_id TEXT,
  draft JSONB,
  recent_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bp_requirement (
  id TEXT PRIMARY KEY DEFAULT ('REQ-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT), 1, 6))),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  scope TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  requester_name TEXT,
  platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
  desired_date TEXT,
  priority TEXT,
  status TEXT NOT NULL,
  owner_id TEXT,
  owner_name TEXT,
  progress TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  source_chat_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bp_requirement_visibility CHECK (visibility IN ('public', 'requester', 'private')),
  CONSTRAINT bp_requirement_status CHECK (status IN ('待评估','已排期','进行中','待验收','已完成','暂缓'))
);

CREATE INDEX IF NOT EXISTS bp_requirement_requester_idx ON bp_requirement (requester_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS bp_requirement_status_idx ON bp_requirement (status, updated_at DESC);
