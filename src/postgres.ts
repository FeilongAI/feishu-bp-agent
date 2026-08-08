import pg from "pg";
import { randomUUID } from "node:crypto";
import type { AdminAuditEvent, BaseOutboxItem, BaseOutboxStore, BotReply, ConversationState, ProcessedMessageClaim, Requirement, RequirementStatus, RequirementStore } from "./types.ts";

const { Pool } = pg;

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

interface PoolClientLike extends Queryable {
  release(): void;
}

interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
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

export class PostgresRequirementStore implements RequirementStore, BaseOutboxStore {
  private readonly db: Queryable;
  private readonly pool?: PoolLike;

  constructor(connectionString: string, db?: Queryable, pool?: PoolLike) {
    if (db) {
      this.db = db;
      this.pool = pool;
      return;
    }
    const createdPool = new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 10), idleTimeoutMillis: 30_000 }) as unknown as PoolLike;
    this.db = createdPool;
    this.pool = createdPool;
  }

  async getConversation(key: string): Promise<ConversationState | undefined> {
    const result = await this.db.query("SELECT * FROM bp_conversation WHERE conversation_key = $1", [key]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      key: String(row.conversation_key),
      chatId: String(row.chat_id),
      senderId: String(row.sender_id),
      senderName: row.sender_name ? String(row.sender_name) : undefined,
      threadId: row.thread_id ? String(row.thread_id) : undefined,
      draft: row.draft as ConversationState["draft"],
      pendingBaseFieldDelete: row.pending_base_field_delete as ConversationState["pendingBaseFieldDelete"],
      pendingMcpAction: row.pending_mcp_action as ConversationState["pendingMcpAction"],
      recentMessages: Array.isArray(row.recent_messages) ? row.recent_messages.map(String) : [],
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }

  async saveConversation(conversation: ConversationState): Promise<void> {
    await this.db.query(
      `INSERT INTO bp_conversation (conversation_key, chat_id, sender_id, sender_name, thread_id, draft, pending_base_field_delete, pending_mcp_action, recent_messages, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10)
       ON CONFLICT (conversation_key) DO UPDATE SET sender_name=EXCLUDED.sender_name, draft=EXCLUDED.draft,
       pending_base_field_delete=EXCLUDED.pending_base_field_delete, pending_mcp_action=EXCLUDED.pending_mcp_action, recent_messages=EXCLUDED.recent_messages, updated_at=EXCLUDED.updated_at`,
      [conversation.key, conversation.chatId, conversation.senderId, conversation.senderName ?? null, conversation.threadId ?? null, JSON.stringify(conversation.draft ?? null), JSON.stringify(conversation.pendingBaseFieldDelete ?? null), JSON.stringify(conversation.pendingMcpAction ?? null), JSON.stringify(conversation.recentMessages), conversation.updatedAt],
    );
  }

  async createRequirement(input: Omit<Requirement, "id" | "createdAt" | "updatedAt">): Promise<Requirement> {
    return this.runMutation(async (db) => {
      const result = await db.query(
        `INSERT INTO bp_requirement (title, goal, scope, acceptance_criteria, requester_id, requester_name, platforms,
         desired_date, priority, status, owner_id, owner_name, progress, visibility, source_chat_id, source_message_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [input.title, input.goal, input.scope, input.acceptanceCriteria, input.requesterId, input.requesterName ?? null, JSON.stringify(input.platforms), input.desiredDate ?? null, input.priority ?? null, input.status, input.ownerId ?? null, input.ownerName ?? null, input.progress ?? null, input.visibility, input.sourceChatId, input.sourceMessageId],
      );
      const requirement = toRequirement(result.rows[0]);
      await this.enqueueBaseEvent(db, requirement.id, "upsert", requirement);
      return requirement;
    });
  }

  async listRequirements(filter: Parameters<RequirementStore["listRequirements"]>[0] = {}): Promise<Requirement[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter?.requesterId) { values.push(filter.requesterId); conditions.push(`requester_id = $${values.length}`); }
    if (filter?.status) { values.push(filter.status); conditions.push(`status = $${values.length}`); }
    if (filter?.visibility) { values.push(filter.visibility); conditions.push(`visibility = $${values.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.db.query(`SELECT * FROM bp_requirement ${where} ORDER BY updated_at DESC`, values);
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
    if (!updates.length) {
      const result = await this.db.query("SELECT * FROM bp_requirement WHERE id = $1", [id]);
      return result.rows[0] ? toRequirement(result.rows[0]) : undefined;
    }
    values.push(id);
    return this.runMutation(async (db) => {
      const result = await db.query(`UPDATE bp_requirement SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values);
      if (!result.rows[0]) return undefined;
      const requirement = toRequirement(result.rows[0]);
      await this.enqueueBaseEvent(db, requirement.id, "upsert", requirement);
      return requirement;
    });
  }

  async deleteRequirement(id: string): Promise<boolean> {
    return this.runMutation(async (db) => {
      const result = await db.query("DELETE FROM bp_requirement WHERE id = $1", [id]);
      if (result.rowCount !== 1) return false;
      await this.enqueueBaseEvent(db, id, "delete", { id });
      return true;
    });
  }

  async claimMessage(messageId: string, conversationKey: string): Promise<ProcessedMessageClaim> {
    const inserted = await this.db.query(
      `INSERT INTO bp_processed_message (message_id, conversation_key, status)
       VALUES ($1, $2, 'processing') ON CONFLICT (message_id) DO NOTHING RETURNING status`,
      [messageId, conversationKey],
    );
    if (inserted.rowCount === 1) return { claimed: true, status: "processing" };

    const reclaimed = await this.db.query(
      `UPDATE bp_processed_message SET status = 'processing', reply = NULL, error_code = NULL, updated_at = NOW()
       WHERE message_id = $1 AND conversation_key = $2 AND (status = 'failed' OR (status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes'))
       RETURNING status`,
      [messageId, conversationKey],
    );
    if (reclaimed.rowCount === 1) return { claimed: true, status: "processing" };

    const existing = await this.db.query("SELECT conversation_key, status, reply FROM bp_processed_message WHERE message_id = $1", [messageId]);
    const row = existing.rows[0];
    if (!row) return { claimed: false, status: "failed" };
    return {
      claimed: false,
      status: String(row.status) as ProcessedMessageClaim["status"],
      reply: String(row.conversation_key) === conversationKey && row.reply ? row.reply as unknown as BotReply : undefined,
    };
  }

  async completeMessage(messageId: string, reply: BotReply): Promise<void> {
    await this.db.query(
      "UPDATE bp_processed_message SET status = 'completed', reply = $2::jsonb, error_code = NULL, updated_at = NOW() WHERE message_id = $1 AND status = 'processing'",
      [messageId, JSON.stringify(reply)],
    );
  }

  async failMessage(messageId: string, errorCode: string): Promise<void> {
    await this.db.query(
      `INSERT INTO bp_processed_message (message_id, conversation_key, status, error_code)
       VALUES ($1, 'unknown', 'failed', $2)
       ON CONFLICT (message_id) DO UPDATE SET status = 'failed', error_code = EXCLUDED.error_code, updated_at = NOW()
       WHERE bp_processed_message.status = 'processing'`,
      [messageId, errorCode],
    );
  }

  async consumeConfirmation(jti: string, expiresAt: Date): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO bp_confirmation_consumption (jti, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (jti) DO NOTHING
       RETURNING jti`,
      [jti, expiresAt.toISOString()],
    );
    return result.rowCount === 1;
  }

  async withConversationLock<T>(conversationKey: string, operation: (store: RequirementStore) => Promise<T>): Promise<T> {
    if (!this.pool) return operation(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationKey]);
      const transactionalStore = new PostgresRequirementStore("", client);
      const result = await operation(transactionalStore);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAudit(event: AdminAuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO bp_admin_audit (actor_id, action, resource_id, payload, result)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [event.actorId, event.action, event.resourceId ?? null, JSON.stringify(event.payload ?? null), event.result],
    );
  }

  async claimBaseOutbox(limit: number): Promise<BaseOutboxItem[]> {
    if (!this.pool) throw new Error("base_outbox_claim_requires_pool");
    const client = await this.pool.connect();
    const lockToken = randomUUID();
    try {
      await client.query("BEGIN");
      const lease = await client.query("SELECT lock_token, locked_until FROM bp_base_worker_lease WHERE id = 1 FOR UPDATE");
      const lockedUntil = lease.rows[0]?.locked_until ? new Date(String(lease.rows[0].locked_until)).getTime() : 0;
      if (lockedUntil > Date.now()) {
        await client.query("COMMIT");
        return [];
      }
      await client.query("UPDATE bp_base_worker_lease SET lock_token = $1, locked_until = NOW() + INTERVAL '30 minutes' WHERE id = 1", [lockToken]);
      const result = await client.query(
        `WITH candidates AS (
           SELECT item.id FROM bp_base_outbox AS item
           WHERE item.processed_at IS NULL AND item.next_attempt_at <= NOW() AND (item.locked_until IS NULL OR item.locked_until < NOW())
             AND NOT EXISTS (
               SELECT 1 FROM bp_base_outbox AS earlier
               WHERE earlier.requirement_id = item.requirement_id AND earlier.processed_at IS NULL AND earlier.id < item.id
             )
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE bp_base_outbox AS item
             SET attempts = item.attempts + 1, locked_until = NOW() + INTERVAL '30 minutes', lock_token = $2
         FROM candidates WHERE item.id = candidates.id
         RETURNING item.id, item.requirement_id, item.operation, item.payload, item.attempts, item.lock_token`,
        [Math.max(1, Math.min(limit, 100)), lockToken],
      );
      if (!result.rowCount) await client.query("UPDATE bp_base_worker_lease SET lock_token = NULL, locked_until = NULL WHERE id = 1 AND lock_token = $1", [lockToken]);
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        id: Number(row.id),
        requirementId: String(row.requirement_id),
        operation: String(row.operation) as BaseOutboxItem["operation"],
        payload: row.payload as unknown as BaseOutboxItem["payload"],
        attempts: Number(row.attempts),
        lockToken: String(row.lock_token),
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseBaseOutboxLease(lockToken: string): Promise<void> {
    await this.db.query(
      "UPDATE bp_base_worker_lease SET lock_token = NULL, locked_until = NULL WHERE id = 1 AND lock_token = $1",
      [lockToken],
    );
  }

  async getBaseRecordId(requirementId: string): Promise<string | undefined> {
    const result = await this.db.query("SELECT record_id FROM bp_base_sync_state WHERE requirement_id = $1", [requirementId]);
    return result.rows[0] ? String(result.rows[0].record_id) : undefined;
  }

  async completeBaseOutbox(item: BaseOutboxItem, recordId?: string): Promise<void> {
    await this.runMutation(async (db) => {
      if (item.operation === "upsert") {
        if (!recordId) throw new Error("record_id_required_for_upsert");
        await db.query(
          `INSERT INTO bp_base_sync_state (requirement_id, record_id, synced_at) VALUES ($1, $2, NOW())
           ON CONFLICT (requirement_id) DO UPDATE SET record_id = EXCLUDED.record_id, synced_at = NOW()`,
          [item.requirementId, recordId],
        );
      } else {
        await db.query("DELETE FROM bp_base_sync_state WHERE requirement_id = $1", [item.requirementId]);
      }
      const completed = await db.query(
        `UPDATE bp_base_outbox SET processed_at = NOW(), locked_until = NULL, lock_token = NULL, last_error = NULL
         WHERE id = $1 AND lock_token = $2 AND processed_at IS NULL`,
        [item.id, item.lockToken],
      );
      if (completed.rowCount !== 1) throw new Error("base_outbox_lease_lost");
    });
  }

  async failBaseOutbox(item: BaseOutboxItem, error: string, retryAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE bp_base_outbox SET next_attempt_at = $3, locked_until = NULL, lock_token = NULL, last_error = $4
       WHERE id = $1 AND lock_token = $2 AND processed_at IS NULL`,
      [item.id, item.lockToken, retryAt.toISOString(), error.slice(0, 2000)],
    );
  }

  private async runMutation<T>(operation: (db: Queryable) => Promise<T>): Promise<T> {
    if (!this.pool) return operation(this.db);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async enqueueBaseEvent(db: Queryable, requirementId: string, operation: BaseOutboxItem["operation"], payload: BaseOutboxItem["payload"]): Promise<void> {
    await db.query(
      "INSERT INTO bp_base_outbox (requirement_id, operation, payload) VALUES ($1, $2, $3::jsonb)",
      [requirementId, operation, JSON.stringify(payload)],
    );
  }

  async healthCheck(): Promise<void> { await this.db.query("SELECT 1"); }
  async close(): Promise<void> { if (this.pool) await this.pool.end(); }
}
