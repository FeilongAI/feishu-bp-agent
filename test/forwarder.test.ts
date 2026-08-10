import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CoreAgentHttpClient,
  EventDeliveryService,
  FileSpoolStore,
  LarkCliReplySender,
  LarkCliSenderDirectory,
  type CoreAgent,
  type ReplySender,
} from "../src/forwarder.ts";
import type { Logger } from "../src/logger.ts";
import type { BotReply, IncomingMessage } from "../src/types.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const flatEvent = {
  type: "im.message.receive_v1",
  chat_id: "oc_demo",
  chat_type: "group",
  message_id: "om_demo_1",
  sender_id: "ou_requester",
  sender_type: "user",
  content: "需要一个 Meta 消耗看板",
  thread_id: "omt_thread",
  mentions: [{ id: "ou_bot", name: "BP 助手" }],
};

test("forwards a normalized event to the core API with ingress authentication", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, reply: { text: "请补充业务目标" } }), { status: 200 });
  }) as typeof fetch;
  const client = new CoreAgentHttpClient({ url: "http://core:8090/", ingressApiKey: "ingress-secret", timeoutMs: 1_000 }, fakeFetch);
  const reply = await client.process({
    chatId: "oc_demo", chatType: "p2p", senderId: "ou_user", messageId: "om_1", content: "新需求",
  });

  assert.deepEqual(reply, { text: "请补充业务目标", replyInThread: false });
  assert.equal(calls[0].url, "http://core:8090/api/messages");
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer ingress-secret");
  const body = JSON.parse(String(calls[0].init?.body)) as IncomingMessage;
  assert.equal(body.messageId, "om_1");
});

test("resolves the sender name through the contact CLI before delivery", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const directory = new LarkCliSenderDirectory("lark-cli-test", async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: JSON.stringify({ data: { user: { name: "张三" } } }), stderr: "" };
  });
  const enriched = await directory.enrich({ chatId: "oc_demo", senderId: "ou_user", messageId: "om_name", content: "hello" });
  assert.equal(enriched.senderName, "张三");
  assert.equal(calls[0].args[calls[0].args.indexOf("--user-id") + 1], "ou_user");
  await directory.enrich({ chatId: "oc_demo", senderId: "ou_user", messageId: "om_name_2", content: "hello" });
  assert.equal(calls.length, 1);
});

test("falls back to open_id when contact lookup fails", async () => {
  const directory = new LarkCliSenderDirectory("lark-cli-test", async () => ({ code: 1, stdout: "", stderr: "permission denied" }));
  const message = { chatId: "oc_demo", senderId: "ou_user", messageId: "om_name_fail", content: "hello" };
  assert.equal((await directory.enrich(message)).senderName, undefined);
});

test("bounds the forwarder sender-name cache with LRU eviction", async () => {
  let calls = 0;
  const directory = new LarkCliSenderDirectory("lark-cli-test", async () => {
    calls += 1;
    return { code: 0, stdout: JSON.stringify({ data: { user: { name: "用户" } } }), stderr: "" };
  }, 86_400_000, 2);
  const lookup = (senderId: string, messageId: string) => directory.enrich({ chatId: "oc_demo", senderId, messageId, content: "hello" });
  await lookup("ou_a", "om_cache_a1");
  await lookup("ou_b", "om_cache_b1");
  await lookup("ou_a", "om_cache_a2");
  await lookup("ou_c", "om_cache_c1");
  await lookup("ou_b", "om_cache_b2");
  assert.equal(calls, 4);
});

