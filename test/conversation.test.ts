import assert from "node:assert/strict";
import test from "node:test";
import { ConversationService } from "../src/conversation.ts";
import { InMemoryRequirementStore } from "../src/store.ts";
import type { AgentClient } from "../src/agent.ts";

const message = (content: string, id: string, senderId = "ou_requester") => ({
  chatId: "oc_demo", senderId, messageId: `om_${id}`, content, senderType: "user" as const,
});

test("v2 lets the model own multi-turn requirement clarification and persistence", async () => {
  const store = new InMemoryRequirementStore();
  let turns = 0;
  const agent: AgentClient = {
    async run(input, definitions, executor) {
      turns += 1;
      assert.ok(definitions.some((item) => item.function.name === "save_requirement_draft"));
      if (turns === 1) {
        assert.equal(input.message, "新增 AppsFlyer push 地址更换需求");
        await executor.execute("save_requirement_draft", JSON.stringify({ title: "AppsFlyer push 地址更换", platforms: ["AppsFlyer"] }));
        return { usedTools: true, text: "我记下了标题。这个改动主要要解决什么业务问题？" };
      }
      if (turns === 2) {
        assert.ok(input.recentMessages.some((item) => item.includes("我记下了标题")));
        await executor.execute("save_requirement_draft", JSON.stringify({ goal: "恢复渠道回传", scope: "AppsFlyer push 配置", acceptanceCriteria: "新地址生效并通过回传验证" }));
        return { usedTools: true, text: "需求信息已完整，请确认是否提交。" };
      }
      const result = await executor.execute("submit_requirement", "{}");
      assert.equal((result as Record<string, unknown>).ok, true);
      return { usedTools: true, text: `已提交需求 ${(result as Record<string, unknown>).requirementId}` };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent });

  assert.match((await service.handleMessage(message("新增 AppsFlyer push 地址更换需求", "1"))).text, /业务问题/);
  assert.match((await service.handleMessage(message("要恢复渠道回传，范围是 push 配置，验收是新地址通过回传验证", "2"))).text, /确认/);
  assert.equal((await store.listRequirements()).length, 0);
  assert.match((await service.handleMessage(message("确认提交", "3"))).text, /REQ-/);
  assert.equal((await store.listRequirements()).length, 1);
  const history = (await store.getConversation("oc_demo:ou_requester:main"))?.recentMessages || [];
  assert.ok(history.some((item) => item.startsWith("用户（ou_requester）：")));
  assert.ok(history.some((item) => item.startsWith("助手：")));
});

test("v2 does not fall back to keyword rules when the model is unavailable", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  const reply = await service.handleMessage(message("新增需求：做一个 Meta 看板", "no-agent"));
  assert.match(reply.text, /LLM 配置/);
  assert.equal((await store.listRequirements()).length, 0);
  assert.equal((await store.getConversation("oc_demo:ou_requester:main"))?.draft, undefined);
});

test("model uses protected requirement query tools with visibility filtering", async () => {
  const store = new InMemoryRequirementStore();
  await store.createRequirement({ title: "公开事项", goal: "目标", scope: "范围", acceptanceCriteria: "验收", requesterId: "ou_other", platforms: [], status: "进行中", ownerId: "ou_owner", visibility: "public", sourceChatId: "oc", sourceMessageId: "om1" });
  await store.createRequirement({ title: "机密事项", goal: "目标", scope: "范围", acceptanceCriteria: "验收", requesterId: "ou_other", platforms: [], status: "进行中", ownerId: "ou_owner", visibility: "private", sourceChatId: "oc", sourceMessageId: "om2" });
  let result: unknown;
  const agent: AgentClient = {
    async run(_input, _definitions, executor) {
      result = await executor.execute("list_current_work", "{}");
      return { usedTools: true, text: "已查询当前工作" };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent });
  await service.handleMessage(message("现在在做什么", "query", "ou_viewer"));
  assert.deepEqual((result as { items: Array<{ title: string }> }).items.map((item) => item.title), ["公开事项"]);
});

