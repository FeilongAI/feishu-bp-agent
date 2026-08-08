import assert from "node:assert/strict";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { ConfirmationService } from "../src/confirmation.ts";
import { ingressSignature } from "../src/auth.ts";
import { ConversationService } from "../src/conversation.ts";
import { createHttpServer } from "../src/http.ts";
import type { Logger } from "../src/logger.ts";
import { MessageProcessor } from "../src/messageProcessor.ts";
import { InMemoryRequirementStore } from "../src/store.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const adminKey = "admin-key-with-at-least-24-characters";
const ingressKey = "ingress-key-with-at-least-24-chars";

async function request(server: Server, input: { method: string; url: string; headers?: Record<string, string>; body?: unknown }) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    const payload = input.body === undefined ? "" : JSON.stringify(input.body);
    const incoming = Readable.from(payload ? [payload] : []) as IncomingMessage;
    Object.assign(incoming, { method: input.method, url: input.url, headers: input.headers ?? {} });
    let status = 0;
    const response = {
      writeHead(code: number) { status = code; return this; },
      end(data: string) { resolve({ status, body: JSON.parse(data) as Record<string, unknown> }); },
    } as unknown as ServerResponse;
    server.emit("request", incoming, response);
  });
}

test("protects APIs and requires confirmation for requirement mutations", async () => {
  const store = new InMemoryRequirementStore();
  const service = new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" });
  const processor = new MessageProcessor(store, service, {
    allowedTenantKeys: new Set(), allowedUserIds: new Set(), allowedChatIds: new Set(), groupRequireMention: false,
  }, silentLogger);
  const server = createHttpServer(processor, store, {
    auth: { adminApiKey: adminKey, ingressApiKey: ingressKey },
    confirmation: new ConfirmationService("a-secure-confirmation-secret-with-32-chars"),
    logger: silentLogger,
  });

  assert.equal((await request(server, { method: "GET", url: "/healthz" })).status, 200);
  assert.equal((await request(server, { method: "GET", url: "/api/requirements" })).status, 401);
  assert.equal((await request(server, { method: "POST", url: "/api/messages", body: {} })).status, 401);
  const oversized = await request(server, {
    method: "POST", url: "/api/messages", headers: { authorization: `Bearer ${ingressKey}` },
    body: { chat_id: "oc_test", sender_id: "ou_user", message_id: "om_long", content: "x".repeat(20_001) },
  });
  assert.equal(oversized.status, 400);

  const requirement = await store.createRequirement({
    title: "测试需求", goal: "验证管理接口", scope: "API", acceptanceCriteria: "状态可更新", requesterId: "ou_user",
    platforms: [], status: "待评估", visibility: "public", sourceChatId: "oc_test", sourceMessageId: "om_test",
  });
  const patch = { status: "进行中", progress: "开发中" };
  const adminHeaders = { authorization: `Bearer ${adminKey}`, "content-type": "application/json", "x-actor-id": "ou_admin" };
  const unconfirmed = await request(server, { method: "PATCH", url: `/api/requirements/${requirement.id}`, headers: adminHeaders, body: patch });
  assert.equal(unconfirmed.status, 409);

  const issued = await request(server, {
    method: "POST", url: "/api/admin/confirmations", headers: adminHeaders,
    body: { action: "PATCH_REQUIREMENT", resourceId: requirement.id, body: patch },
  });
  assert.equal(issued.status, 201);
  const updated = await request(server, {
    method: "PATCH", url: `/api/requirements/${requirement.id}`,
    headers: { ...adminHeaders, "x-confirmation-token": String(issued.body.token) }, body: patch,
  });
  assert.equal(updated.status, 200);
  assert.equal((await store.listRequirements())[0].status, "进行中");
  server.close();
});

test("requires a valid ingress signature and explicit message identity enums", async () => {
  const store = new InMemoryRequirementStore();
  const processor = new MessageProcessor(store, new ConversationService(store, { ownerId: "ou_owner", ownerName: "韩飞龙" }), {
    allowedTenantKeys: new Set(), allowedUserIds: new Set(), allowedChatIds: new Set(), groupRequireMention: false,
  }, silentLogger);
  const secret = "ingress-signing-secret-with-at-least-32-chars";
  const server = createHttpServer(processor, store, {
    auth: { adminApiKey: adminKey, ingressApiKey: ingressKey },
    confirmation: new ConfirmationService("a-secure-confirmation-secret-with-32-chars"),
    logger: silentLogger, ingressSigningSecret: secret, requireIngressSignature: true,
  });
  const body = { chatId: "oc_test", chatType: "p2p", senderId: "ou_user", senderType: "user", messageId: "om_ingress", content: "你好" };
  const raw = JSON.stringify(body);
  const headers = { authorization: `Bearer ${ingressKey}`, "content-type": "application/json" };
  assert.equal((await request(server, { method: "POST", url: "/api/messages", headers, body })).status, 401);
  assert.equal((await request(server, { method: "POST", url: "/api/messages", headers: { ...headers, "x-ingress-signature": ingressSignature(raw, secret).replace(/.$/, "0") }, body })).status, 401);
  const invalidBody = { ...body, chatType: "unknown" };
  assert.equal((await request(server, { method: "POST", url: "/api/messages", headers: { ...headers, "x-ingress-signature": ingressSignature(JSON.stringify(invalidBody), secret) }, body: invalidBody })).status, 400);
  assert.equal((await request(server, { method: "POST", url: "/api/messages", headers: { ...headers, "x-ingress-signature": ingressSignature(raw, secret) }, body })).status, 200);
  server.close();
});
