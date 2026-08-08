import assert from "node:assert/strict";
import test from "node:test";
import { ConversationService } from "../src/conversation.ts";
import type { Logger } from "../src/logger.ts";
import { MessageProcessor } from "../src/messageProcessor.ts";
import { InMemoryRequirementStore } from "../src/store.ts";
import type { IncomingMessage } from "../src/types.ts";
import {
  OpenAICompatibleUnderstandingClient,
  OpenAICompatibleAgentClient,
  type MessageUnderstanding,
  type UnderstandingClient,
} from "../src/understanding.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const message = (content: string, id: string): IncomingMessage => ({
  chatId: "oc_llm",
  chatType: "p2p",
  senderId: "ou_requester",
  messageId: `om_${id}`,
  content,
  senderType: "user",
});

class QueueUnderstanding implements UnderstandingClient {
  readonly results: Array<MessageUnderstanding | undefined>;
  calls = 0;

  constructor(results: Array<MessageUnderstanding | undefined>) {
    this.results = results;
  }

  async analyze(): Promise<MessageUnderstanding | undefined> {
    this.calls += 1;
    return this.results.shift();
  }
}

test("uses semantic extraction across multiple turns and still requires explicit confirmation", async () => {
  const understanding = new QueueUnderstanding([
    {
      intent: "new_requirement",
      fields: { title: "Meta 成本预警", goal: "尽早发现异常消耗", platforms: ["Meta"] },
      nextQuestion: "预警需要覆盖哪些游戏、账户和指标？",
    },
    {
      intent: "continue_requirement",
      fields: { scope: "全部海外游戏，按账户监控日消耗和 CPI", platforms: ["Meta"] },
      nextQuestion: "达到什么条件可以验收？",
    },
    {
      intent: "continue_requirement",
      fields: { acceptanceCriteria: "异常发生后 10 分钟内通知，且可追溯", desiredDate: "2026-08-31", priority: "P1" },
    },
    { intent: "confirm_requirement", fields: {} },
  ]);
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" }, understanding);

  assert.match((await service.handleMessage(message("想做一个广告异常提醒", "1"))).text, /覆盖哪些游戏/);
  assert.match((await service.handleMessage(message("海外游戏的 Meta 账户，关注日消耗和 CPI", "2"))).text, /什么条件可以验收/);
  const summary = await service.handleMessage(message("异常后十分钟内通知，月底前完成，P1", "3"));
  assert.match(summary.text, /Meta 成本预警/);
  assert.match(summary.text, /2026-08-31/);
  assert.match(summary.text, /确认提交/);
  assert.equal((await store.listRequirements()).length, 0);

  await service.handleMessage(message("好的，就按这个提交", "4"));
  const requirements = await store.listRequirements();
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].priority, "P1");
  assert.deepEqual(requirements[0].platforms, ["Meta"]);
});

test("recognizes general conversation without creating a draft", async () => {
  const store = new InMemoryRequirementStore();
  const understanding = new QueueUnderstanding([{ intent: "general_conversation", fields: {} }]);
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" }, understanding);

  assert.match((await service.handleMessage(message("你好", "10"))).text, /记录和澄清需求/);
  assert.equal((await store.getConversation("oc_llm:ou_requester:main"))?.draft, undefined);
});

test("falls back to deterministic rules when the understanding client throws", async () => {
  const failingClient: UnderstandingClient = { async analyze() { throw new Error("provider unavailable"); } };
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" }, failingClient);

  assert.match((await service.handleMessage(message("我想做一个 Meta 看板", "20"))).text, /解决什么问题/);
});

