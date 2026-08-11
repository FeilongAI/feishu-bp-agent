import type { BaseFieldAdmin } from "./feishuBase.ts";
import { canViewRequirement } from "./requirementVisibility.ts";
import type { AgentToolDefinition, AgentToolExecutor } from "./agent.ts";
import type { ConversationState, IncomingMessage, RequirementStore } from "./types.ts";

export interface AgentToolContext {
  message: IncomingMessage;
  store: RequirementStore;
  ownerId: string;
  ownerName: string;
  baseTableLabel: string;
  baseUrl?: string;
  baseAdmin?: BaseFieldAdmin;
  conversation: ConversationState;
  conversationKey: string;
}

export interface AgentToolRuntime {
  definitions: AgentToolDefinition[];
  executor: AgentToolExecutor;
}

const definitions: AgentToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "save_requirement_draft",
      description: "保存或更新当前需求草稿。新需求、补充信息、修改标题/目标/范围/验收标准时使用；不要在信息不完整时创建正式需求。保存后根据 missing 字段继续向用户提问。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "需求标题" },
          goal: { type: "string", description: "业务目标或要解决的问题" },
          scope: { type: "string", description: "范围、平台、游戏、国家、指标或模块" },
          platforms: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "string", description: "可验收的完成标准" },
          desiredDate: { type: "string" },
          priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_requirement",
      description: "在用户明确确认提交后，将当前完整草稿保存为正式需求。服务会再次校验用户消息和必填字段，不能提前调用。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_requirement_draft",
      description: "用户明确要求取消、放弃或清空当前需求时清除草稿。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_requirement_table_link",
      description: "获取需求多维表格的可点击地址。没有配置时返回配置提示，不要自行猜地址。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_administrator",
      description: "查询当前智能体管理员的姓名和 open_id。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_current_work",
      description: "查询管理员当前状态为进行中的需求和进展。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_requirements",
      description: "查询发送者自己提交过的需求、状态和期望时间。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_base_fields",
      description: "读取需求多维表格的字段名称、字段 ID 和主字段标记。删除字段前只能先查询，不执行删除。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_delete_base_field",
      description: "请求删除需求多维表格字段。仅管理员可用；工具只展示目标并创建服务侧确认状态，绝不直接删除。用户必须随后明确回复“确认删除”。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["fieldName"],
        properties: { fieldName: { type: "string", description: "字段名称或字段 ID" } },
      },
    },
  },
];

