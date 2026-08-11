import type { BaseFieldAdmin } from "./feishuBase.ts";
import type { McpToolProvider } from "./mcpClient.ts";
import { resolvePendingAction } from "./conversationPolicy.ts";
import { createToolSession } from "./toolGateway.ts";
import type { AgentClient } from "./agent.ts";
import type { BotReply, ConversationState, IncomingMessage, RequirementStore } from "./types.ts";

const MAX_HISTORY_ITEMS = 16;

export interface ConversationConfig {
  ownerId: string;
  ownerName: string;
  baseAdmin?: BaseFieldAdmin;
  baseTableLabel?: string;
  baseUrl?: string;
  agent?: AgentClient;
  mcp?: McpToolProvider;
}

export class ConversationService {
  readonly store: RequirementStore;
  readonly config: ConversationConfig;

  constructor(store: RequirementStore, config: ConversationConfig) {
    this.store = store;
    this.config = config;
  }

  async handleMessage(message: IncomingMessage): Promise<BotReply> {
    if (message.senderType === "bot") return { text: "" };

    const key = this.conversationKey(message);
    const conversation = await this.store.getConversation(key) ?? this.newConversation(message, key);
    this.refreshIdentity(conversation, message);
    const history = this.normalizeHistory(conversation.recentMessages);
    const previousHistory = history.slice(-MAX_HISTORY_ITEMS);
    conversation.recentMessages = [...previousHistory, this.userHistoryLine(message)].slice(-MAX_HISTORY_ITEMS);
    conversation.updatedAt = new Date().toISOString();

    const policyReply = await resolvePendingAction(message, conversation, this.store, {
      ownerId: this.config.ownerId,
      ownerName: this.config.ownerName,
      baseTableLabel: this.config.baseTableLabel || "多维表格",
      baseAdmin: this.config.baseAdmin,
      mcp: this.config.mcp,
    });
    if (policyReply) return this.complete(conversation, policyReply);

    if (!this.config.agent) {
      return this.complete(conversation, { text: "智能对话服务当前不可用，请联系管理员检查 LLM 配置。" });
    }

    const tools = await createToolSession({
      message,
      conversation,
      conversationKey: key,
      store: this.store,
      ownerId: this.config.ownerId,
      ownerName: this.config.ownerName,
      baseTableLabel: this.config.baseTableLabel || "多维表格",
      baseUrl: this.config.baseUrl,
      baseAdmin: this.config.baseAdmin,
      mcp: this.config.mcp,
    });
    const result = await this.config.agent.run({
      message: message.content.trim(),
      recentMessages: previousHistory,
      draft: conversation.draft,
      senderId: message.senderId,
      senderName: message.senderName,
    }, tools.definitions, tools.executor).catch(() => undefined);

    return this.complete(conversation, { text: tools.finish(result) });
  }

  private async complete(conversation: ConversationState, reply: BotReply): Promise<BotReply> {
    if (reply.text) conversation.recentMessages = [...conversation.recentMessages, `助手：${reply.text}`].slice(-MAX_HISTORY_ITEMS);
    conversation.updatedAt = new Date().toISOString();
    await this.store.saveConversation(conversation);
    return reply;
  }

  private conversationKey(message: IncomingMessage): string {
    return message.chatType === "group"
      ? `${message.chatId}:${message.threadId ?? "main"}`
      : `${message.chatId}:${message.senderId}:${message.threadId ?? "main"}`;
  }

  private newConversation(message: IncomingMessage, key: string): ConversationState {
    return {
      key,
      chatId: message.chatId,
      senderId: message.senderId,
      senderName: message.senderName,
      threadId: message.threadId,
      recentMessages: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private refreshIdentity(conversation: ConversationState, message: IncomingMessage): void {
    if (message.senderName && conversation.senderId === message.senderId) conversation.senderName = message.senderName;
    if (message.senderName && conversation.draft?.requesterId === message.senderId && !conversation.draft.requesterName) {
      conversation.draft.requesterName = message.senderName;
    }
  }

  private normalizeHistory(history: unknown): string[] {
    if (!Array.isArray(history)) return [];
    return history
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => /^(用户|助手)(?:（[^）]+）)?：/.test(item) ? item : `用户：${item}`)
      .slice(-MAX_HISTORY_ITEMS);
  }

  private userHistoryLine(message: IncomingMessage): string {
    const identity = message.senderName || message.senderId;
    return `用户（${identity}）：${message.content}`;
  }
}
