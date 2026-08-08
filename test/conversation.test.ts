import assert from "node:assert/strict";
import test from "node:test";
import { ConversationService } from "../src/conversation.ts";
import { InMemoryRequirementStore } from "../src/store.ts";

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
