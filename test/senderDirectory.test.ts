import assert from "node:assert/strict";
import test from "node:test";
import { ConversationService } from "../src/conversation.ts";
import type { Logger } from "../src/logger.ts";
import { MessageProcessor } from "../src/messageProcessor.ts";
import type { McpToolProvider } from "../src/mcpClient.ts";
import { buildContactLookupArguments, extractMcpSenderName, McpSenderDirectory } from "../src/senderDirectory.ts";
import { InMemoryRequirementStore } from "../src/store.ts";
import type { ConversationState, IncomingMessage } from "../src/types.ts";
import type { AgentClient, AgentInput, AgentToolDefinition } from "../src/understanding.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const contactTool = (parameters: Record<string, unknown>, name = "contact_v3_user_get"): AgentToolDefinition => ({
  type: "function",
  function: { name, description: "按 open_id 查询用户", parameters },
});
const directSchema = {
  type: "object",
  properties: {
    user_id: { type: "string" },
    user_id_type: { type: "string", enum: ["open_id", "union_id", "user_id"] },
  },
  required: ["user_id"],
};
const incoming = (id = "1"): IncomingMessage => ({
  chatId: "oc_sender",
  chatType: "p2p",
  senderId: "ou_requester",
  messageId: `om_sender_${id}`,
  content: "你好",
  senderType: "user",
});

class FakeMcpProvider implements McpToolProvider {
  readonly tools: AgentToolDefinition[];
  readonly result: unknown;
  calls: Array<{ name: string; argumentsJson: string }> = [];

  constructor(result: unknown, tools = [contactTool(directSchema)]) {
    this.result = result;
    this.tools = tools;
  }

  async listTools(): Promise<AgentToolDefinition[]> { return this.tools; }
  async callTool(name: string, argumentsJson: string): Promise<unknown> {
    this.calls.push({ name, argumentsJson });
    return this.result;
  }
  async close(): Promise<void> {}
}

test("builds contact lookup arguments from direct and nested MCP schemas", () => {
  assert.deepEqual(buildContactLookupArguments(directSchema, "ou_requester"), {
    user_id: "ou_requester",
    user_id_type: "open_id",
  });
  assert.deepEqual(buildContactLookupArguments({
    type: "object",
    properties: {
      path: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] },
      params: { type: "object", properties: { userIdType: { type: "string" } } },
    },
    required: ["path"],
  }, "ou_requester"), {
    path: { userId: "ou_requester" },
    params: { userIdType: "open_id" },
  });
  assert.equal(buildContactLookupArguments({ type: "object", properties: { query: { type: "string" } } }, "ou_requester"), undefined);
});

test("extracts a verified sender name from structured and text MCP results", () => {
  assert.equal(extractMcpSenderName({
    ok: true,
    structuredContent: { data: { user: { open_id: "ou_requester", name: "张三" } } },
  }, "ou_requester"), "张三");
  assert.equal(extractMcpSenderName({
    ok: true,
    content: [{ type: "text", text: JSON.stringify({ data: { user: { openId: "ou_requester", display_name: "李四" } } }) }],
  }, "ou_requester"), "李四");
});

test("refuses a name when the returned open_id does not match", () => {
  assert.equal(extractMcpSenderName({
    ok: true,
    structuredContent: { data: { user: { open_id: "ou_other", name: "错误用户" } } },
  }, "ou_requester"), undefined);
  assert.equal(extractMcpSenderName({
    ok: true,
    structuredContent: { data: { user: { name: "没有 ID" } } },
  }, "ou_requester"), undefined);
});

test("discovers the MCP contact tool and caches successful lookups", async () => {
  const provider = new FakeMcpProvider({
    ok: true,
    structuredContent: { data: { user: { open_id: "ou_requester", name_i18n: { zh_cn: "王五" } } } },
  });
  const directory = new McpSenderDirectory(provider, silentLogger);
  const [first, concurrent] = await Promise.all([directory.enrich(incoming("1")), directory.enrich(incoming("2"))]);
  const cached = await directory.enrich(incoming("3"));

  assert.equal(first.senderName, "王五");
  assert.equal(concurrent.senderName, "王五");
  assert.equal(cached.senderName, "王五");
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(JSON.parse(provider.calls[0].argumentsJson), { user_id: "ou_requester", user_id_type: "open_id" });
});

test("leaves the message usable and negatively caches failed MCP lookups", async () => {
  const provider = new FakeMcpProvider({ ok: false, error: "permission_denied" });
  const directory = new McpSenderDirectory(provider, silentLogger);
  assert.equal((await directory.enrich(incoming("4"))).senderName, undefined);
  assert.equal((await directory.enrich(incoming("5"))).senderName, undefined);
  assert.equal(provider.calls.length, 1);
});

test("passes the MCP-enriched sender name to the conversation agent", async () => {
  let agentInput: AgentInput | undefined;
  const agent: AgentClient = {
    async run(input) {
      agentInput = input;
      return { usedTools: false, text: `你好，${input.senderName}` };
    },
  };
  const provider = new FakeMcpProvider({
    ok: true,
    content: [{ type: "text", text: JSON.stringify({ data: { user: { open_id: "ou_requester", name: "赵六" } } }) }],
  }, [contactTool(directSchema, "get-user")]);
  const directory = new McpSenderDirectory(provider, silentLogger);
  const store = new InMemoryRequirementStore();
  const processor = new MessageProcessor(store, new ConversationService(store, {
    ownerId: "ou_owner",
    ownerName: "韩飞龙",
    agent,
  }), {
    allowedTenantKeys: new Set(),
    allowedUserIds: new Set(),
    allowedChatIds: new Set(),
    groupRequireMention: false,
  }, silentLogger, directory);

  assert.equal((await processor.process(incoming("6"))).text, "你好，赵六");
  assert.equal(agentInput?.senderName, "赵六");
  assert.equal((await store.getConversation("oc_sender:ou_requester:main"))?.senderName, "赵六");
});

test("backfills sender names into an existing conversation and draft", async () => {
  const store = new InMemoryRequirementStore();
  const existing: ConversationState = {
    key: "oc_sender:ou_requester:main",
    chatId: "oc_sender",
    senderId: "ou_requester",
    draft: {
      id: "DRAFT-old",
      conversationKey: "oc_sender:ou_requester:main",
      requesterId: "ou_requester",
      title: "旧需求",
      state: "collecting",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    recentMessages: [],
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  await store.saveConversation(existing);
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });

  await service.handleMessage({ ...incoming("7"), senderName: "陈七", content: "补充一下范围" });
  const saved = await store.getConversation(existing.key);
  assert.equal(saved?.senderName, "陈七");
  assert.equal(saved?.draft?.requesterName, "陈七");
});
