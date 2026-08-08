import assert from "node:assert/strict";
import test from "node:test";
import { BaseSyncWorker } from "../src/baseSync.ts";
import { FeishuBaseClient, outboxClientToken, type BaseRecordClient } from "../src/feishuBase.ts";
import type { Logger } from "../src/logger.ts";
import type { BaseOutboxItem, BaseOutboxStore, Requirement } from "../src/types.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const requirement: Requirement = {
  id: "REQ-20260805-ABC123", title: "Meta 日报", goal: "核对消耗", scope: "游戏和国家", acceptanceCriteria: "数据一致",
  requesterId: "ou_requester", requesterName: "需求人", platforms: ["Meta"], desiredDate: "下周五", priority: "P1", status: "待评估",
  ownerId: "ou_owner", ownerName: "韩飞龙", progress: "待分析", visibility: "public", sourceChatId: "oc_demo", sourceMessageId: "om_demo",
  createdAt: "2026-08-05T01:02:03.000Z", updatedAt: "2026-08-05T02:03:04.000Z",
};

test("uses the official Base record API, tenant token cache, and client_token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
    { code: 0, data: { record: { record_id: "rec_123" } } },
    { code: 0, data: { record: { record_id: "rec_123" } } },
    { code: 0, data: {} },
  ];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new FeishuBaseClient({ appId: "cli_app", appSecret: "app-secret", baseToken: "bascn_token", tableId: "tbl_table", apiBaseUrl: "https://example.test/open-apis" }, fakeFetch);
  const token = outboxClientToken(42);

  assert.equal(await client.createRequirement(requirement, token), "rec_123");
  await client.updateRequirement("rec_123", { ...requirement, status: "进行中" });
  await client.deleteRequirement("rec_123");

  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(outboxClientToken(42), token);
  assert.equal(calls.filter((call) => call.url.includes("tenant_access_token")).length, 1);
  assert.equal(calls[1].url, `https://example.test/open-apis/base/v3/bases/bascn_token/tables/tbl_table/records?client_token=${token}`);
  assert.equal(calls[1].init?.method, "POST");
  assert.equal(calls[2].init?.method, "PATCH");
  assert.equal(calls[3].init?.method, "DELETE");
  assert.equal((calls[1].init?.headers as Record<string, string>).authorization, "Bearer tenant-token");
  const createBody = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
  assert.equal(createBody["需求ID"], requirement.id);
  assert.deepEqual(createBody["投放平台"], ["Meta"]);
  assert.equal(createBody["创建时间"], "2026-08-05 01:02:03");
});

test("treats deleting an already absent Base record as success", async () => {
  const responses = [
    { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
    { code: 1254043, msg: "RecordIdNotFound" },
  ];
  const fakeFetch = (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as typeof fetch;
  const client = new FeishuBaseClient({ appId: "cli_app", appSecret: "secret", baseToken: "base", tableId: "table" }, fakeFetch);
  await client.deleteRequirement("rec_missing");
});

test("lists paginated Base fields and deletes by encoded field id", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
    { code: 0, data: { items: [{ field_id: "fld_1", name: "负责人" }], offset: 200, has_more: true } },
    { code: 0, data: { items: [{ field_id: "fld_2", name: "状态", is_primary: true }], has_more: false } },
    { code: 0, data: {} },
  ];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as typeof fetch;
  const client = new FeishuBaseClient({ appId: "cli_app", appSecret: "secret", baseToken: "base/token", tableId: "table", apiBaseUrl: "https://example.test/open-apis" }, fakeFetch);
  assert.deepEqual(await client.listFields(), [
    { fieldId: "fld_1", name: "负责人", type: undefined, isPrimary: false },
    { fieldId: "fld_2", name: "状态", type: undefined, isPrimary: true },
  ]);
  await client.deleteField("fld/2");
  assert.match(calls[1].url, /fields\?limit=200&offset=0$/);
  assert.match(calls[2].url, /fields\?limit=200&offset=200$/);
  assert.equal(calls[3].url, "https://example.test/open-apis/base/v3/bases/base%2Ftoken/tables/table/fields/fld%2F2");
  assert.equal(calls[3].init?.method, "DELETE");
});

test("worker consumes an outbox item and stores the remote record mapping", async () => {
  const item: BaseOutboxItem = { id: 7, requirementId: requirement.id, operation: "upsert", payload: requirement, attempts: 1, lockToken: "lease" };
  let completed: { item: BaseOutboxItem; recordId?: string } | undefined;
  const store: BaseOutboxStore = {
    async claimBaseOutbox() { return [item]; },
    async releaseBaseOutboxLease() {},
    async getBaseRecordId() { return undefined; },
    async completeBaseOutbox(completedItem, recordId) { completed = { item: completedItem, recordId }; },
    async failBaseOutbox() { assert.fail("failure should not be recorded"); },
  };
  let receivedToken = "";
  const client: BaseRecordClient = {
    async createRequirement(_requirement, clientToken) { receivedToken = clientToken; return "rec_created"; },
    async updateRequirement() { assert.fail("new records should be created"); },
    async deleteRequirement() { assert.fail("upsert should not delete"); },
  };
  await new BaseSyncWorker(store, client, silentLogger).runOnce();
  assert.equal(receivedToken, outboxClientToken(item.id));
  assert.equal(completed?.recordId, "rec_created");
});
