import type { BaseFieldAdmin } from "./feishuBase.ts";
import type { AgentToolDefinition, AgentToolExecutor } from "./understanding.ts";
import type { IncomingMessage, RequirementStore } from "./types.ts";

export interface AgentToolContext {
  message: IncomingMessage;
  store: RequirementStore;
  ownerId: string;
  ownerName: string;
  baseTableLabel: string;
  baseUrl?: string;
  baseAdmin?: BaseFieldAdmin;
}

export interface AgentToolRuntime {
  definitions: AgentToolDefinition[];
  executor: AgentToolExecutor;
}

const definitions: AgentToolDefinition[] = [
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
];

export function createAgentToolRuntime(context: AgentToolContext): AgentToolRuntime {
  return {
    definitions,
    executor: {
      async execute(name, argumentsJson) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(argumentsJson || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          return { ok: false, error: "invalid_tool_arguments" };
        }
        if (Object.keys(args).length) return { ok: false, error: "tool_arguments_not_allowed" };
        switch (name) {
          case "get_requirement_table_link":
            return context.baseUrl
              ? { ok: true, label: context.baseTableLabel, url: context.baseUrl }
              : { ok: false, error: "requirement_table_url_not_configured", setup: "设置 FEISHU_BASE_URL 后重启服务" };
          case "get_administrator":
            return { ok: true, name: context.ownerName, openId: context.ownerId || null };
          case "list_current_work": {
            const items = (await context.store.listRequirements({ status: "进行中" })).filter((item) => item.ownerId === context.ownerId).slice(0, 10);
            return { ok: true, items: items.map((item) => ({ id: item.id, title: item.title, progress: item.progress || null, status: item.status })) };
          }
          case "list_my_requirements": {
            const items = (await context.store.listRequirements({ requesterId: context.message.senderId })).slice(0, 20);
            return { ok: true, items: items.map((item) => ({ id: item.id, title: item.title, status: item.status, desiredDate: item.desiredDate || null })) };
          }
          case "list_base_fields":
            if (!context.baseAdmin) return { ok: false, error: "base_admin_not_enabled", setup: "设置 BASE_ADMIN_ENABLED=true 后重启服务" };
            return { ok: true, fields: (await context.baseAdmin.listFields()).slice(0, 200).map((field) => ({ id: field.fieldId, name: field.name, type: field.type || null, isPrimary: field.isPrimary === true })) };
          default:
            return { ok: false, error: "unknown_tool" };
        }
      },
    },
  };
}