test("expected internal guards stay conversational and false success is blocked", async () => {
  const store = new InMemoryRequirementStore();
  const natural: AgentClient = {
    async run(_input, _definitions, executor) {
      await executor.execute("clear_requirement_draft", "{}");
      return { usedTools: true, text: "需要你明确说取消当前需求，我才会清除草稿。你也可以直接告诉我想修改什么。" };
    },
  };
  const naturalService = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent: natural });
  assert.doesNotMatch((await naturalService.handleMessage(message("把标题换一下", "guard"))).text, /飞书工具|explicit_/);

  const lying: AgentClient = {
    async run(_input, _definitions, executor) {
      await executor.execute("clear_requirement_draft", "{}");
      return { usedTools: true, text: "已清除需求。" };
    },
  };
  const lyingService = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent: lying });
  assert.match((await lyingService.handleMessage(message("把标题换一下", "guard-lying"))).text, /我没有清除/);
});

test("failed Feishu reads preserve diagnostics and block false success", async () => {
  const store = new InMemoryRequirementStore();
  const mcp = {
    async listTools() { return [{ type: "function" as const, function: { name: "docx_v1_document_get", description: "读取文档", parameters: { type: "object", properties: {} } } }]; },
    async callTool() { return { ok: false, error: "permission_denied", detail: "code=99991672 scope docx:document:readonly access_token=t-secret" }; },
    async close() {},
  };
  const agent: AgentClient = {
    async run(_input, definitions, executor) {
      assert.ok(definitions.some((item) => item.function.name === "find_feishu_tools"));
      await executor.execute("call_feishu_tool", JSON.stringify({ toolName: "docx_v1_document_get", arguments: {} }));
      return { usedTools: true, text: "读取成功" };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent, mcp });
  const reply = (await service.handleMessage(message("读取文档", "mcp-read"))).text;
  assert.match(reply, /docx_v1_document_get/);
  assert.match(reply, /99991672/);
  assert.doesNotMatch(reply, /t-secret|读取成功/);
});

function mcpWriteFixture() {
  let calls = 0;
  let argumentsJson = "";
  const mcp = {
    async listTools() {
      return [{
        type: "function" as const,
        function: {
          name: "create-doc",
          description: "创建文档",
          parameters: { type: "object", properties: { title: { type: "string" } } },
        },
      }];
    },
    async callTool(_name: string, args: string) { calls += 1; argumentsJson = args; return { ok: true, content: [{ type: "text", text: "docxcn_demo" }] }; },
    async close() {},
    get calls() { return calls; },
    get argumentsJson() { return argumentsJson; },
  };
  const agent: AgentClient = {
    async run(_input, _definitions, executor) {
      await executor.execute("call_feishu_tool", JSON.stringify({ toolName: "create-doc", arguments: { title: "周报" } }));
      return { usedTools: true, text: "已创建" };
    },
  };
  return { mcp, agent };
}

test("MCP mutations are held for requester confirmation and execute once", async () => {
  const store = new InMemoryRequirementStore();
  const { mcp, agent } = mcpWriteFixture();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent, mcp });
  assert.match((await service.handleMessage(message("创建周报文档", "write"))).text, /确认执行/);
  assert.equal(mcp.calls, 0);
  assert.match((await service.handleMessage(message("确认执行", "confirm"))).text, /已执行/);
  assert.equal(mcp.calls, 1);
  assert.deepEqual(JSON.parse(mcp.argumentsJson), { title: "周报" });
});

test("MCP confirmation enforces requester ownership, cancellation, and expiry", async () => {
  const store = new InMemoryRequirementStore();
  const { mcp, agent } = mcpWriteFixture();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent, mcp });
  const group = (content: string, id: string, senderId: string) => ({ ...message(content, id, senderId), chatType: "group" as const });
  await service.handleMessage(group("创建周报文档", "g1", "ou_first"));
  assert.match((await service.handleMessage(group("确认执行", "g2", "ou_other"))).text, /只能由发起人/);
  assert.match((await service.handleMessage(group("取消操作", "g3", "ou_first"))).text, /已取消/);
  assert.equal(mcp.calls, 0);

  await service.handleMessage(group("创建周报文档", "g4", "ou_first"));
  const state = await store.getConversation("oc_demo:main");
  state!.pendingMcpAction!.expiresAt = new Date(Date.now() - 1).toISOString();
  await store.saveConversation(state!);
  assert.match((await service.handleMessage(group("确认执行", "g5", "ou_first"))).text, /已过期/);
  assert.equal(mcp.calls, 0);
});

