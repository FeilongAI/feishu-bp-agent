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
      assert.ok(definitions.some((item) => item.function.name === "create-doc"));
      const result = await executor.execute("create-doc", JSON.stringify({ title: "周报" }));
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
  assert.equal((await service.handleMessage(groupMessage("取消操作", "22", "ou_requester"))).text, "已取消待确认的飞书操作。");
  assert.equal(mcp.calls, 0);
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
