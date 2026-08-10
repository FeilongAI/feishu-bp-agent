import { ConversationService } from "./conversation.ts";
import type { Logger } from "./logger.ts";
import { authorizeMessage, type PermissionConfig } from "./permissions.ts";
import type { SenderDirectory } from "./senderDirectory.ts";
import type { BotReply, IncomingMessage, RequirementStore } from "./types.ts";

export function conversationKey(message: IncomingMessage): string {
  return message.chatType === "group"
    ? `${message.chatId}:${message.threadId ?? "main"}`
    : `${message.chatId}:${message.senderId}:${message.threadId ?? "main"}`;
}

export class MessageProcessor {
  private readonly store: RequirementStore;
  private readonly service: ConversationService;
  private readonly permissions: PermissionConfig;
  private readonly logger: Logger;
  private readonly senderDirectory?: SenderDirectory;

  constructor(
    store: RequirementStore,
    service: ConversationService,
    permissions: PermissionConfig,
    logger: Logger,
    senderDirectory?: SenderDirectory,
  ) {
    this.store = store;
    this.service = service;
    this.permissions = permissions;
    this.logger = logger;
    this.senderDirectory = senderDirectory;
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
        const enrichedMessage = this.senderDirectory
          ? await this.senderDirectory.enrich(message).catch((error) => {
            this.logger.warn("sender_name_enrichment_failed", { reason: error instanceof Error ? error.name : "unknown" });
            return message;
          })
          : message;
        const lockedService = new ConversationService(lockedStore, this.service.config, this.service.understanding);
        const reply = await lockedService.handleMessage(enrichedMessage);
        await lockedStore.completeMessage(enrichedMessage.messageId, reply);
        return reply;
      });
    } catch (error) {
      await this.store.failMessage(message.messageId, "processing_failed").catch(() => undefined);
      this.logger.error("message_processing_failed", { messageId: message.messageId, senderId: message.senderId, error });
      throw error;
    }
  }
}
