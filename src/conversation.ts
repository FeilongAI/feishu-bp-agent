import type { BotReply, ConversationState, IncomingMessage, RequirementDraft, RequirementStore } from "./types.ts";
import type { ExtractedRequirementFields, MessageUnderstanding, UnderstandingClient } from "./understanding.ts";

const PLATFORM_NAMES = ["TikTok", "Meta", "Unity", "AppsFlyer", "AppLovin", "AdMob", "Pangle", "Mintegral"];

export interface ConversationConfig {
  ownerId: string;
  ownerName: string;
}

export class ConversationService {
  readonly store: RequirementStore;
  readonly config: ConversationConfig;
  readonly understanding?: UnderstandingClient;

  constructor(store: RequirementStore, config: ConversationConfig, understanding?: UnderstandingClient) {
    this.store = store;
    this.config = config;
    this.understanding = understanding;
  }

  async handleMessage(message: IncomingMessage): Promise<BotReply> {
    if (message.senderType === "bot") return { text: "" };

    const key = `${message.chatId}:${message.senderId}:${message.threadId ?? "main"}`;
    const conversation = await this.store.getConversation(key) ?? this.newConversation(message, key);
    const text = message.content.trim();
    const ruleCurrentWork = this.isCurrentWorkQuery(text);
    const ruleMyRequirements = this.isMyRequirementsQuery(text);
    const ruleCancel = /^(取消|放弃|清空)(当前)?需求/.test(text);
    const ruleConfirmation = /^(确认|确认提交|提交|是的|可以提交)$/.test(text);
    const analysis = ruleCurrentWork || ruleMyRequirements || ruleCancel || ruleConfirmation
      ? undefined
      : await this.analyze({
        message: text,
        recentMessages: conversation.recentMessages,
        draft: conversation.draft,
      });
    conversation.recentMessages = [...conversation.recentMessages, message.content].slice(-8);
    conversation.updatedAt = new Date().toISOString();

    if (analysis?.intent === "current_work_query" || ruleCurrentWork) {
      await this.store.saveConversation(conversation);
      return { text: await this.currentWorkReply() };
    }
    if (analysis?.intent === "my_requirements_query" || ruleMyRequirements) {
      await this.store.saveConversation(conversation);
      return { text: await this.myRequirementsReply(message.senderId) };
    }
    if (analysis?.intent === "cancel_requirement" || ruleCancel) {
      delete conversation.draft;
      await this.store.saveConversation(conversation);
      return { text: "已清空当前需求草稿。需要提交新需求时，直接告诉我想解决什么问题即可。" };
    }
    const startsRequirement = analysis?.intent === "new_requirement" || /^(新需求|提需求|需求)[:：]?/.test(text);
    if (startsRequirement && conversation.draft) {
      delete conversation.draft;
    }

    const confirmsRequirement = analysis?.intent === "confirm_requirement" || ruleConfirmation;
    if (confirmsRequirement && !conversation.draft) {
      await this.store.saveConversation(conversation);
      return { text: "目前没有等待确认的需求草稿。请先告诉我你想解决的问题，我会逐步帮你整理。" };
    }

    if (confirmsRequirement && conversation.draft?.state === "awaiting_confirmation") {
      const requirement = await this.store.createRequirement({
        title: conversation.draft.title,
        goal: conversation.draft.goal!,
        scope: conversation.draft.scope!,
        acceptanceCriteria: conversation.draft.acceptanceCriteria!,
        requesterId: conversation.draft.requesterId,
        requesterName: conversation.draft.requesterName,
        platforms: conversation.draft.platforms ?? [],
        desiredDate: conversation.draft.desiredDate,
        priority: conversation.draft.priority,
        status: "待评估",
        visibility: "public",
        sourceChatId: message.chatId,
        sourceMessageId: message.messageId,
      });
      delete conversation.draft;
      await this.store.saveConversation(conversation);
      return { text: `已记录需求 ${requirement.id}，当前状态为“待评估”。\n\n我会在确认优先级和排期后，再同步预计完成时间。` };
    }

    if (analysis?.intent === "general_conversation" && !conversation.draft) {
      await this.store.saveConversation(conversation);
      return { text: "我可以帮你记录和澄清需求，也可以查询“我的需求”或询问“当前正在做什么”。直接描述你希望解决的问题即可。" };
    }

    if (!conversation.draft) conversation.draft = this.createDraft(message, key, text);
    else this.fillDraft(conversation.draft, text);
    if (analysis) this.mergeFields(conversation.draft, analysis.fields);

    const reply = this.nextDraftReply(conversation.draft, analysis);
    await this.store.saveConversation(conversation);
    return { text: reply };
  }

  private newConversation(message: IncomingMessage, key: string): ConversationState {
    return { key, chatId: message.chatId, senderId: message.senderId, senderName: message.senderName, threadId: message.threadId, recentMessages: [], updatedAt: new Date().toISOString() };
  }