test("Base field deletion is selected by the model and enforced by the policy gateway", async () => {
  const store = new InMemoryRequirementStore();
  const deleted: string[] = [];
  let agentCalls = 0;
  const agent: AgentClient = {
    async run(_input, _definitions, executor) {
      agentCalls += 1;
      const result = await executor.execute("request_delete_base_field", JSON.stringify({ fieldName: "负责人" }));
      return { usedTools: true, text: JSON.stringify(result) };
    },
  };
  const service = new ConversationService(store, {
    ownerId: "ou_owner", ownerName: "韩飞龙", agent, baseTableLabel: "需求表",
    baseAdmin: {
      async listFields() { return [{ fieldId: "fld_owner", name: "负责人" }, { fieldId: "fld_title", name: "需求标题", isPrimary: true }]; },
      async deleteField(id: string) { deleted.push(id); },
    },
  });
  assert.match((await service.handleMessage(message("删除负责人字段", "base-request", "ou_owner"))).text, /确认删除/);
  assert.deepEqual(deleted, []);
  assert.match((await service.handleMessage(message("确认删除", "base-confirm", "ou_owner"))).text, /已删除/);
  assert.deepEqual(deleted, ["fld_owner"]);
  assert.equal(agentCalls, 1);
});

test("Base field deletion remains administrator-only and protects the primary field", async () => {
  const store = new InMemoryRequirementStore();
  const results: unknown[] = [];
  const agent: AgentClient = {
    async run(input, _definitions, executor) {
      results.push(await executor.execute("request_delete_base_field", JSON.stringify({ fieldName: input.message.includes("主字段") ? "需求标题" : "负责人" })));
      return { usedTools: true, text: "请检查操作结果" };
    },
  };
  const service = new ConversationService(store, {
    ownerId: "ou_owner", ownerName: "韩飞龙", agent,
    baseAdmin: {
      async listFields() { return [{ fieldId: "fld_owner", name: "负责人" }, { fieldId: "fld_title", name: "需求标题", isPrimary: true }]; },
      async deleteField() { assert.fail("must not delete"); },
    },
  });
  assert.match((await service.handleMessage(message("删除负责人", "denied"))).text, /管理员/);
  assert.match((await service.handleMessage(message("删除主字段", "primary", "ou_owner"))).text, /主字段/);
  assert.equal((results[0] as Record<string, unknown>).error, "admin_only");
  assert.equal((results[1] as Record<string, unknown>).error, "primary_field_cannot_be_deleted");
});

test("group draft ownership is enforced by the domain tool, not ConversationService keywords", async () => {
  const store = new InMemoryRequirementStore();
  await store.saveConversation({
    key: "oc_demo:main", chatId: "oc_demo", senderId: "ou_first", recentMessages: [], updatedAt: new Date().toISOString(),
    draft: { id: "DRAFT-1", conversationKey: "oc_demo:main", requesterId: "ou_first", title: "原需求", state: "collecting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  });
  const results: unknown[] = [];
  const agent: AgentClient = {
    async run(_input, _definitions, executor) {
      results.push(await executor.execute("save_requirement_draft", JSON.stringify({ title: "越权修改" })));
      results.push(await executor.execute("clear_requirement_draft", "{}"));
      return { usedTools: true, text: "只有发起人可以修改该草稿。" };
    },
  };
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙", agent });
  await service.handleMessage({ ...message("取消需求", "ownership", "ou_other"), chatType: "group" });
  assert.deepEqual(results, [
    { ok: false, error: "draft_owned_by_other" },
    { ok: false, error: "no_owned_requirement_draft" },
  ]);
  assert.equal((await store.getConversation("oc_demo:main"))?.draft?.title, "原需求");
});

test("bot messages are ignored", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  assert.equal((await service.handleMessage({ ...message("hello", "bot"), senderType: "bot" })).text, "");
});
