import assert from "node:assert/strict";
import test from "node:test";
import { ConversationService } from "../src/conversation.ts";
import { InMemoryRequirementStore } from "../src/store.ts";
import type { AgentClient } from "../src/understanding.ts";

const message = (content: string, id: string, senderId = "ou_requester") => ({ chatId: "oc_demo", senderId, messageId: `om_${id}`, content, senderType: "user" as const });

test("clarifies a requirement and only creates it after confirmation", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });

  assert.match((await service.handleMessage(message("我想做一个 Meta 看板", "1"))).text, /解决什么问题/);
  assert.match((await service.handleMessage(message("目标是看每天的消耗和回收", "2"))).text, /明确范围/);
  assert.match((await service.handleMessage(message("包含游戏、国家和账户，显示 D0 ROAS", "3"))).text, /验收标准/);
  assert.match((await service.handleMessage(message("验收时能按这三个维度筛选并看到 D0 ROAS", "4"))).text, /确认提交/);
  assert.equal((await store.listRequirements()).length, 0);
  assert.match((await service.handleMessage(message("确认提交", "5"))).text, /已记录需求 REQ-/);
  assert.equal((await store.listRequirements()).length, 1);
});

test("answers current work and requester requirements", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  await store.createRequirement({ title: "APP 营收核对", goal: "核对数据", scope: "APP 营收", acceptanceCriteria: "区间数一致", requesterId: "ou_requester", platforms: ["AppsFlyer"], status: "进行中", ownerId: "ou_owner", ownerName: "韩飞龙", progress: "正在核对内购和广告变现", visibility: "public", sourceChatId: "oc_demo", sourceMessageId: "om_source" });
  assert.match((await service.handleMessage(message("你现在在做什么", "6"))).text, /APP 营收核对/);
  assert.match((await service.handleMessage(message("我的需求", "7"))).text, /APP 营收核对/);
});

test("filters current work by requirement visibility", async () => {
  const store = new InMemoryRequirementStore();
  const requirement = (title: string, requesterId: string, visibility: "public" | "requester" | "private", sourceMessageId: string) => store.createRequirement({
    title, goal: "目标", scope: "范围", acceptanceCriteria: "验收", requesterId, platforms: [], status: "进行中" as const,
    ownerId: "ou_owner", ownerName: "韩飞龙", progress: "处理中", visibility, sourceChatId: "oc_demo", sourceMessageId,
  });
  await requirement("公开需求", "ou_other", "public", "om_public");
  await requirement("仅提出人需求", "ou_viewer", "requester", "om_requester");
  await requirement("其他提出人需求", "ou_other", "requester", "om_other");
  await requirement("管理员私密需求", "ou_viewer", "private", "om_private");
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });

  const viewerReply = (await service.handleMessage(message("你现在在做什么", "visibility-1", "ou_viewer"))).text;
  assert.match(viewerReply, /公开需求/);
  assert.match(viewerReply, /仅提出人需求/);
  assert.doesNotMatch(viewerReply, /其他提出人需求|管理员私密需求/);
  const ownerReply = (await service.handleMessage(message("你现在在做什么", "visibility-2", "ou_owner"))).text;
  assert.match(ownerReply, /公开需求/);
  assert.match(ownerReply, /仅提出人需求/);
  assert.match(ownerReply, /其他提出人需求/);
  assert.match(ownerReply, /管理员私密需求/);
});

test("applies visibility filtering inside the agent current-work tool", async () => {
  const store = new InMemoryRequirementStore();
  await store.createRequirement({ title: "公开事项", goal: "目标", scope: "范围", acceptanceCriteria: "验收", requesterId: "ou_other", platforms: [], status: "进行中", ownerId: "ou_owner", visibility: "public", sourceChatId: "oc_demo", sourceMessageId: "om_visible" });
  await store.createRequirement({ title: "机密事项", goal: "目标", scope: "范围", acceptanceCriteria: "验收", requesterId: "ou_other", platforms: [], status: "进行中", ownerId: "ou_owner", visibility: "private", sourceChatId: "oc_demo", sourceMessageId: "om_private" });
  let toolResult: unknown;
  const agent: AgentClient = {
    async run(_input, _definitions, executor) {
      toolResult = await executor.execute("list_current_work", "{}");
      return { usedTools: true, text: "已查询" };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent });
  await service.handleMessage(message("你现在在做什么", "visibility-agent", "ou_viewer"));
  assert.deepEqual((toolResult as { items: Array<{ title: string }> }).items.map((item) => item.title), ["公开事项"]);
});