export function createAgentToolRuntime(context: AgentToolContext): AgentToolRuntime {
  return {
    // Each conversation may add MCP tools; never mutate the module-level
    // built-in definition array shared by concurrent requests.
    definitions: [...definitions],
    executor: {
      async execute(name, argumentsJson) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(argumentsJson || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          return { ok: false, error: "invalid_tool_arguments" };
        }
        if (!["save_requirement_draft", "request_delete_base_field"].includes(name) && Object.keys(args).length) return { ok: false, error: "tool_arguments_not_allowed" };
        switch (name) {
          case "save_requirement_draft": {
            const current = context.conversation.draft;
            if (current && current.requesterId !== context.message.senderId) return { ok: false, error: "draft_owned_by_other" };
            const text = (key: string, max: number): string | undefined => typeof args[key] === "string" && String(args[key]).trim() ? String(args[key]).trim().slice(0, max) : undefined;
            const title = text("title", 80) || current?.title || "未命名需求";
            const goal = text("goal", 1_000) || current?.goal;
            const scope = text("scope", 1_500) || current?.scope;
            const acceptanceCriteria = text("acceptanceCriteria", 1_500) || current?.acceptanceCriteria;
            const desiredDate = text("desiredDate", 80) || current?.desiredDate;
            const priority = text("priority", 2)?.toUpperCase() || current?.priority;
            const platforms = Array.isArray(args.platforms)
              ? [...new Set(args.platforms.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 10))]
              : current?.platforms;
            const now = new Date().toISOString();
            context.conversation.draft = {
              id: current?.id || `DRAFT-${Date.now()}`,
              conversationKey: context.conversationKey,
              requesterId: context.message.senderId,
              requesterName: context.message.senderName ?? current?.requesterName,
              title,
              goal,
              scope,
              platforms,
              acceptanceCriteria,
              desiredDate,
              priority: priority && ["P0", "P1", "P2", "P3"].includes(priority) ? priority : current?.priority,
              state: goal && scope && acceptanceCriteria ? "awaiting_confirmation" : "collecting",
              createdAt: current?.createdAt || now,
              updatedAt: now,
            };
            await context.store.saveConversation(context.conversation);
            const draft = context.conversation.draft;
            const missing = [!draft.goal ? "goal" : undefined, !draft.scope ? "scope" : undefined, !draft.acceptanceCriteria ? "acceptanceCriteria" : undefined].filter(Boolean);
            return { ok: true, draft, missing, confirmationRequired: draft.state === "awaiting_confirmation" };
          }
          case "submit_requirement": {
            if (!/^(确认|确认提交|提交|是的|可以提交)$/.test(context.message.content.trim())) return { ok: false, error: "explicit_confirmation_required" };
            const draft = context.conversation.draft;
            if (!draft || draft.requesterId !== context.message.senderId) return { ok: false, error: "no_owned_requirement_draft" };
            if (!draft.goal || !draft.scope || !draft.acceptanceCriteria) return { ok: false, error: "requirement_fields_missing", missing: [!draft.goal ? "goal" : undefined, !draft.scope ? "scope" : undefined, !draft.acceptanceCriteria ? "acceptanceCriteria" : undefined].filter(Boolean) };
            const requirement = await context.store.createRequirement({
              title: draft.title, goal: draft.goal, scope: draft.scope, acceptanceCriteria: draft.acceptanceCriteria,
              requesterId: draft.requesterId, requesterName: draft.requesterName, platforms: draft.platforms || [], desiredDate: draft.desiredDate, priority: draft.priority,
              status: "待评估", visibility: "public", sourceChatId: context.message.chatId, sourceMessageId: context.message.messageId,
            });
            delete context.conversation.draft;
            await context.store.saveConversation(context.conversation);
            return { ok: true, requirementId: requirement.id, status: requirement.status };
          }
          case "clear_requirement_draft": {
            if (!/^(取消|放弃|清空)(当前)?需求/.test(context.message.content.trim())) return { ok: false, error: "explicit_cancellation_required" };
            const draft = context.conversation.draft;
            if (!draft || draft.requesterId !== context.message.senderId) return { ok: false, error: "no_owned_requirement_draft" };
            delete context.conversation.draft;
            await context.store.saveConversation(context.conversation);
            return { ok: true };
          }
          case "get_requirement_table_link":
            return context.baseUrl
              ? { ok: true, label: context.baseTableLabel, url: context.baseUrl }
              : { ok: false, error: "requirement_table_url_not_configured", setup: "设置 FEISHU_BASE_URL 后重启服务" };
          case "get_administrator":
            return { ok: true, name: context.ownerName, openId: context.ownerId || null };
          case "list_current_work": {
            const items = (await context.store.listRequirements({ status: "进行中" }))
              .filter((item) => item.ownerId === context.ownerId && canViewRequirement(item, context.message.senderId, context.ownerId))
              .slice(0, 10);
            return { ok: true, items: items.map((item) => ({ id: item.id, title: item.title, progress: item.progress || null, status: item.status })) };
          }
          case "list_my_requirements": {
            const items = (await context.store.listRequirements({ requesterId: context.message.senderId }))
              .filter((item) => canViewRequirement(item, context.message.senderId, context.ownerId))
              .slice(0, 20);
            return { ok: true, items: items.map((item) => ({ id: item.id, title: item.title, status: item.status, desiredDate: item.desiredDate || null })) };
          }
          case "list_base_fields":
            if (!context.baseAdmin) return { ok: false, error: "base_admin_not_enabled", setup: "设置 BASE_ADMIN_ENABLED=true 后重启服务" };
            return { ok: true, fields: (await context.baseAdmin.listFields()).slice(0, 200).map((field) => ({ id: field.fieldId, name: field.name, type: field.type || null, isPrimary: field.isPrimary === true })) };
          case "request_delete_base_field": {
            if (context.message.senderId !== context.ownerId) return { ok: false, error: "admin_only" };
            if (!context.baseAdmin) return { ok: false, error: "base_admin_not_enabled", setup: "设置 BASE_ADMIN_ENABLED=true 后重启服务" };
            if (context.conversation.pendingBaseFieldDelete) return { ok: false, error: "base_confirmation_already_pending" };
            const fieldName = typeof args.fieldName === "string" ? args.fieldName.trim().slice(0, 200) : "";
            if (!fieldName) return { ok: false, error: "field_name_required" };
            const fields = await context.baseAdmin.listFields().catch(() => []);
            const matches = fields.filter((field) => field.fieldId.toLowerCase() === fieldName.toLowerCase() || field.name.trim().toLowerCase() === fieldName.toLowerCase());
            if (!matches.length) return { ok: false, error: "field_not_found", fields: fields.slice(0, 20).map((field) => field.name) };
            if (matches.length > 1) return { ok: false, error: "ambiguous_field", fields: matches.map((field) => ({ id: field.fieldId, name: field.name })) };
            const field = matches[0];
            if (field.isPrimary) return { ok: false, error: "primary_field_cannot_be_deleted", fieldName: field.name };
            context.conversation.pendingBaseFieldDelete = {
              fieldId: field.fieldId, fieldName: field.name, requestedById: context.message.senderId,
              requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            };
            await context.store.saveConversation(context.conversation);
            return { ok: true, confirmationRequired: true, fieldId: field.fieldId, fieldName: field.name, expiresInMinutes: 10 };
          }
          default:
            return { ok: false, error: "unknown_tool" };
        }
      },
    },
  };
}
