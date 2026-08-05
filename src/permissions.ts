import type { IncomingMessage } from "./types.ts";

export interface PermissionConfig {
  allowedTenantKeys: Set<string>;
  allowedUserIds: Set<string>;
  allowedChatIds: Set<string>;
  groupRequireMention: boolean;
  botOpenId?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: "tenant_denied" | "user_denied" | "chat_denied" | "bot_mention_required";
  silent?: boolean;
}

export function csvSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

export function authorizeMessage(message: IncomingMessage, config: PermissionConfig): PermissionDecision {
  if (config.allowedTenantKeys.size && (!message.tenantKey || !config.allowedTenantKeys.has(message.tenantKey))) return { allowed: false, reason: "tenant_denied" };
  if (config.allowedUserIds.size && !config.allowedUserIds.has(message.senderId)) return { allowed: false, reason: "user_denied" };
  if (config.allowedChatIds.size && !config.allowedChatIds.has(message.chatId)) return { allowed: false, reason: "chat_denied" };
  if (message.chatType === "group" && config.groupRequireMention) {
    const mentioned = config.botOpenId
      ? message.mentions?.some((mention) => mention.id === config.botOpenId)
      : Boolean(message.mentions?.length);
    if (!mentioned) return { allowed: false, reason: "bot_mention_required", silent: true };
  }
  return { allowed: true };
}