test("validates OpenAI-compatible JSON responses and retries transient errors", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    new Response("temporary", { status: 503 }),
    new Response(JSON.stringify({
      choices: [{ message: { content: "```json\n{\"intent\":\"new_requirement\",\"fields\":{\"title\":\"Meta 看板\",\"platforms\":[\"Meta\"],\"priority\":\"p1\"},\"nextQuestion\":\"业务目标是什么？\"}\n```" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responses.shift()!;
  }) as typeof fetch;
  const client = new OpenAICompatibleUnderstandingClient({
    baseUrl: "https://llm.example.test/v1/",
    apiKey: "test-api-key",
    model: "test-model",
    maxRetries: 1,
    maxInputChars: 1_000,
  }, silentLogger, fakeFetch);

  const result = await client.analyze({
    message: `做个 Meta 看板${"很长的消息".repeat(800)}`,
    recentMessages: ["历史消息".repeat(500), "另一条历史消息".repeat(500)],
    draft: {
      id: "DRAFT-1", conversationKey: "conversation", requesterId: "ou_requester", title: "Meta 看板",
      goal: "业务目标".repeat(300), scope: "数据范围".repeat(400), acceptanceCriteria: "验收标准".repeat(400),
      platforms: ["Meta", "TikTok"], state: "collecting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://llm.example.test/v1/chat/completions");
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer test-api-key");
  const requestBody = JSON.parse(String(calls[0].init?.body)) as { messages: Array<{ content: string }> };
  assert.ok(requestBody.messages[1].content.length <= 1_000);
  assert.deepEqual(result, {
    intent: "new_requirement",
    fields: { title: "Meta 看板", goal: undefined, scope: undefined, platforms: ["Meta"], acceptanceCriteria: undefined, desiredDate: undefined, priority: "P1" },
    nextQuestion: "业务目标是什么？",
  });
});

test("returns no semantic result for malformed output or timeout", async () => {
  const warnings: string[] = [];
  const captureLogger: Logger = { info() {}, warn(event) { warnings.push(event); }, error() {} };
  const malformedFetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })) as typeof fetch;
  const malformed = new OpenAICompatibleUnderstandingClient({ baseUrl: "https://example.test/v1", apiKey: "key", model: "model", maxRetries: 0 }, captureLogger, malformedFetch);
  assert.equal(await malformed.analyze({ message: "hello", recentMessages: [] }), undefined);

  const timeoutFetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  const timeout = new OpenAICompatibleUnderstandingClient({ baseUrl: "https://example.test/v1", apiKey: "key", model: "model", timeoutMs: 100, maxRetries: 0 }, captureLogger, timeoutFetch);
  assert.equal(await timeout.analyze({ message: "hello", recentMessages: [] }), undefined);
  assert.deepEqual(warnings, ["llm_understanding_invalid_response", "llm_understanding_unavailable"]);
});

test("does not invoke semantic analysis again for a duplicate completed message", async () => {
  const understanding = new QueueUnderstanding([{ intent: "my_requirements_query", fields: {} }]);
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" }, understanding);
  const processor = new MessageProcessor(store, service, {
    allowedTenantKeys: new Set(), allowedUserIds: new Set(), allowedChatIds: new Set(), groupRequireMention: false,
  }, silentLogger);

  const first = await processor.process(message("帮我看看之前提过什么", "30"));
  const duplicate = await processor.process(message("帮我看看之前提过什么", "30"));
  assert.deepEqual(duplicate, first);
  assert.equal(understanding.calls, 1);
});

test("runs an OpenAI-compatible tool call loop and returns the final answer", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const responses = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_requirement_table_link", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "需求表地址是：https://feishu.cn/base/demo", tool_calls: [] } }] },
  ];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as typeof fetch;
  const client = new OpenAICompatibleAgentClient({ baseUrl: "https://llm.example.test/v1", apiKey: "key", model: "model", maxRetries: 0 }, silentLogger, fakeFetch);
  let executed = 0;
  const result = await client.run({ message: "需求多维表格的地址是什么？", recentMessages: [], senderId: "ou_requester" }, [{
    type: "function", function: { name: "get_requirement_table_link", description: "获取地址", parameters: { type: "object" } },
  }], {
    async execute(name) { assert.equal(name, "get_requirement_table_link"); executed += 1; return { ok: true, url: "https://feishu.cn/base/demo" }; },
  });
  assert.deepEqual(result, { usedTools: true, text: "需求表地址是：https://feishu.cn/base/demo" });
  assert.equal(executed, 1);
  assert.deepEqual((calls[0].body.tools as Array<Record<string, unknown>>).length, 1);
  assert.equal((calls[1].body.messages as Array<Record<string, unknown>>).at(-1)?.role, "tool");
});

test("keeps assistant and tool messages aligned when the model returns many calls", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const responses = [
    { choices: [{ message: { content: null, tool_calls: Array.from({ length: 5 }, (_, index) => ({ id: `call_${index}`, type: "function", function: { name: "get_requirement_table_link", arguments: "{}" } })) } }] },
    { choices: [{ message: { content: "已查询", tool_calls: [] } }] },
  ];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as typeof fetch;
  const client = new OpenAICompatibleAgentClient({ baseUrl: "https://llm.example.test/v1", apiKey: "key", model: "model", maxRetries: 0 }, silentLogger, fakeFetch);
  let executed = 0;
  await client.run({ message: "查询", recentMessages: [], senderId: "ou_requester" }, [{ type: "function", function: { name: "get_requirement_table_link", description: "地址", parameters: { type: "object" } } }], {
    async execute() { executed += 1; return { ok: true }; },
  });
  assert.equal(executed, 4);
  const assistant = (calls[1].messages as Array<Record<string, unknown>>).find((item) => item.role === "assistant");
  assert.equal((assistant?.tool_calls as unknown[]).length, 4);
});
