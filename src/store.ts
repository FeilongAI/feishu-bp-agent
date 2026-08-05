import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AdminAuditEvent, BotReply, ConversationState, ProcessedMessageClaim, Requirement, RequirementStore } from "./types.ts";

export class InMemoryRequirementStore implements RequirementStore {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly requirements = new Map<string, Requirement>();
  private readonly processedMessages = new Map<string, { status: "processing" | "completed" | "failed"; reply?: BotReply }>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    this.load();
  }

  async getConversation(key: string): Promise<ConversationState | undefined> {
    const value = this.conversations.get(key);
    return value ? structuredClone(value) : undefined;
  }

  async saveConversation(conversation: ConversationState): Promise<void> {
    this.conversations.set(conversation.key, structuredClone(conversation));
    this.persist();
  }

  async createRequirement(input: Omit<Requirement, "id" | "createdAt" | "updatedAt">): Promise<Requirement> {
    const now = new Date().toISOString();
    const requirement: Requirement = { ...input, id: `REQ-${now.slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`, createdAt: now, updatedAt: now };
    this.requirements.set(requirement.id, requirement);
    this.persist();
    return structuredClone(requirement);
  }

  async listRequirements(filter: Parameters<RequirementStore["listRequirements"]>[0] = {}): Promise<Requirement[]> {
    return [...this.requirements.values()]
      .filter((item) => !filter?.requesterId || item.requesterId === filter.requesterId)
      .filter((item) => !filter?.status || item.status === filter.status)
      .filter((item) => !filter?.visibility || item.visibility === filter.visibility)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((item) => structuredClone(item));
  }

  async updateRequirement(id: string, patch: Partial<Pick<Requirement, "status" | "ownerId" | "ownerName" | "progress" | "desiredDate" | "priority" | "visibility">>): Promise<Requirement | undefined> {
    const current = this.requirements.get(id);
    if (!current) return undefined;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.requirements.set(id, updated);
    this.persist();
    return structuredClone(updated);
  }

  async deleteRequirement(id: string): Promise<boolean> {
    const deleted = this.requirements.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  async claimMessage(messageId: string, _conversationKey: string): Promise<ProcessedMessageClaim> {
    const existing = this.processedMessages.get(messageId);
    if (existing?.status === "failed") {
      this.processedMessages.set(messageId, { status: "processing" });
      return { claimed: true, status: "processing" };
    }
    if (existing) return { claimed: false, ...structuredClone(existing) };
    this.processedMessages.set(messageId, { status: "processing" });
    return { claimed: true, status: "processing" };
  }

  async completeMessage(messageId: string, reply: BotReply): Promise<void> {
    this.processedMessages.set(messageId, { status: "completed", reply: structuredClone(reply) });
  }

  async failMessage(messageId: string, _errorCode: string): Promise<void> {
    this.processedMessages.set(messageId, { status: "failed" });
  }

  async withConversationLock<T>(conversationKey: string, operation: (store: RequirementStore) => Promise<T>): Promise<T> {
    const previous = this.locks.get(conversationKey) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(conversationKey, queued);
    await previous;
    try {
      return await operation(this);
    } finally {
      release();
      if (this.locks.get(conversationKey) === queued) this.locks.delete(conversationKey);
    }
  }

  async recordAudit(_event: AdminAuditEvent): Promise<void> {}

  async healthCheck(): Promise<void> {}

  async close(): Promise<void> {}

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as { conversations?: ConversationState[]; requirements?: Requirement[] };
      for (const conversation of data.conversations ?? []) this.conversations.set(conversation.key, conversation);
      for (const requirement of data.requirements ?? []) this.requirements.set(requirement.id, requirement);
    } catch (error) {
      process.stderr.write(`[store] unable to load ${this.filePath}: ${String(error)}\n`);
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ conversations: [...this.conversations.values()], requirements: [...this.requirements.values()] }, null, 2));
  }
}
