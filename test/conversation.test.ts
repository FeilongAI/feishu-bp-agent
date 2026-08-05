import assert from "node:assert/strict";
import test from "node:test";
import { ConversationService } from "../src/conversation.ts";
import { InMemoryRequirementStore } from "../src/store.ts";

const message = (content: string, id: string, senderId = "ou_requester") => ({ chatId: "oc_demo", senderId, messageId: `om_${id}`, content, senderType: "user" as const });

test("clarifies a requirement and only creates it after confirmation", () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });

  assert.match(service.handleMessage(message("我想做一个 Meta 看板", "1")).text, /解决什么问题/);
  assert.match(service.handleMessage(message("目标是看每天的消耗和回收", "2")).text, /明确范围/);
  assert.match(service.handleMessage(message("包含游戏、国家和账户，显示 D0 ROAS", "3")).text, /验收标准/);
  assert.match(service.handleMessage(message("验收时能按这三个维度筛选并看到 D0 ROAS", "4")).text, /确认提交/);
  assert.equal(store.listRequirements().length, 0);
  assert.match(service.handleMessage(message("确认提交", "5")).text, /已记录需求 REQ-/);
  assert.equal(store.listRequirements().length, 1);
});

test("answers current work and requester requirements", () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  store.createRequirement({ title: "APP 营收核对", goal: "核对数据", scope: "APP 营收", acceptanceCriteria: "区间数一致", requesterId: "ou_requester", platforms: ["AppsFlyer"], status: "进行中", ownerId: "ou_owner", ownerName: "韩飞龙", progress: "正在核对内购和广告变现", visibility: "public", sourceChatId: "oc_demo", sourceMessageId: "om_source" });
  assert.match(service.handleMessage(message("你现在在做什么", "6")).text, /APP 营收核对/);
  assert.match(service.handleMessage(message("我的需求", "7")).text, /APP 营收核对/);
});

test("does not echo bot messages", () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  assert.equal(service.handleMessage({ ...message("hello", "8"), senderType: "bot" }).text, "");
});