test("treats a concise new requirement as a draft and normalizes AppsFlyer aliases", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  const reply = await service.handleMessage(message("接下来新增一个需求，appflyer push 地址更换，帮我记一下", "6b"));
  assert.match(reply.text, /我先记下需求/);
  assert.match(reply.text, /appflyer push 地址更换/);
  assert.match(reply.text, /解决什么问题/);
  const state = await store.getConversation("oc_demo:ou_requester:main");
  assert.deepEqual(state?.draft?.platforms, ["AppsFlyer"]);
});

test("does not confuse a new requirement containing 地址 with the Base link query", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", baseUrl: "https://feishu.cn/base/demo" });
  const reply = await service.handleMessage(message("新增需求：替换 AppsFlyer push 地址", "6c"));
  assert.match(reply.text, /我先记下需求/);
  assert.doesNotMatch(reply.text, /多维表格地址/);
});

test("lets the agent own requirement conversation and persistence through tools", async () => {
  const store = new InMemoryRequirementStore();
  const agent: AgentClient = {
    async run(input, definitions, executor) {
      assert.ok(definitions.some((item) => item.function.name === "save_requirement_draft"));
      assert.ok(definitions.some((item) => item.function.name === "submit_requirement"));
      if (input.message === "我想换 AppsFlyer push 地址") {
        const result = await executor.execute("save_requirement_draft", JSON.stringify({ title: "AppsFlyer push 地址更换", goal: "恢复渠道回传", scope: "AppsFlyer push 配置", acceptanceCriteria: "新地址生效并完成回传验证" }));
        assert.equal((result as Record<string, unknown>).ok, true);
        return { usedTools: true, text: "已记录 AppsFlyer push 地址更换。请补充需要解决的业务目标。" };
      }
      const result = await executor.execute("submit_requirement", "{}");
      assert.equal((result as Record<string, unknown>).ok, true);
      return { usedTools: true, text: `已提交需求 ${(result as Record<string, unknown>).requirementId}` };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent });
  assert.match((await service.handleMessage(message("我想换 AppsFlyer push 地址", "6d"))).text, /已记录 AppsFlyer/);
  assert.match((await service.handleMessage(message("确认提交", "6e"))).text, /已提交需求 REQ-/);
  assert.equal((await store.listRequirements()).length, 1);
});

test("does not trust the agent when a Feishu Base tool fails", async () => {
  const store = new InMemoryRequirementStore();
  const mcp = {
    async listTools() {
      return [{ type: "function" as const, function: { name: "bitable_v1_appTableRecord_search", description: "查询 Base 记录", parameters: { type: "object", properties: {} } } }];
    },
    async callTool() { return { ok: false, error: "permission_denied" }; },
    async close() {},
  };
  const agent: AgentClient = {
    async run(_input, definitions, executor) {
      assert.ok(definitions.some((item) => item.function.name === "find_feishu_tools"));
      assert.ok(definitions.some((item) => item.function.name === "call_feishu_tool"));
      const found = await executor.execute("find_feishu_tools", JSON.stringify({ query: "Base 记录 search" }));
      assert.equal((found as Record<string, unknown>).ok, true);
      await executor.execute("call_feishu_tool", JSON.stringify({ toolName: "bitable_v1_appTableRecord_search", arguments: {} }));
      return { usedTools: true, text: "已成功查询多维表格。" };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent, mcp });
  const reply = (await service.handleMessage(message("查询多维表格记录", "6f"))).text;
  assert.match(reply, /bitable_v1_appTableRecord_search/);
  assert.match(reply, /permission_denied/);
  assert.match(reply, /应用权限/);
  assert.doesNotMatch(reply, /已成功查询/);
});