test("spools before delivery and replays after a transient failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-forwarder-"));
  try {
    class FlakyCore implements CoreAgent {
      fail = true;
      calls = 0;
      async process(): Promise<BotReply> {
        this.calls += 1;
        if (this.fail) throw new Error("core unavailable");
        return { text: "需求已收到", replyInThread: true };
      }
    }
    class CapturingReplies implements ReplySender {
      calls: Array<{ messageId: string; reply: BotReply }> = [];
      async reply(messageId: string, reply: BotReply): Promise<void> { this.calls.push({ messageId, reply }); }
    }
    const core = new FlakyCore();
    const replies = new CapturingReplies();
    const spool = new FileSpoolStore(directory);
    const delivery = new EventDeliveryService(spool, core, replies, silentLogger, { maxRetries: 0, retryBaseMs: 10 });

    assert.equal(await delivery.accept(flatEvent), false);
    assert.equal(await spool.count(), 1);
    assert.equal((await spool.list())[0].content, flatEvent.content);

    core.fail = false;
    await delivery.replay();
    assert.equal(await spool.count(), 0);
    assert.deepEqual(replies.calls, [{ messageId: "om_demo_1", reply: { text: "需求已收到", replyInThread: true } }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries a transient spool write before consuming the event", async () => {
  let saveCalls = 0;
  const messages: IncomingMessage[] = [];
  const spool: import("../src/forwarder.ts").SpoolStore = {
    async save(message) { saveCalls += 1; if (saveCalls === 1) throw new Error("temporary disk error"); messages.push(message); },
    async remove(messageId) { const index = messages.findIndex((item) => item.messageId === messageId); if (index >= 0) messages.splice(index, 1); },
    async list() { return messages; },
    async count() { return messages.length; },
  };
  const delivery = new EventDeliveryService(spool, { async process() { return { text: "已收到" }; } }, { async reply() {} }, silentLogger, { maxRetries: 1, retryBaseMs: 1 });
  assert.equal(await delivery.accept(flatEvent), true);
  assert.equal(saveCalls, 2);
  assert.equal(messages.length, 0);
});

test("ignores bot events without creating spool items", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-forwarder-"));
  try {
    const core: CoreAgent = { async process() { assert.fail("bot events must not reach the core"); } };
    const replies: ReplySender = { async reply() { assert.fail("bot events must not be replied to"); } };
    const spool = new FileSpoolStore(directory);
    const delivery = new EventDeliveryService(spool, core, replies, silentLogger, { maxRetries: 0, retryBaseMs: 10 });
    assert.equal(await delivery.accept({ ...flatEvent, sender_type: "bot" }), true);
    assert.equal(await spool.count(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the event spooled until a failed Bot reply can be replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-forwarder-"));
  try {
    let replyFails = true;
    let coreCalls = 0;
    const core: CoreAgent = { async process() { coreCalls += 1; return { text: "待发送回复" }; } };
    const replies: ReplySender = { async reply() { if (replyFails) throw new Error("reply unavailable"); } };
    const spool = new FileSpoolStore(directory);
    const delivery = new EventDeliveryService(spool, core, replies, silentLogger, { maxRetries: 0, retryBaseMs: 10 });

    assert.equal(await delivery.accept(flatEvent), false);
    assert.equal(await spool.count(), 1);
    replyFails = false;
    await delivery.replay();
    assert.equal(await spool.count(), 0);
    assert.equal(coreCalls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses a stable CLI reply idempotency key and thread flag", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const sender = new LarkCliReplySender("lark-cli-test", async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stderr: "" };
  });
  await sender.reply("om_demo_1", { text: "已记录", replyInThread: true });
  await sender.reply("om_demo_1", { text: "已记录", replyInThread: true });

  assert.equal(calls[0].command, "lark-cli-test");
  assert.ok(calls[0].args.includes("--reply-in-thread"));
  const firstKey = calls[0].args[calls[0].args.indexOf("--idempotency-key") + 1];
  const secondKey = calls[1].args[calls[1].args.indexOf("--idempotency-key") + 1];
  assert.equal(firstKey, secondKey);
  assert.ok(firstKey.length <= 50);
});

test("does not expose CLI stderr or reply content through thrown errors", async () => {
  const sender = new LarkCliReplySender("lark-cli-test", async () => ({ code: 1, stderr: "secret reply content and token" }));
  await assert.rejects(sender.reply("om_demo_1", { text: "sensitive requirement" }), (error: Error) => {
    assert.equal(error.message, "lark_reply_failed:unknown:exit_1");
    return true;
  });
});

test("quarantines malformed spool entries instead of blocking valid replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-forwarder-"));
  try {
    await writeFile(join(directory, "broken.json"), "not-json", "utf8");
    const spool = new FileSpoolStore(directory);
    assert.deepEqual(await spool.list(), []);
    assert.equal(await spool.count(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
