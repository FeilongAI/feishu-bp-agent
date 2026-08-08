import type { BotReply, ConversationState, IncomingMessage, RequirementDraft, RequirementStore } from "./types.ts";
import type { BaseFieldAdmin } from "./feishuBase.ts";
import { createAgentToolRuntime } from "./agentTools.ts";
import { isMcpMutationTool, type McpToolProvider } from "./mcpClient.ts";
import type { AgentClient, ExtractedRequirementFields, MessageUnderstanding, UnderstandingClient } from "./understanding.ts";

const PLATFORM_ALIASES: Record<string, string[]> = {
  TikTok: ["tiktok", "tiktok ads"],
  Meta: ["meta", "facebook", "fb ads"],
  Unity: ["unity", "unity ads"],
  AppsFlyer: ["appsflyer", "app flyer", "appflyer"],
  AppLovin: ["applovin", "app lovin"],
  AdMob: ["admob", "ad mob"],
  Pangle: ["pangle"],
  Mintegral: ["mintegral", "mintegral ads"],
};

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
  readonly understanding?: UnderstandingClient;

  constructor(store: RequirementStore, config: ConversationConfig, understanding?: UnderstandingClient) {
    this.store = store;
    this.config = config;
    this.understanding = understanding;
  }

  async handleMessage(message: IncomingMessage): Promise<BotReply> {
    if (message.senderType === "bot") return { text: "" };

    // Direct conversations are isolated per requester; a group thread shares its
    // pending confirmation state so only the original requester can approve it.
    const key = message.chatType === "group"
      ? `${message.chatId}:${message.threadId ?? "main"}`
      : `${message.chatId}:${message.senderId}:${message.threadId ?? "main"}`;
    const conversation = await this.store.getConversation(key) ?? this.newConversation(message, key);
    const text = message.content.trim();
    const ruleCurrentWork = this.isCurrentWorkQuery(text);
    const ruleMyRequirements = this.isMyRequirementsQuery(text);
    const ruleCancel = /^(取消|放弃|清空)(当前)?需求/.test(text);
    const ruleConfirmation = /^(确认|确认提交|提交|是的|可以提交)$/.test(text);
    const ruleNewRequirement = this.isNewRequirementRequest(text);
    const adminQuery = this.isAdminQuery(text);
    const baseUrlQuery = this.isBaseUrlQuery(text);
    const fieldDelete = this.parseFieldDeleteRequest(text);
    const fieldDeleteConfirmation = this.isFieldDeleteConfirmation(text);
    const analysis = ruleCurrentWork || ruleMyRequirements || ruleCancel || ruleConfirmation || ruleNewRequirement
      || adminQuery || baseUrlQuery || fieldDelete.requested || fieldDeleteConfirmation
      ? undefined
      : await this.analyze({
        message: text,
        recentMessages: conversation.recentMessages,
        draft: conversation.draft,
      });
    conversation.recentMessages = [...conversation.recentMessages, message.content].slice(-8);
    conversation.updatedAt = new Date().toISOString();

    // Confirmation is an application-owned security boundary. Resolve it before
    // invoking the model so a confirmation message cannot trigger a fresh tool call.
    if (this.isMcpConfirmation(text) && conversation.pendingMcpAction) {
      const pending = conversation.pendingMcpAction;
      if (pending.state === "executing") {
        await this.store.saveConversation(conversation);
        return { text: "这项飞书操作上一次执行状态不明，已停止自动重试，请先确认远端文档状态。" };
      }
      if (pending.requestedById !== message.senderId) {
        await this.store.recordAudit({ actorId: message.senderId, action: "MCP_CONFIRM", resourceId: pending.toolName, result: "denied" }).catch(() => undefined);
        await this.store.saveConversation(conversation);
        return { text: "这项飞书操作只能由发起人确认。" };
      }
      if (Date.parse(pending.expiresAt) <= Date.now()) {
        delete conversation.pendingMcpAction;
        await this.store.saveConversation(conversation);
        return { text: "这条飞书操作确认已过期，请重新发起操作。" };
      }
      if (!this.config.mcp) {
        await this.store.saveConversation(conversation);
        return { text: "当前 MCP 服务不可用，未执行任何操作。" };
      }
      pending.state = "executing";
      await this.store.saveConversation(conversation);
      const result = await this.config.mcp.callTool(pending.toolName, pending.argumentsJson).catch(() => ({ ok: false, error: "mcp_unavailable" }));
      if (this.mcpResultOk(result)) delete conversation.pendingMcpAction;
      await this.store.recordAudit({ actorId: message.senderId, action: "MCP_CONFIRM", resourceId: pending.toolName, result: this.mcpResultOk(result) ? "success" : "failed" }).catch(() => undefined);
      await this.store.saveConversation(conversation);
      return this.mcpResultOk(result)
        ? { text: `已执行飞书操作“${pending.toolName}”。${this.mcpResultText(result)}` }
        : { text: `飞书操作“${pending.toolName}”执行失败，未完成任何其他操作。请检查权限或稍后重试。` };
    }
    if (this.isMcpCancellation(text) && conversation.pendingMcpAction) {
      if (conversation.pendingMcpAction.requestedById !== message.senderId) {
        await this.store.recordAudit({ actorId: message.senderId, action: "MCP_CANCEL", resourceId: conversation.pendingMcpAction.toolName, result: "denied" }).catch(() => undefined);
        await this.store.saveConversation(conversation);
        return { text: "这项飞书操作只能由发起人取消。" };
      }
      await this.store.recordAudit({ actorId: message.senderId, action: "MCP_CANCEL", resourceId: conversation.pendingMcpAction.toolName, result: "success" }).catch(() => undefined);
      delete conversation.pendingMcpAction;
      await this.store.saveConversation(conversation);
      return { text: "已取消待确认的飞书操作。" };
    }

    const deterministicRequirementFlow = ruleCancel || ruleConfirmation
      || analysis?.intent === "cancel_requirement" || analysis?.intent === "confirm_requirement";
    const draftOwnedByOther = Boolean(conversation.draft && conversation.draft.requesterId !== message.senderId);
    const mutatesDraft = deterministicRequirementFlow || (!ruleCurrentWork && !ruleMyRequirements && !adminQuery && !baseUrlQuery && !fieldDelete.requested && !fieldDeleteConfirmation);
    if (draftOwnedByOther && mutatesDraft) {
      await this.store.saveConversation(conversation);
      return { text: "当前群聊中的需求草稿由其他成员发起，只有发起人可以补充、取消或确认提交。" };
    }

    if (!adminQuery && !fieldDelete.requested && !fieldDeleteConfirmation && !deterministicRequirementFlow && !ruleNewRequirement && this.config.agent) {
      const runtime = createAgentToolRuntime({
        message,
        store: this.store,
        ownerId: this.config.ownerId,
        ownerName: this.config.ownerName,
        baseTableLabel: this.config.baseTableLabel || "多维表格",
        baseUrl: this.config.baseUrl,
        baseAdmin: this.config.baseAdmin,
      });
      const discoveredMcpTools = this.config.mcp ? await this.config.mcp.listTools().catch(() => []) : [];
      const mcpTools = discoveredMcpTools.filter((tool) => !runtime.definitions.some((item) => item.function.name === tool.function.name));
      runtime.definitions.push(...mcpTools);
      let mcpActionRequested = false;
      let mcpActionDenied = false;
      let mcpActionConflict = false;
      let agentToolFailed = false;
      const markToolResult = (result: unknown): unknown => {
        if (result && typeof result === "object" && (result as Record<string, unknown>).ok === false) agentToolFailed = true;
        return result;
      };
      const executor = {
        execute: async (name: string, argumentsJson: string) => {
          if (mcpTools.some((tool) => tool.function.name === name)) {
            if (isMcpMutationTool(name)) {
              if (conversation.pendingMcpAction && conversation.pendingMcpAction.requestedById !== message.senderId) {
                mcpActionDenied = true;
                return { ok: false, error: "mcp_confirmation_owned_by_other" };
              }
              if (conversation.pendingMcpAction) {
                mcpActionConflict = true;
                return { ok: false, error: "mcp_confirmation_already_pending" };
              }
              if (!conversation.pendingMcpAction || conversation.pendingMcpAction.requestedById === message.senderId) {
                conversation.pendingMcpAction = {
                  toolName: name,
                  argumentsJson: argumentsJson.slice(0, 20_000),
                  requestedById: message.senderId,
                  requestedAt: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
                  state: "pending",
                };
              }
              mcpActionRequested = true;
              await this.store.saveConversation(conversation);
              const pending = conversation.pendingMcpAction;
              return { ok: false, confirmationRequired: true, toolName: pending?.toolName || name, expiresInMinutes: 10 };
            }
            return markToolResult(await this.config.mcp!.callTool(name, argumentsJson));
          }
          return markToolResult(await runtime.executor.execute(name, argumentsJson));
        },
      };
      const agentResult = await this.config.agent.run({
        message: text,
        recentMessages: conversation.recentMessages.slice(0, -1),
        draft: conversation.draft,
        senderId: message.senderId,
        senderName: message.senderName,
      }, runtime.definitions, executor).catch(() => undefined);
      if (mcpActionConflict) {
        await this.store.saveConversation(conversation);
        return { text: "已有一项飞书写操作等待确认，请先确认或取消当前操作。" };
      }
      if (mcpActionRequested && conversation.pendingMcpAction) {
        await this.store.saveConversation(conversation);
        return { text: `检测到需要执行飞书写操作“${conversation.pendingMcpAction.toolName}”。为避免误操作，请核对请求后回复“确认执行”；如不执行请回复“取消操作”。` };
      }
      if (mcpActionDenied) {
        await this.store.saveConversation(conversation);
        return { text: "当前有其他成员发起的飞书操作待确认，只有发起人可以确认或取消。" };
      }
      if (agentToolFailed) {
        await this.store.saveConversation(conversation);
        return { text: "工具调用未成功，我没有把这次操作当作已完成。请检查权限或参数后重试。" };
      }
      if (agentResult?.usedTools && agentResult.text) {
        await this.store.saveConversation(conversation);
        return { text: agentResult.text };
      }
    }

    if (adminQuery) {
      await this.store.saveConversation(conversation);
      return { text: `当前管理员是${this.config.ownerName}（${this.config.ownerId || "未配置 OWNER_OPEN_ID"}）。只有管理员可以执行多维表格字段删除等高风险操作。` };
    }

    if (baseUrlQuery) {
      await this.store.saveConversation(conversation);
      return this.config.baseUrl
        ? { text: `${this.config.baseTableLabel || "需求多维表格"}地址：${this.config.baseUrl}` }
        : { text: "当前还没有配置需求多维表格地址。请管理员设置 FEISHU_BASE_URL 后重启服务。" };
    }

    if (fieldDeleteConfirmation && conversation.pendingBaseFieldDelete) {
      if (!this.isAdmin(message)) {
        await this.store.saveConversation(conversation);
        return { text: `这项操作只有管理员${this.config.ownerName}可以执行。` };
      }
      if (Date.parse(conversation.pendingBaseFieldDelete.expiresAt) <= Date.now()) {
        delete conversation.pendingBaseFieldDelete;
        await this.store.saveConversation(conversation);
        return { text: "这条删除确认已过期。请重新说明要删除的列，我会先展示目标并再次确认。" };
      }
      if (!this.config.baseAdmin) {
        await this.store.saveConversation(conversation);
        return { text: "当前服务还没有启用 Base 字段管理能力，请配置 BASE_ADMIN_ENABLED=true 后重启。" };
      }
      const pending = conversation.pendingBaseFieldDelete;
      try {
        await this.config.baseAdmin.deleteField(pending.fieldId);
        delete conversation.pendingBaseFieldDelete;
        await this.store.recordAudit({ actorId: message.senderId, action: "DELETE_BASE_FIELD", resourceId: pending.fieldId, payload: { fieldName: pending.fieldName }, result: "success" }).catch(() => undefined);
        await this.store.saveConversation(conversation);
        return { text: `已删除${this.config.baseTableLabel || "多维表格"}中的列“${pending.fieldName}”。` };
      } catch (error) {
        await this.store.recordAudit({ actorId: message.senderId, action: "DELETE_BASE_FIELD", resourceId: pending.fieldId, payload: { fieldName: pending.fieldName }, result: "failed" }).catch(() => undefined);
        await this.store.saveConversation(conversation);
        return { text: `删除列“${pending.fieldName}”失败，未完成任何其他操作。请检查 Base 权限或字段是否仍存在。` };
      }
    }

    if (fieldDelete.requested) {
      if (!this.isAdmin(message)) {
        await this.store.recordAudit({ actorId: message.senderId, action: "DELETE_BASE_FIELD", result: "denied" }).catch(() => undefined);
        await this.store.saveConversation(conversation);
        return { text: `这项操作只有管理员${this.config.ownerName}可以执行。` };
      }
      if (!this.config.baseAdmin) {
        await this.store.saveConversation(conversation);
        return { text: "当前服务还没有启用 Base 字段管理能力，请配置 BASE_ADMIN_ENABLED=true 后重启。" };
      }
      if (!fieldDelete.fieldName) {
        await this.store.saveConversation(conversation);
        return { text: `请告诉我要删除的具体列名，例如“删除${this.config.baseTableLabel || "多维表格"}的列：负责人”。` };
      }
      const fields = await this.config.baseAdmin.listFields().catch(() => []);
      const matches = fields.filter((field) => field.fieldId.toLowerCase() === fieldDelete.fieldName!.toLowerCase() || field.name.trim().toLowerCase() === fieldDelete.fieldName!.toLowerCase());
      if (!matches.length) {
        await this.store.saveConversation(conversation);
        const available = fields.slice(0, 20).map((field) => field.name).join("、");
        return { text: `没有找到列“${fieldDelete.fieldName}”。${available ? `当前可见列包括：${available}。` : "暂时无法读取当前字段列表，请检查 Base 权限。"}` };
      }
      if (matches.length > 1) {
        await this.store.saveConversation(conversation);
        return { text: `找到多个同名列“${fieldDelete.fieldName}”，请改用字段 ID：${matches.map((field) => `${field.name}（${field.fieldId}）`).join("、")}。` };
      }
      const field = matches[0];
      if (field.isPrimary) {
        await this.store.saveConversation(conversation);
        return { text: `列“${field.name}”是多维表格主字段，不能删除；可以考虑重命名或清空其内容。` };
      }
      conversation.pendingBaseFieldDelete = {
        fieldId: field.fieldId,
        fieldName: field.name,
        requestedById: message.senderId,
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
      await this.store.saveConversation(conversation);
      return { text: `你要删除${this.config.baseTableLabel || "多维表格"}中的列“${field.name}”（${field.fieldId}）。删除后该列及其数据可能无法恢复。确认执行请回复“确认删除”。` };
    }

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
    const startsRequirement = analysis?.intent === "new_requirement" || ruleNewRequirement || /^(新需求|提需求|需求)[:：]?/.test(text);
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

  private isAdmin(message: IncomingMessage): boolean {
    return Boolean(this.config.ownerId && message.senderId === this.config.ownerId);
  }

  private isAdminQuery(text: string): boolean {
    return /(?:谁是|哪个是|告诉我).*(?:管理员|负责人)|管理员(?:是谁|身份|可以做什么)/.test(text);
  }

  private isBaseUrlQuery(text: string): boolean {
    if (this.isNewRequirementRequest(text)) return false;
    const hasResource = /(?:需求|多维表格|多维表|Base|bitable|表格)/i.test(text);
    const hasAddress = /(?:地址|链接|URL)/i.test(text);
    const asksForIt = /(?:是什么|在哪|给我|发我|查询|查看|告诉|提供|找一下|找下)/i.test(text);
    return hasResource && hasAddress && asksForIt;
  }

  private isNewRequirementRequest(text: string): boolean {
    return /^(?:接下来\s*)?(?:新增|新建|创建|提出|发起)\s*(?:一个|一项)?\s*需求(?:$|[\s:：，,])/i.test(text)
      || /^(?:请|帮我|麻烦)?\s*(?:记录|登记|记下|记一下)\s*(?:一个|一项)?\s*(?:新)?需求(?:$|[\s:：，,])/i.test(text)
      || /(?:帮我|请帮我|麻烦帮我)\s*(?:记录|记下|记一下)\b.*(?:需求|事项|任务)/i.test(text);
  }

  private isFieldDeleteConfirmation(text: string): boolean {
    return /^(确认删除|确认执行删除|执行删除|确认)$/i.test(text.trim());
  }

  private isMcpConfirmation(text: string): boolean {
    // Keep bare “确认” reserved for the requirement/Base deletion flows.
    return /^(确认执行|执行操作|确认操作)$/i.test(text.trim());
  }

  private isMcpCancellation(text: string): boolean {
    return /^(取消|放弃|不要执行|取消操作)$/.test(text.trim());
  }

  private mcpResultOk(result: unknown): boolean {
    return Boolean(result && typeof result === "object" && (result as Record<string, unknown>).ok === true);
  }

  private mcpResultText(result: unknown): string {
    if (!result || typeof result !== "object") return "";
    const value = result as Record<string, unknown>;
    const content = Array.isArray(value.content) ? value.content : [];
    const text = content.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text") as Record<string, unknown> | undefined;
    return typeof text?.text === "string" ? `返回：${text.text.slice(0, 1_000)}` : "";
  }

  private parseFieldDeleteRequest(text: string): { requested: boolean; fieldName?: string } {
    const requested = /(?:多维表格|多维表|Base|bitable|表格).*(?:删除|删掉|移除|去掉).*(?:列|字段)|(?:删除|删掉|移除|去掉).*(?:列|字段)|(?:列|字段).*(?:删除|删掉|移除|去掉)/i.test(text);
    if (!requested) return { requested: false };
    const afterColumn = text.match(/(?:列|字段)\s*(?:是|为|叫|名为|[:：])?\s*[「『“"【]?([\s\S]+?)[」』”"】]?\s*(?:删除|删掉|移除|去掉)?$/i)?.[1];
    const beforeColumn = text.match(/[「『“"【]?([^「『“"【】」』”"，。:：]+?)[」』”"】]?\s*(?:列|字段)\s*(?:进行|执行)?\s*(?:删除|删掉|移除|去掉)$/i)?.[1];
    const candidates = [afterColumn, beforeColumn]
      .map((candidate) => candidate?.trim().replace(/^(进行|执行)\s*/, "").replace(/[，。！!？?]+$/, "").trim())
      .map((candidate) => candidate?.replace(/^(?:把|将)\s*/, "").replace(/^.*(?:的|中|内)\s*/, "").trim())
      .filter((candidate): candidate is string => Boolean(candidate) && !/^(进行|执行|删除|删掉|移除|去掉|一下|操作)$/.test(candidate));
    return { requested: true, fieldName: candidates[0] };
  }

  private createDraft(message: IncomingMessage, key: string, firstMessage: string): RequirementDraft {
    const title = this.requirementTitle(firstMessage);
    const draft: RequirementDraft = { id: `DRAFT-${Date.now()}`, conversationKey: key, requesterId: message.senderId, requesterName: message.senderName, title, state: "collecting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.fillDraft(draft, firstMessage);
    return draft;
  }

  private requirementTitle(text: string): string {
    const title = text.trim()
      .replace(/^(?:接下来\s*)?(?:新增|新建|创建|提出|发起)\s*(?:一个|一项)?\s*需求\s*[:：，,]?\s*/i, "")
      .replace(/^(?:新需求|提需求|需求)\s*[:：，,]?\s*/i, "")
      .replace(/[，,\s]*(?:请|帮我|麻烦)?\s*(?:记录|记下|记一下|登记)(?:一下)?\s*$/i, "")
      .trim();
    return title.slice(0, 80) || "未命名需求";
  }

  private fillDraft(draft: RequirementDraft, text: string): void {
    const lower = text.toLowerCase();
    if (!draft.goal && /(目标|目的|为了|希望|解决)/.test(text)) draft.goal = text;
    if (!draft.scope && /(范围|包含|需要|按|维度|平台|看板|数据)/.test(text) && text !== draft.title) draft.scope = text;
    const platforms = Object.entries(PLATFORM_ALIASES)
      .filter(([, aliases]) => aliases.some((alias) => lower.includes(alias)))
      .map(([name]) => name);
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
    if (!draft.goal) return analysis?.nextQuestion || `我先记下需求“${draft.title}”。为了把需求记录准确，请告诉我：这个需求主要想解决什么问题，或希望达成什么结果？`;
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