test("reports MCP response details and does not mask a preceding successful tool", async () => {
  const store = new InMemoryRequirementStore();
  const mcp = {
    async listTools() {
      return [{ type: "function" as const, function: { name: "docx_v1_document_get", description: "读取文档", parameters: { type: "object", properties: {} } } }];
    },
    async callTool() { return { ok: false, error: "mcp_tool_failed", detail: "code=99991672 forbidden scope docx:document:readonly access_token=t-secret" }; },
    async close() {},
  };
  const agent: AgentClient = {
    async run(_input, _definitions, executor) {
      await executor.execute("get_administrator", "{}");
      await executor.execute("call_feishu_tool", JSON.stringify({ toolName: "docx_v1_document_get", arguments: {} }));
      return { usedTools: true, text: "已经读取成功" };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent, mcp });
  const reply = (await service.handleMessage(message("读取文档", "6g"))).text;
  assert.match(reply, /^部分工具调用已成功/);
  assert.match(reply, /99991672/);
  assert.match(reply, /docx:document:readonly/);
  assert.doesNotMatch(reply, /t-secret/);
});

test("does not echo bot messages", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  assert.equal((await service.handleMessage({ ...message("hello", "8"), senderType: "bot" })).text, "");
});

test("reports the configured administrator and protects Base field deletion", async () => {
  const store = new InMemoryRequirementStore();
  const deleted: string[] = [];
  const baseAdmin = {
    async listFields() { return [
      { fieldId: "fld_owner", name: "负责人" },
      { fieldId: "fld_title", name: "需求标题", isPrimary: true },
    ]; },
    async deleteField(fieldId: string) { deleted.push(fieldId); },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", baseAdmin, baseTableLabel: "需求表" });

  assert.match((await service.handleMessage(message("谁是管理员", "9"))).text, /韩飞龙（ou_owner）/);
  assert.match((await service.handleMessage(message("删除需求表的列：负责人", "10", "ou_requester"))).text, /只有管理员/);
  assert.match((await service.handleMessage(message("删除需求表的列：负责人", "11", "ou_owner"))).text, /确认删除/);
  assert.deepEqual(deleted, []);
  assert.match((await service.handleMessage(message("确认删除", "12", "ou_owner"))).text, /已删除需求表中的列“负责人”/);
  assert.deepEqual(deleted, ["fld_owner"]);
});

test("does not allow deletion of the Base primary field", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, {
    ownerId: "ou_owner", ownerName: "韩飞龙",
    baseAdmin: {
      async listFields() { return [{ fieldId: "fld_title", name: "需求标题", isPrimary: true }]; },
      async deleteField() { assert.fail("primary field must not be deleted"); },
    },
  });
  assert.match((await service.handleMessage(message("删除多维表格的列：需求标题", "13", "ou_owner"))).text, /主字段，不能删除/);
});

test("recognizes natural-language field deletion requests when the verb follows the column", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, {
    ownerId: "ou_owner", ownerName: "韩飞龙",
    baseAdmin: {
      async listFields() { return [{ fieldId: "fld_owner", name: "负责人" }]; },
      async deleteField() {},
    },
  });
  assert.match((await service.handleMessage(message("我要把多维表格模板的列进行删除", "14", "ou_owner"))).text, /请告诉我要删除的具体列名/);
  assert.match((await service.handleMessage(message("把负责人列删除", "15", "ou_owner"))).text, /确认删除/);
});

