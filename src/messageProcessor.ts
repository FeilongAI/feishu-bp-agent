import { ConversationService } from "./conversation.ts";
import type { Logger } from "./logger.ts";
import { authorizeMessage, type PermissionConfig } from "./permissions.ts";
import type { BotReply, IncomingMessage, RequirementStore } from "./types.ts";

export function conversationKey(message: IncomingMessage): string {
  return `${message.chatId}:${message.senderId}:${message.threadId ?? "main"}`;
}

export class MessageProcessor {
  private readonly store: RequirementStore;
  private readonly service: ConversationService;
  private readonly permissions: PermissionConfig;
  private readonly logger: Logger;

  constructor(
    store: RequirementStore,
    service: ConversationService,
    permissions: PermissionConfig,
    logger: Logger,
  ) {
    this.store = store;
    this.service = service;
    this.permissions = permissions;
    this.logger = logger;
  }

  async process(message: IncomingMessage): Promise<BotReply> {
    if (message.senderType === "bot") return { text: "" };
    const decision = authorizeMessage(message, this.permissions);
    if (!decision.allowed) {
      this.logger.warn("message_denied", { messageId: message.messageId, senderId: message.senderId, chatId: message.chatId, reason: decision.reason });
      return { text: decision.silent ? "" : "你没有使用此智能体的权限，请联系管理员。" };
    }

    const key = conversationKey(message);
    try {
      return await this.store.withConversationLock(key, async (lockedStore) => {
        const claim = await lockedStore.claimMessage(message.messageId, key);
        if (!claim.claimed) {
          if (claim.status === "completed" && claim.reply) return claim.reply;
          throw new Error(`message_unavailable:${claim.status ?? "unknown"}`);
        }
        const lockedService = new ConversationService(lockedStore, this.service.config);
        const reply = await lockedService.handleMessage(message);
        await lockedStore.completeMessage(message.messageId, reply);
        return reply;
      });
    } catch (error) {
      await this.store.failMessage(message.messageId, "processing_failed").catch(() => undefined);
      this.logger.error("message_processing_failed", { messageId: message.messageId, senderId: message.senderId, error });
      throw error;
    }
  }
}