  private createDraft(message: IncomingMessage, key: string, firstMessage: string): RequirementDraft {
    const title = firstMessage.replace(/^(新需求|提需求|需求)[:：]?\s*/i, "").slice(0, 80) || "未命名需求";
    const draft: RequirementDraft = { id: `DRAFT-${Date.now()}`, conversationKey: key, requesterId: message.senderId, requesterName: message.senderName, title, state: "collecting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.fillDraft(draft, firstMessage);
    return draft;
  }

  private fillDraft(draft: RequirementDraft, text: string): void {
    const lower = text.toLowerCase();
    if (!draft.goal && /(目标|目的|为了|希望|解决)/.test(text)) draft.goal = text;
    if (!draft.scope && /(范围|包含|需要|按|维度|平台|看板|数据)/.test(text) && text !== draft.title) draft.scope = text;
    const platforms = PLATFORM_NAMES.filter((name) => lower.includes(name.toLowerCase()));
    if (platforms.length) draft.platforms = [...new Set([...(draft.platforms ?? []), ...platforms])];
    if (!draft.acceptanceCriteria && /(验收|结果|输出|完成后|需要看到)/.test(text)) draft.acceptanceCriteria = text;
    const date = text.match(/(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|本周[一二三四五六日天]|下周[一二三四五六日天]|月底|下月底)/);
    if (date) draft.desiredDate = date[1];
    const priority = text.match(/\b(P[0-3])\b/i);
    if (priority) draft.priority = priority[1].toUpperCase();
    draft.updatedAt = new Date().toISOString();
  }

  private mergeFields(draft: RequirementDraft, fields: ExtractedRequirementFields): void {
    if (fields.title) draft.title = fields.title;
    if (fields.goal) draft.goal = fields.goal;
    if (fields.scope) draft.scope = fields.scope;
    if (fields.platforms?.length) draft.platforms = [...new Set(fields.platforms)];
    if (fields.acceptanceCriteria) draft.acceptanceCriteria = fields.acceptanceCriteria;
    if (fields.desiredDate) draft.desiredDate = fields.desiredDate;
    if (fields.priority) draft.priority = fields.priority;
    draft.updatedAt = new Date().toISOString();
  }

  private nextDraftReply(draft: RequirementDraft, analysis?: MessageUnderstanding): string {
    if (!draft.goal) return analysis?.nextQuestion || "为了把需求记录准确，先告诉我：这个需求主要想解决什么问题，或希望达成什么结果？";
    if (!draft.scope) return analysis?.nextQuestion || "还需要明确范围：涉及哪些平台、游戏、数据指标或看板模块？";
    if (!draft.acceptanceCriteria) return analysis?.nextQuestion || "最后确认验收标准：做到什么程度，你会认为这个需求已经完成？";
    draft.state = "awaiting_confirmation";
    return this.formatDraft(draft) + "\n\n信息确认无误后，请回复“确认提交”；还可以继续补充期望时间或优先级。";
  }

  private async analyze(input: Parameters<UnderstandingClient["analyze"]>[0]): Promise<MessageUnderstanding | undefined> {
    if (!this.understanding) return undefined;
    try {
      return await this.understanding.analyze(input);
    } catch {
      return undefined;
    }
  }

  private formatDraft(draft: RequirementDraft): string {
    return ["我整理了这条需求：", `- 标题：${draft.title}`, `- 目标：${draft.goal}`, `- 范围：${draft.scope}`, `- 平台：${draft.platforms?.join("、") || "待补充"}`, `- 验收标准：${draft.acceptanceCriteria}`, `- 期望时间：${draft.desiredDate || "未提供"}`, `- 优先级：${draft.priority || "待评估"}`].join("\n");
  }

  private async currentWorkReply(): Promise<string> {
    const active = (await this.store.listRequirements({ status: "进行中" })).filter((item) => item.ownerId === this.config.ownerId);
    if (!active.length) return `${this.config.ownerName} 当前没有标记为“进行中”的需求。`;
    return [`${this.config.ownerName} 当前正在处理：`, ...active.slice(0, 5).map((item) => `- ${item.id} ${item.title}${item.progress ? `：${item.progress}` : ""}`)].join("\n");
  }

  private async myRequirementsReply(requesterId: string): Promise<string> {
    const items = await this.store.listRequirements({ requesterId });
    if (!items.length) return "还没有查到你提交的需求。可以直接告诉我想解决什么问题。";
    return ["你提交的需求：", ...items.slice(0, 10).map((item) => `- ${item.id} ${item.title}：${item.status}${item.desiredDate ? `，期望 ${item.desiredDate}` : ""}`)].join("\n");
  }

  private isCurrentWorkQuery(text: string): boolean { return /(你|我这边|韩飞龙).*(在做什么|正在做什么|当前工作)|当前工作|目前进展/.test(text); }
  private isMyRequirementsQuery(text: string): boolean { return /^(我的需求|我提的需求|查询需求|需求进度)/.test(text); }
}