test("lets the configured agent answer the Base link query through a tool", async () => {
  const store = new InMemoryRequirementStore();
  const agent: AgentClient = {
    async run(input, definitions, executor) {
      assert.equal(input.message, "需求多维表格的地址是什么？");
      assert.ok(definitions.some((item) => item.function.name === "get_requirement_table_link"));
      const result = await executor.execute("get_requirement_table_link", "{}");
      assert.deepEqual(result, { ok: true, label: "需求表", url: "https://feishu.cn/base/demo" });
      return { usedTools: true, text: "需求表地址：https://feishu.cn/base/demo" };
    },
  };
  const service = new ConversationService(store, {
    ownerId: "ou_owner", ownerName: "韩飞龙", baseTableLabel: "需求表", baseUrl: "https://feishu.cn/base/demo", agent,
  });
  assert.equal((await service.handleMessage(message("需求多维表格的地址是什么？", "16"))).text, "需求表地址：https://feishu.cn/base/demo");
});

function mcpFixture() {
  let calls = 0;
  const mcp = {
    async listTools() {
      return [{
        type: "function" as const,
        function: {
          name: "create-doc",
          description: "创建飞书文档",
          parameters: { type: "object", properties: { title: { type: "string" } } },
        },
      }];
    },
    async callTool() {
      calls += 1;
      return { ok: true, content: [{ type: "text", text: "docxcn_demo" }] };
    },
    async close() {},
    get calls() { return calls; },
  };
  const agent: AgentClient = {
    async run(_input, definitions, executor) {
      assert.ok(definitions.some((item) => item.function.name === "find_feishu_tools"));
      assert.ok(definitions.some((item) => item.function.name === "call_feishu_tool"));
      assert.ok(!definitions.some((item) => item.function.name === "create-doc"));
      const search = await executor.execute("find_feishu_tools", JSON.stringify({ query: "创建 飞书 文档 create doc" }));
      assert.equal((search as Record<string, unknown>).ok, true);
      const result = await executor.execute("call_feishu_tool", JSON.stringify({ toolName: "create-doc", arguments: { title: "周报" } }));
      return { usedTools: true, text: result && typeof result === "object" && (result as Record<string, unknown>).confirmationRequired ? "文档已创建" : "已处理" };
    },
  };
  return { mcp, agent };
}

test("holds MCP mutations for requester confirmation and executes once", async () => {
  const store = new InMemoryRequirementStore();
  const { mcp, agent } = mcpFixture();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent, mcp });
  assert.match((await service.handleMessage(message("请创建一篇周报文档", "17"))).text, /核对请求后回复“确认执行”/);
  assert.equal(mcp.calls, 0);
  assert.match((await service.handleMessage(message("确认执行", "18"))).text, /已执行飞书操作“create-doc”/);
  assert.equal(mcp.calls, 1);
  assert.equal((await store.getConversation("oc_demo:ou_requester:main"))?.pendingMcpAction, undefined);
});

test("rejects MCP confirmation from another group member and supports cancellation", async () => {
  const store = new InMemoryRequirementStore();
  const { mcp, agent } = mcpFixture();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent, mcp });
  const groupMessage = (content: string, id: string, senderId: string) => ({ ...message(content, id, senderId), chatType: "group" as const });
  await service.handleMessage(groupMessage("请创建一篇周报文档", "20", "ou_requester"));
  assert.equal((await service.handleMessage(groupMessage("确认执行", "21", "ou_other"))).text, "这项飞书操作只能由发起人确认。");
  assert.equal(mcp.calls, 0);
  assert.equal((await service.handleMessage(groupMessage("取消操作", "21b", "ou_other"))).text, "这项飞书操作只能由发起人取消。");
  assert.equal((await service.handleMessage(groupMessage("取消操作", "22", "ou_requester"))).text, "已取消待确认的飞书操作。");
  assert.equal(mcp.calls, 0);
});

