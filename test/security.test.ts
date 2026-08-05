import assert from "node:assert/strict";
import test from "node:test";
import { authenticateRequest } from "../src/auth.ts";
import { ConfirmationService } from "../src/confirmation.ts";
import { ConversationService } from "../src/conversation.ts";
import { redact, type Logger } from "../src/logger.ts";
import { MessageProcessor } from "../src/messageProcessor.ts";
import { InMemoryRequirementStore } from "../src/store.ts";
import type { ConversationState, IncomingMessage } from "../src/types.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const permissions = {
  allowedTenantKeys: new Set<string>(),
  allowedUserIds: new Set<string>(),
  allowedChatIds: new Set<string>(),
  groupRequireMention: true,
  botOpenId: "ou_bot",
};
const message = (content: string, id: string): IncomingMessage => ({
  chatId: "oc_demo",
  chatType: "p2p",
  senderId: "ou_requester",
  messageId: `om_${id}`,
  content,
  senderType: "user",
});

test("deduplicates a confirmation message and returns its stored reply", async () => {
  const store = new InMemoryRequirementStore();
  const processor = new MessageProcessor(store, new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" }), permissions, silentLogger);
  await processor.process(message("我想做一个 Meta 看板", "1"));
  await processor.process(message("目标是看每天的消耗和回收", "2"));
  await processor.process(message("范围包含游戏、国家和账户", "3"));
  await processor.process(message("验收时需要看到 D0 ROAS", "4"));

  const [first, duplicate] = await Promise.all([
    processor.process(message("确认提交", "5")),
    processor.process(message("确认提交", "5")),
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal((await store.listRequirements()).length, 1);
});

test("serializes concurrent messages in the same conversation", async () => {
  class SlowStore extends InMemoryRequirementStore {
    activeSaves = 0;
    maxActiveSaves = 0;
    override async saveConversation(conversation: ConversationState): Promise<void> {
      this.activeSaves += 1;
      this.maxActiveSaves = Math.max(this.maxActiveSaves, this.activeSaves);
      await new Promise((resolve) => setTimeout(resolve, 15));
      await super.saveConversation(conversation);
      this.activeSaves -= 1;
    }
  }
  const store = new SlowStore();
  const processor = new MessageProcessor(store, new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" }), permissions, silentLogger);
  await Promise.all([
    processor.process(message("我想做 Meta 看板", "10")),
    processor.process(message("目标是分析每天消耗", "11")),
  ]);
  assert.equal(store.maxActiveSaves, 1);
  const state = await store.getConversation("oc_demo:ou_requester:main");
  assert.deepEqual(state?.recentMessages, ["我想做 Meta 看板", "目标是分析每天消耗"]);
});

test("silently rejects unmentioned group messages and enforces allowlists", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  const processor = new MessageProcessor(store, service, permissions, silentLogger);
  const noMention = await processor.process({ ...message("新需求", "20"), chatType: "group" });
  assert.equal(noMention.text, "");
  assert.equal(await store.getConversation("oc_demo:ou_requester:main"), undefined);

  const restricted = new MessageProcessor(store, service, { ...permissions, groupRequireMention: false, allowedUserIds: new Set(["ou_other"]) }, silentLogger);
  assert.match((await restricted.process(message("我的需求", "21"))).text, /没有使用/);
});

test("issues scoped confirmation tokens and rejects tampering and expiry", () => {
  const confirmation = new ConfirmationService("a-secure-confirmation-secret-with-32-chars", 60);
  const input = { action: "PATCH_REQUIREMENT", actorId: "admin", resourceId: "REQ-1", body: { status: "进行中", progress: "50%" } };
  const issued = confirmation.issue(input, 1_000);
  assert.equal(confirmation.verify(issued.token, input, 2_000), true);
  assert.equal(confirmation.verify(issued.token, { ...input, body: { status: "已完成" } }, 2_000), false);
  assert.equal(confirmation.verify(`${issued.token.slice(0, -1)}x`, input, 2_000), false);
  assert.equal(confirmation.verify(issued.token, input, 62_000), false);
});

test("authenticates bearer and x-api-key values without accepting the other role key", () => {
  const config = { adminApiKey: "admin-key-with-at-least-24-characters", ingressApiKey: "ingress-key-with-at-least-24-chars" };
  const admin = { headers: { authorization: `Bearer ${config.adminApiKey}` } } as never;
  const ingress = { headers: { "x-api-key": config.ingressApiKey } } as never;
  assert.equal(authenticateRequest(admin, "admin", config).authenticated, true);
  assert.equal(authenticateRequest(ingress, "ingress", config).authenticated, true);
  assert.equal(authenticateRequest(ingress, "admin", config).authenticated, false);
});

test("redacts nested secrets, bearer values, and URL passwords", () => {
  assert.deepEqual(redact({ authorization: "Bearer abc", nested: { appSecret: "secret", note: "Bearer visible-token", url: "postgresql://user:password@db/app" } }), {
    authorization: "[REDACTED]",
    nested: { appSecret: "[REDACTED]", note: "Bearer [REDACTED]", url: "postgresql://user:[REDACTED]@db/app" },
  });
});
