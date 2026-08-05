import pg from "pg";
import type { ConversationState, Requirement, RequirementStatus, RequirementStore } from "./types.ts";

const { Pool } = pg;

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

function toRequirement(row: Record<string, unknown>): Requirement {
  return {
    id: String(row.id),
    title: String(row.title),
    goal: String(row.goal),
    scope: String(row.scope),
    acceptanceCriteria: String(row.acceptance_criteria),
    requesterId: String(row.requester_id),
    requesterName: row.requester_name ? String(row.requester_name) : undefined,
    platforms: Array.isArray(row.platforms) ? row.platforms.map(String) : [],
    desiredDate: row.desired_date ? String(row.desired_date) : undefined,
    priority: row.priority ? String(row.priority) : undefined,
    status: String(row.status) as RequirementStatus,
    ownerId: row.owner_id ? String(row.owner_id) : undefined,
    ownerName: row.owner_name ? String(row.owner_name) : undefined,
    progress: row.progress ? String(row.progress) : undefined,
    visibility: String(row.visibility) as Requirement["visibility"],
    sourceChatId: String(row.source_chat_id),
    sourceMessageId: String(row.source_message_id),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export class PostgresRequirementStore implements RequirementStore {
  private readonly pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 10), idleTimeoutMillis: 30_000 });
  }

  async getConversation(key: string): Promise<ConversationState | undefined> {
    const result = await this.pool.query("SELECT * FROM bp_conversation WHERE conversation_key = $1", [key]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      key: String(row.conversation_key),
      chatId: String(row.chat_id),
      senderId: String(row.sender_id),
      senderName: row.sender_name ? String(row.sender_name) : undefined,
      threadId: row.thread_id ? String(row.thread_id) : undefined,
      draft: row.draft as ConversationState["draft"],
      recentMessages: Array.isArray(row.recent_messages) ? row.recent_messages.map(String) : [],
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }

  async saveConversation(conversation: ConversationState): Promise<void> {
    await this.pool.query(
      `INSERT INTO bp_conversation (conversation_key, chat_id, sender_id, sender_name, thread_id, draft, recent_messages, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
       ON CONFLICT (conversation_key) DO UPDATE SET sender_name=EXCLUDED.sender_name, draft=EXCLUDED.draft,
       recent_messages=EXCLUDED.recent_messages, updated_at=EXCLUDED.updated_at`,
      [conversation.key, conversation.chatId, conversation.senderId, conversation.senderName ?? null, conversation.threadId ?? null, JSON.stringify(conversation.draft ?? null), JSON.stringify(conversation.recentMessages), conversation.updatedAt],
    );
  }

  async createRequirement(input: Omit<Requirement, "id" | "createdAt" | "updatedAt">): Promise<Requirement> {
    const result = await this.pool.query(
      `INSERT INTO bp_requirement (title, goal, scope, acceptance_criteria, requester_id, requester_name, platforms,
       desired_date, priority, status, owner_id, owner_name, progress, visibility, source_chat_id, source_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [input.title, input.goal, input.scope, input.acceptanceCriteria, input.requesterId, input.requesterName ?? null, JSON.stringify(input.platforms), input.desiredDate ?? null, input.priority ?? null, input.status, input.ownerId ?? null, input.ownerName ?? null, input.progress ?? null, input.visibility, input.sourceChatId, input.sourceMessageId],
    );
    return toRequirement(result.rows[0]);
  }

  async listRequirements(filter: Parameters<RequirementStore["listRequirements"]>[0] = {}): Promise<Requirement[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter?.requesterId) { values.push(filter.requesterId); conditions.push(`requester_id = $${values.length}`); }
    if (filter?.status) { values.push(filter.status); conditions.push(`status = $${values.length}`); }
    if (filter?.visibility) { values.push(filter.visibility); conditions.push(`visibility = $${values.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(`SELECT * FROM bp_requirement ${where} ORDER BY updated_at DESC`, values);
    return result.rows.map(toRequirement);
  }

  async updateRequirement(id: string, patch: Parameters<RequirementStore["updateRequirement"]>[1]): Promise<Requirement | undefined> {
    const allowed = new Map<string, string>([["status", "status"], ["ownerId", "owner_id"], ["ownerName", "owner_name"], ["progress", "progress"], ["desiredDate", "desired_date"], ["priority", "priority"], ["visibility", "visibility"]]);
    const updates: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of allowed) {
      if (!(key in patch)) continue;
      values.push(patch[key as keyof typeof patch] ?? null);
      updates.push(`${column} = $${values.length}`);
    }
    if (!updates.length) return (await this.listRequirements()).find((item) => item.id === id);
    values.push(id);
    const result = await this.pool.query(`UPDATE bp_requirement SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values);
    return result.rows[0] ? toRequirement(result.rows[0]) : undefined;
  }

  async deleteRequirement(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM bp_requirement WHERE id = $1", [id]);
    return result.rowCount === 1;
  }

  async healthCheck(): Promise<void> { await this.pool.query("SELECT 1"); }
  async close(): Promise<void> { await this.pool.end(); }
}