test("falls back to deterministic submission when the agent is unavailable", async () => {
  const store = new InMemoryRequirementStore();
  let agentCalls = 0;
  const service = new ConversationService(store, {
    ownerId: "ou_owner", ownerName: "韩飞龙",
    agent: { async run() { agentCalls += 1; throw new Error("agent must not run for confirmation"); } },
  });
  await store.saveConversation({
    key: "oc_demo:ou_requester:main", chatId: "oc_demo", senderId: "ou_requester", recentMessages: [], updatedAt: new Date().toISOString(),
    draft: {
      id: "DRAFT-1", conversationKey: "oc_demo:ou_requester:main", requesterId: "ou_requester", title: "Meta 看板",
      goal: "核对消耗", scope: "游戏和国家", acceptanceCriteria: "看到 D0 ROAS", state: "awaiting_confirmation",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  });
  assert.match((await service.handleMessage(message("确认提交", "29"))).text, /已记录需求 REQ-/);
  assert.equal(agentCalls, 1);
});

test("does not let another group member edit or submit a requirement draft", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  const groupMessage = (content: string, id: string, senderId: string) => ({ ...message(content, id, senderId), chatType: "group" as const });
  await service.handleMessage(groupMessage("我想做一个 Meta 看板", "25", "ou_requester"));
  assert.match((await service.handleMessage(groupMessage("目标是核对消耗", "26", "ou_other"))).text, /只有发起人/);
  assert.match((await service.handleMessage(groupMessage("确认提交", "27", "ou_other"))).text, /只有发起人/);
  assert.equal((await store.listRequirements()).length, 0);
  assert.match((await service.handleMessage(groupMessage("取消当前需求", "28", "ou_other"))).text, /只有发起人/);
});

test("enforces draft ownership inside the agent save tool", async () => {
  const store = new InMemoryRequirementStore();
  const groupKey = "oc_demo:main";
  await store.saveConversation({
    key: groupKey, chatId: "oc_demo", senderId: "ou_requester", recentMessages: [], updatedAt: new Date().toISOString(),
    draft: { id: "DRAFT-owned", conversationKey: groupKey, requesterId: "ou_requester", requesterName: "甲", title: "甲的需求", state: "collecting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  });
  let toolResult: unknown;
  const agent: AgentClient = {
    async run(_input, _definitions, executor) {
      toolResult = await executor.execute("save_requirement_draft", JSON.stringify({ title: "被覆盖的需求" }));
      return { usedTools: true, text: "已覆盖" };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent });
  await service.handleMessage({ ...message("当前工作是什么，同时记录这个需求", "owner-tool", "ou_other"), chatType: "group" });

  assert.deepEqual(toolResult, { ok: false, error: "draft_owned_by_other" });
  assert.equal((await store.getConversation(groupKey))?.draft?.requesterId, "ou_requester");
  assert.equal((await store.getConversation(groupKey))?.draft?.title, "甲的需求");
});

test("keeps an existing requester name when enrichment is temporarily unavailable", async () => {
  const store = new InMemoryRequirementStore();
  const key = "oc_demo:ou_requester:main";
  await store.saveConversation({
    key, chatId: "oc_demo", senderId: "ou_requester", senderName: "甲", recentMessages: [], updatedAt: new Date().toISOString(),
    draft: { id: "DRAFT-name", conversationKey: key, requesterId: "ou_requester", requesterName: "甲", title: "已有需求", state: "collecting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  });
  const agent: AgentClient = {
    async run(_input, _definitions, executor) {
      await executor.execute("save_requirement_draft", JSON.stringify({ scope: "补充范围" }));
      return { usedTools: true, text: "已补充" };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent });
  await service.handleMessage(message("补充范围", "keep-name"));
  assert.equal((await store.getConversation(key))?.draft?.requesterName, "甲");
});

test("expires an MCP confirmation without calling the remote tool", async () => {
  const store = new InMemoryRequirementStore();
  const { mcp, agent } = mcpFixture();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent, mcp });
  await service.handleMessage(message("请创建一篇周报文档", "23"));
  const conversation = await store.getConversation("oc_demo:ou_requester:main");
  assert.ok(conversation?.pendingMcpAction);
  conversation!.pendingMcpAction!.expiresAt = new Date(Date.now() - 1).toISOString();
  await store.saveConversation(conversation!);
  assert.equal((await service.handleMessage(message("确认执行", "24"))).text, "这条飞书操作确认已过期，请重新发起操作。");
  assert.equal(mcp.calls, 0);
  assert.equal((await store.getConversation("oc_demo:ou_requester:main"))?.pendingMcpAction, undefined);
});
