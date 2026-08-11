import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "../src/logger.ts";
import { OpenAICompatibleAgentClient } from "../src/agent.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

test("agent sends multi-turn context and completes a tool loop", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "get_requirement_table_link", arguments: "{}" } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "需求表地址：https://feishu.cn/base/demo" } }] }), { status: 200 });
  };
  const client = new OpenAICompatibleAgentClient({ baseUrl: "https://example.test/v1", apiKey: "key", model: "model" }, silentLogger, fetchImpl);
  let toolCalls = 0;
  const result = await client.run({
    message: "需求表在哪里？",
    recentMessages: ["用户（甲）：前一个问题", "助手：前一个回答"],
    senderId: "ou_requester",
  }, [{ type: "function", function: { name: "get_requirement_table_link", description: "地址", parameters: { type: "object" } } }], {
    async execute() { toolCalls += 1; return { ok: true, url: "https://feishu.cn/base/demo" }; },
  });

  assert.equal(result?.text, "需求表地址：https://feishu.cn/base/demo");
  assert.equal(result?.usedTools, true);
  assert.equal(toolCalls, 1);
  const firstMessages = bodies[0].messages as Array<Record<string, unknown>>;
  assert.match(String(firstMessages[0].content), /own intent understanding/);
  assert.doesNotMatch(String(firstMessages[0].content), /classify Chinese or English messages/);
  assert.match(String(firstMessages[1].content), /前一个回答/);
  const secondMessages = bodies[1].messages as Array<Record<string, unknown>>;
  assert.equal(secondMessages.at(-1)?.role, "tool");
});

test("agent keeps assistant and tool messages aligned when a provider returns too many calls", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  let round = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    round += 1;
    if (round === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: Array.from({ length: 6 }, (_, index) => ({ id: `call-${index}`, type: "function", function: { name: "tool", arguments: "{}" } })) } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "完成" } }] }), { status: 200 });
  };
  const client = new OpenAICompatibleAgentClient({ baseUrl: "https://example.test/v1", apiKey: "key", model: "model" }, silentLogger, fetchImpl);
  let executions = 0;
  await client.run({ message: "执行", recentMessages: [], senderId: "ou_x" }, [{ type: "function", function: { name: "tool", description: "tool", parameters: { type: "object" } } }], {
    async execute() { executions += 1; return { ok: true }; },
  });
  assert.equal(executions, 4);
  const messages = requestBodies[1].messages as Array<Record<string, unknown>>;
  const assistant = messages.find((item) => item.role === "assistant");
  assert.equal((assistant?.tool_calls as unknown[]).length, 4);
  assert.equal(messages.filter((item) => item.role === "tool").length, 4);
});

test("agent retries transient provider errors and returns undefined for malformed responses", async () => {
  let attempts = 0;
  const retryingFetch: typeof fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response("busy", { status: 503 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "恢复" } }] }), { status: 200 });
  };
  const retrying = new OpenAICompatibleAgentClient({ baseUrl: "https://example.test/v1", apiKey: "key", model: "model", maxRetries: 1 }, silentLogger, retryingFetch);
  assert.equal((await retrying.run({ message: "你好", recentMessages: [], senderId: "ou_x" }, [], { async execute() {} }))?.text, "恢复");
  assert.equal(attempts, 2);

  const malformed = new OpenAICompatibleAgentClient({ baseUrl: "https://example.test/v1", apiKey: "key", model: "model", maxRetries: 0 }, silentLogger, async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
  assert.equal(await malformed.run({ message: "你好", recentMessages: [], senderId: "ou_x" }, [], { async execute() {} }), undefined);
});
