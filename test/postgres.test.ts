import assert from "node:assert/strict";
import test from "node:test";
import { PostgresRequirementStore } from "../src/postgres.ts";

test("persists pending Base field deletion state in the conversation row", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const row = {
    conversation_key: "oc_demo:ou_owner:main",
    chat_id: "oc_demo",
    sender_id: "ou_owner",
    sender_name: "韩飞龙",
    thread_id: null,
    draft: null,
    pending_base_field_delete: {
      fieldId: "fld_owner",
      fieldName: "负责人",
      requestedById: "ou_owner",
      requestedAt: "2026-08-08T01:00:00.000Z",
      expiresAt: "2026-08-08T01:10:00.000Z",
    },
    recent_messages: ["删除需求表的列：负责人"],
    updated_at: "2026-08-08T01:00:00.000Z",
  };
  const db = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return sql.startsWith("SELECT")
        ? { rows: [row], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    },
  };
  const store = new PostgresRequirementStore("unused", db);
  await store.saveConversation({
    key: row.conversation_key,
    chatId: row.chat_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    draft: undefined,
    pendingBaseFieldDelete: row.pending_base_field_delete,
    recentMessages: row.recent_messages,
    updatedAt: row.updated_at,
  });
  const insert = calls[0];
  assert.match(insert.sql, /pending_base_field_delete/);
  assert.deepEqual(JSON.parse(String(insert.values?.[6])), row.pending_base_field_delete);
  const restored = await store.getConversation(row.conversation_key);
  assert.deepEqual(restored?.pendingBaseFieldDelete, row.pending_base_field_delete);
});
