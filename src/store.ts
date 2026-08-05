import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConversationState, Requirement, RequirementStore } from "./types.ts";

export class InMemoryRequirementStore implements RequirementStore {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly requirements = new Map<string, Requirement>();
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    this.load();
  }

  getConversation(key: string): ConversationState | undefined {
    const value = this.conversations.get(key);
    return value ? structuredClone(value) : undefined;
  }

  saveConversation(conversation: ConversationState): void {
    this.conversations.set(conversation.key, structuredClone(conversation));
    this.persist();
  }

  createRequirement(input: Omit<Requirement, "id" | "createdAt" | "updatedAt">): Requirement {
    const now = new Date().toISOString();
    const requirement: Requirement = { ...input, id: `REQ-${now.slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`, createdAt: now, updatedAt: now };
    this.requirements.set(requirement.id, requirement);
    this.persist();
    return structuredClone(requirement);
  }

  listRequirements(filter: Parameters<RequirementStore["listRequirements"]>[0] = {}): Requirement[] {
    return [...this.requirements.values()]
      .filter((item) => !filter?.requesterId || item.requesterId === filter.requesterId)
      .filter((item) => !filter?.status || item.status === filter.status)
      .filter((item) => !filter?.visibility || item.visibility === filter.visibility)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((item) => structuredClone(item));
  }

  updateRequirement(id: string, patch: Partial<Pick<Requirement, "status" | "ownerId" | "ownerName" | "progress" | "desiredDate" | "priority" | "visibility">>): Requirement | undefined {
    const current = this.requirements.get(id);
    if (!current) return undefined;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.requirements.set(id, updated);
    this.persist();
    return structuredClone(updated);
  }

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
