import type { BaseFieldAdmin } from "./feishuBase.ts";
import type { McpToolProvider } from "./mcpClient.ts";
import type { BotReply, ConversationState, IncomingMessage, RequirementStore } from "./types.ts";

export interface ConversationPolicyConfig {
  ownerId: string;
  ownerName: string;
  baseTableLabel: string;
  baseAdmin?: BaseFieldAdmin;
  mcp?: McpToolProvider;
}

function resultOk(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as Record<string, unknown>).ok === true);
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = Array.isArray((result as Record<string, unknown>).content) ? (result as Record<string, unknown>).content as unknown[] : [];
  const item = content.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).type === "text") as Record<string, unknown> | undefined;
  return typeof item?.text === "string" ? item.text.slice(0, 1_000) : "";
}

export async function resolvePendingAction(
  message: IncomingMessage,
  conversation: ConversationState,
  store: RequirementStore,
  config: ConversationPolicyConfig,
): Promise<BotReply | undefined> {
  const text = message.content.trim();
  const mcp = conversation.pendingMcpAction;
  if (mcp && /^(确认执行|执行操作|确认操作)$/.test(text)) {
    if (mcp.state === "executing") return { text: "这项操作上一次执行状态不明，已停止自动重试，请先检查飞书中的实际结果。" };
    if (mcp.requestedById !== message.senderId) {
      await store.recordAudit({ actorId: message.senderId, action: "MCP_CONFIRM", resourceId: mcp.toolName, result: "denied" }).catch(() => undefined);
      return { text: "这项飞书操作只能由发起人确认。" };
    }
    if (Date.parse(mcp.expiresAt) <= Date.now()) {
      delete conversation.pendingMcpAction;
      return { text: "这项飞书操作确认已过期，请重新发起。" };
    }
    if (!config.mcp) return { text: "MCP 服务当前不可用，没有执行操作。" };
    mcp.state = "executing";
    await store.saveConversation(conversation);
    const result = await config.mcp.callTool(mcp.toolName, mcp.argumentsJson).catch(() => ({ ok: false, error: "mcp_unavailable" }));
    const ok = resultOk(result);
    if (ok) delete conversation.pendingMcpAction;
    await store.recordAudit({ actorId: message.senderId, action: "MCP_CONFIRM", resourceId: mcp.toolName, result: ok ? "success" : "failed" }).catch(() => undefined);
    return ok
      ? { text: `飞书操作“${mcp.toolName}”已执行。${resultText(result)}`.trim() }
      : { text: `飞书操作“${mcp.toolName}”执行失败，没有将其视为完成。请检查权限、参数和资源可见范围。` };
  }
  if (mcp && /^(取消|放弃|不要执行|取消操作)$/.test(text)) {
    if (mcp.requestedById !== message.senderId) return { text: "这项飞书操作只能由发起人取消。" };
    await store.recordAudit({ actorId: message.senderId, action: "MCP_CANCEL", resourceId: mcp.toolName, result: "success" }).catch(() => undefined);
    delete conversation.pendingMcpAction;
    return { text: "已取消待确认的飞书操作。" };
  }

  const field = conversation.pendingBaseFieldDelete;
  if (field && /^(确认删除|确认执行删除|执行删除)$/.test(text)) {
    if (message.senderId !== config.ownerId || field.requestedById !== message.senderId) return { text: `这项操作只有管理员${config.ownerName}可以确认。` };
    if (Date.parse(field.expiresAt) <= Date.now()) {
      delete conversation.pendingBaseFieldDelete;
      return { text: "字段删除确认已过期，请重新发起。" };
    }
    if (!config.baseAdmin) return { text: "当前没有启用多维表格字段管理能力。" };
    try {
      await config.baseAdmin.deleteField(field.fieldId);
      delete conversation.pendingBaseFieldDelete;
      await store.recordAudit({ actorId: message.senderId, action: "DELETE_BASE_FIELD", resourceId: field.fieldId, payload: { fieldName: field.fieldName }, result: "success" }).catch(() => undefined);
      return { text: `已删除${config.baseTableLabel}字段“${field.fieldName}”。` };
    } catch {
      await store.recordAudit({ actorId: message.senderId, action: "DELETE_BASE_FIELD", resourceId: field.fieldId, payload: { fieldName: field.fieldName }, result: "failed" }).catch(() => undefined);
      return { text: `删除字段“${field.fieldName}”失败，没有将其视为完成。请检查 Base 权限和字段状态。` };
    }
  }
  if (field && /^(取消删除|取消操作|不要删除)$/.test(text)) {
    if (field.requestedById !== message.senderId) return { text: "这项字段删除只能由发起人取消。" };
    delete conversation.pendingBaseFieldDelete;
    return { text: "已取消待确认的字段删除操作。" };
  }
  return undefined;
}
