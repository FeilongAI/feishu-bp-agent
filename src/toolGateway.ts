import { createAgentToolRuntime } from "./agentTools.ts";
import { redact } from "./logger.ts";
import { isMcpMutationTool, type McpToolProvider } from "./mcpClient.ts";
import type { AgentResult, AgentToolDefinition, AgentToolExecutor } from "./agent.ts";
import type { BaseFieldAdmin } from "./feishuBase.ts";
import type { ConversationState, IncomingMessage, RequirementStore } from "./types.ts";

const FIND_FEISHU_TOOLS = "find_feishu_tools";
const CALL_FEISHU_TOOL = "call_feishu_tool";

const brokerDefinitions: AgentToolDefinition[] = [
  {
    type: "function",
    function: {
      name: FIND_FEISHU_TOOLS,
      description: "搜索当前飞书 MCP 提供的完整工具目录。需要操作文档、多维表格、消息、日历、任务或通讯录时先调用，结果包含真实工具名和参数结构。",
      parameters: {
        type: "object", additionalProperties: false, required: ["query"],
        properties: {
          query: { type: "string", description: "使用中文业务词和英文 API 关键词描述需要的能力" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: CALL_FEISHU_TOOL,
      description: "调用 find_feishu_tools 返回的飞书工具。写操作会被服务拦截并要求用户确认。",
      parameters: {
        type: "object", additionalProperties: false, required: ["toolName", "arguments"],
        properties: {
          toolName: { type: "string" },
          arguments: { type: "object" },
        },
      },
    },
  },
];

type ToolSource = "internal" | "feishu";

interface ToolFailure {
  toolName: string;
  error: string;
  detail?: string;
  source: ToolSource;
}

export interface ToolSessionContext {
  message: IncomingMessage;
  conversation: ConversationState;
  conversationKey: string;
  store: RequirementStore;
  ownerId: string;
  ownerName: string;
  baseTableLabel: string;
  baseUrl?: string;
  baseAdmin?: BaseFieldAdmin;
  mcp?: McpToolProvider;
}

export interface ToolSession {
  definitions: AgentToolDefinition[];
  executor: AgentToolExecutor;
  finish(result: AgentResult | undefined): string;
}

const EXPECTED_INTERNAL_ERRORS = new Set([
  "explicit_cancellation_required", "explicit_confirmation_required", "no_owned_requirement_draft",
  "requirement_fields_missing", "draft_owned_by_other", "requirement_table_url_not_configured",
  "base_admin_not_enabled", "admin_only", "field_name_required", "field_not_found",
  "ambiguous_field", "primary_field_cannot_be_deleted", "base_confirmation_already_pending",
]);

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseArguments(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function searchTools(tools: AgentToolDefinition[], query: string, limit: number) {
  const normalized = query.toLowerCase().trim();
  const terms = normalized.split(/[\s,，、/]+/).filter((term) => term.length > 1);
  return tools
    .map((tool, index) => {
      const name = tool.function.name.toLowerCase();
      const description = tool.function.description.toLowerCase();
      const searchable = `${name} ${description}`;
      let score = normalized && searchable.includes(normalized) ? 100 : 0;
      for (const term of terms) {
        if (name === term) score += 80;
        else if (name.includes(term)) score += 20;
        if (description.includes(term)) score += 8;
      }
      return { definition: tool.function, score, index };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((item) => item.definition);
}

function toFailure(name: string, result: unknown, source: ToolSource): ToolFailure | undefined {
  const record = objectValue(result);
  if (record.ok === true) return undefined;
  const error = typeof record.error === "string" && record.error.trim() ? record.error.trim().slice(0, 160) : "tool_failed";
  const rawDetail = typeof record.detail === "string" ? record.detail : typeof record.setup === "string" ? record.setup : undefined;
  const detail = rawDetail?.trim() ? String(redact(rawDetail)).replace(/\s+/g, " ").trim().slice(0, 500) : undefined;
  return { toolName: name, error, detail, source };
}

function internalFailureText(failure: ToolFailure): string {
  const messages: Record<string, string> = {
    explicit_cancellation_required: "我没有清除当前需求草稿。只有你明确要求取消、放弃或清空当前需求时才会清除；如果只是修改，请直接说明要改什么。",
    explicit_confirmation_required: "我没有提交需求。请核对内容后明确回复“确认提交”。",
    no_owned_requirement_draft: "当前没有由你发起、可以操作的需求草稿。",
    requirement_fields_missing: "需求草稿仍缺少业务目标、范围或验收标准，我没有提交。",
    draft_owned_by_other: "当前群聊草稿由其他成员发起，只有发起人可以修改、取消或提交。",
    requirement_table_url_not_configured: "当前没有配置需求多维表格地址。",
    base_admin_not_enabled: "当前没有启用多维表格字段管理能力。",
    admin_only: "这项操作只有管理员可以执行。",
    field_name_required: "请提供具体字段名称。",
    field_not_found: "没有找到指定字段，请检查字段名称。",
    ambiguous_field: "存在多个同名字段，请提供字段 ID。",
    primary_field_cannot_be_deleted: "该字段是多维表格主字段，不能删除。",
    base_confirmation_already_pending: "已有一项字段删除操作等待确认，请先确认或取消。",
  };
  return messages[failure.error] || `内部工具“${failure.toolName}”未完成：${failure.error}${failure.detail ? `（${failure.detail}）` : ""}。`;
}

function feishuFailureText(failure: ToolFailure, partialSuccess: boolean): string {
  const raw = `${failure.error} ${failure.detail || ""}`.toLowerCase();
  let advice = "请检查工具参数和资源标识后重试。";
  if (/permission|forbidden|unauthorized|scope|999916/.test(raw)) advice = "请检查应用权限、已发布版本和资源可见范围。";
  else if (/unavailable|timeout|connect|transport|network/.test(raw)) advice = "请检查 MCP 服务和网络状态后重试。";
  else if (/not_found|not found|unknown tool/.test(raw)) advice = "请重新搜索工具，并确认 MCP 已加载对应 API。";
  const detail = failure.detail && failure.detail !== failure.error ? `；飞书返回：${failure.detail}` : "";
  return `${partialSuccess ? "部分工具调用成功，但" : ""}调用飞书工具“${failure.toolName}”失败：${failure.error}${detail}。失败部分未视为完成。${advice}`;
}

function modelHandledExpectedFailure(failures: ToolFailure[], text: string | undefined): boolean {
  if (!text?.trim() || !failures.length) return false;
  if (!failures.every((failure) => failure.source === "internal" && EXPECTED_INTERNAL_ERRORS.has(failure.error))) return false;
  if (/(?:已|已经|成功).{0,12}(?:清除|取消|提交|删除|创建|更新|保存|完成|处理)|(?:清除|取消|提交|删除|创建|更新|保存).{0,8}(?:成功|完成)/.test(text)) return false;
  const acknowledgements: Record<string, RegExp> = {
    explicit_cancellation_required: /(取消|放弃|清空|清除).*(明确|需要|才能|才会|没有|尚未|不能)|(?:明确|需要|没有|尚未|不能).*(取消|放弃|清空|清除)/,
    explicit_confirmation_required: /(确认|提交).*(明确|需要|才能|没有|尚未|不能)|(?:明确|需要|没有|尚未|不能).*(确认|提交)/,
    no_owned_requirement_draft: /(没有|找不到|不存在).*(草稿|需求)/,
    requirement_fields_missing: /(缺少|补充|不完整).*(目标|范围|验收|信息)/,
    draft_owned_by_other: /(其他成员|发起人|所有者|本人)/,
    requirement_table_url_not_configured: /(没有|尚未|未).*(配置|地址|链接)/,
    base_admin_not_enabled: /(没有|尚未|未).*(启用|字段管理)/,
    admin_only: /(管理员|没有权限|无权)/,
    field_name_required: /(字段|列).*(名称|名字|具体)/,
    field_not_found: /(没有找到|找不到|不存在).*(字段|列)/,
    ambiguous_field: /(多个|同名|字段 ID)/,
    primary_field_cannot_be_deleted: /(主字段|不能删除|无法删除)/,
    base_confirmation_already_pending: /(等待确认|先确认|先取消)/,
  };
  return failures.every((failure) => acknowledgements[failure.error]?.test(text) === true);
}

export async function createToolSession(context: ToolSessionContext): Promise<ToolSession> {
  const internal = createAgentToolRuntime(context);
  let discoveryError: string | undefined;
  const discovered = context.mcp
    ? await context.mcp.listTools().catch((error) => {
      discoveryError = error instanceof Error ? error.message.slice(0, 300) : "mcp_tool_discovery_failed";
      return [];
    })
    : [];
  const mcpTools = new Map(discovered.map((tool) => [tool.function.name, tool]));
  const definitions = [...internal.definitions, ...(context.mcp ? brokerDefinitions : [])];
  const failures: ToolFailure[] = [];
  let successfulCalls = 0;
  let mcpConflict = false;
  let mcpDenied = false;
  const initialMcpAction = context.conversation.pendingMcpAction;
  const initialFieldDelete = context.conversation.pendingBaseFieldDelete;

  const record = (name: string, result: unknown, source: ToolSource, countSuccess = true) => {
    const failure = toFailure(name, result, source);
    if (failure) failures.push(failure);
    else if (countSuccess) successfulCalls += 1;
    return result;
  };

  const executor: AgentToolExecutor = {
    execute: async (name, argumentsJson) => {
      if (name === FIND_FEISHU_TOOLS) {
        const args = parseArguments(argumentsJson);
        if (!args) return record(name, { ok: false, error: "invalid_tool_arguments", detail: "参数必须是 JSON 对象" }, "feishu", false);
        if (discoveryError) return record(name, { ok: false, error: "mcp_tool_discovery_failed", detail: discoveryError }, "feishu", false);
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return record(name, { ok: false, error: "invalid_tool_arguments", detail: "query 不能为空" }, "feishu", false);
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.min(Math.trunc(args.limit), 20)) : 10;
        return record(name, { ok: true, totalAvailable: discovered.length, matches: searchTools(discovered, query, limit) }, "feishu", false);
      }

      let targetName: string | undefined;
      let targetArguments = argumentsJson;
      if (name === CALL_FEISHU_TOOL) {
        const args = parseArguments(argumentsJson);
        if (!args) return record(name, { ok: false, error: "invalid_tool_arguments" }, "feishu");
        targetName = typeof args.toolName === "string" ? args.toolName.trim() : "";
        if (!targetName || !mcpTools.has(targetName)) return record(targetName || name, { ok: false, error: "mcp_tool_not_found" }, "feishu");
        targetArguments = JSON.stringify(objectValue(args.arguments));
      } else if (mcpTools.has(name)) {
        targetName = name;
      }

      if (targetName) {
        if (isMcpMutationTool(targetName)) {
          const pending = context.conversation.pendingMcpAction;
          if (pending?.requestedById !== undefined && pending.requestedById !== context.message.senderId) {
            mcpDenied = true;
            return { ok: false, error: "mcp_confirmation_owned_by_other" };
          }
          if (pending) {
            mcpConflict = true;
            return { ok: false, error: "mcp_confirmation_already_pending" };
          }
          context.conversation.pendingMcpAction = {
            toolName: targetName, argumentsJson: targetArguments.slice(0, 20_000), requestedById: context.message.senderId,
            requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), state: "pending",
          };
          await context.store.saveConversation(context.conversation);
          return { ok: false, confirmationRequired: true, toolName: targetName, expiresInMinutes: 10 };
        }
        try {
          return record(targetName, await context.mcp!.callTool(targetName, targetArguments), "feishu");
        } catch (error) {
          return record(targetName, { ok: false, error: "mcp_unavailable", detail: error instanceof Error ? error.message.slice(0, 300) : undefined }, "feishu");
        }
      }

      try {
        return record(name, await internal.executor.execute(name, argumentsJson), "internal");
      } catch (error) {
        return record(name, { ok: false, error: "tool_unavailable", detail: error instanceof Error ? error.message.slice(0, 300) : undefined }, "internal");
      }
    },
  };

  return {
    definitions,
    executor,
    finish(result) {
      if (mcpConflict) return "已有一项飞书写操作等待确认，请先确认或取消当前操作。";
      if (mcpDenied) return "当前有其他成员发起的飞书操作待确认，只有发起人可以确认或取消。";
      const pendingMcp = context.conversation.pendingMcpAction;
      if (pendingMcp && pendingMcp !== initialMcpAction) {
        return `准备执行飞书写操作“${pendingMcp.toolName}”。请核对后回复“确认执行”，或回复“取消操作”。`;
      }
      const pendingDelete = context.conversation.pendingBaseFieldDelete;
      if (pendingDelete && pendingDelete !== initialFieldDelete) {
        return `准备删除${context.baseTableLabel}字段“${pendingDelete.fieldName}”（${pendingDelete.fieldId}）。该操作可能无法恢复，请回复“确认删除”或“取消删除”。`;
      }
      if (failures.length) {
        if (modelHandledExpectedFailure(failures, result?.text)) return result!.text!;
        const failure = failures[failures.length - 1];
        return failure.source === "internal" ? internalFailureText(failure) : feishuFailureText(failure, successfulCalls > 0);
      }
      return result?.text?.trim() || "我没有生成有效回复，请重新描述你的需求。";
    },
  };
}
