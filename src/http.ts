import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { authenticateRequest, verifyIngressSignature, type ApiAuthConfig, type ApiRole } from "./auth.ts";
import type { ConfirmationService } from "./confirmation.ts";
import type { Logger } from "./logger.ts";
import type { MessageProcessor } from "./messageProcessor.ts";
import { isSafeMessageIdentifier, MAX_MESSAGE_CONTENT_CHARS, MAX_MESSAGE_IDENTIFIER_CHARS, MAX_MESSAGE_MENTIONS, MAX_MESSAGE_NAME_CHARS, type IncomingMessage, type RequirementStore, type RequirementStatus } from "./types.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const REQUIREMENT_STATUSES = new Set<RequirementStatus>(["待评估", "已排期", "进行中", "待验收", "已完成", "暂缓"]);
const PATCH_FIELDS = new Set(["status", "ownerId", "ownerName", "progress", "desiredDate", "priority", "visibility"]);

export interface HttpServerOptions {
  auth: ApiAuthConfig;
  confirmation: ConfirmationService;
  logger: Logger;
  ingressSigningSecret?: string;
  requireIngressSignature?: boolean;
}

async function readJson(request: HttpRequest): Promise<unknown> {
  const body = await readBody(request);
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

async function readBody(request: HttpRequest): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new HttpError(413, "request_too_large");
  }
  return body;
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function normalizedMessage(body: Record<string, unknown>): IncomingMessage {
  const value = (camel: string, snake: string) => body[camel] ?? body[snake];
  const chatId = value("chatId", "chat_id");
  const senderId = value("senderId", "sender_id");
  const messageId = value("messageId", "message_id");
  const content = body.content;
  if (typeof chatId !== "string" || !chatId || chatId.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(chatId)
    || typeof senderId !== "string" || !senderId || senderId.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(senderId)
    || typeof messageId !== "string" || !messageId || messageId.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(messageId)
    || typeof content !== "string" || !content.trim() || content.length > MAX_MESSAGE_CONTENT_CHARS) {
    throw new HttpError(400, "chatId, senderId, messageId and content are required");
  }
  const chatTypeValue = value("chatType", "chat_type");
  const senderTypeValue = value("senderType", "sender_type");
  if (chatTypeValue !== "p2p" && chatTypeValue !== "group") throw new HttpError(400, "invalid_chat_type");
  if (senderTypeValue !== "user" && senderTypeValue !== "bot") throw new HttpError(400, "invalid_sender_type");
  const tenantKey = value("tenantKey", "tenant_key");
  const threadId = value("threadId", "thread_id");
  if (tenantKey !== undefined && (typeof tenantKey !== "string" || tenantKey.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(tenantKey))) throw new HttpError(400, "invalid_tenant_key");
  if (threadId !== undefined && (typeof threadId !== "string" || threadId.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(threadId))) throw new HttpError(400, "invalid_thread_id");
  const mentions = Array.isArray(body.mentions)
    ? body.mentions.slice(0, MAX_MESSAGE_MENTIONS).flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string" && isSafeMessageIdentifier(String((item as Record<string, unknown>).id))
      ? [{ id: String((item as Record<string, unknown>).id), name: typeof (item as Record<string, unknown>).name === "string" ? String((item as Record<string, unknown>).name).slice(0, MAX_MESSAGE_NAME_CHARS) : undefined }]
      : [])
    : undefined;
  return {
    chatId,
    senderId,
    messageId,
    content,
    chatType: chatTypeValue === "group" ? "group" : "p2p",
    tenantKey: typeof tenantKey === "string" ? tenantKey : undefined,
    senderName: typeof value("senderName", "sender_name") === "string" && String(value("senderName", "sender_name")).length <= MAX_MESSAGE_NAME_CHARS ? String(value("senderName", "sender_name")) : undefined,
    senderType: senderTypeValue === "bot" ? "bot" : "user",
    threadId: typeof threadId === "string" ? threadId : undefined,
    mentions,
  };
}

function validatePatch(body: unknown): Parameters<RequirementStore["updateRequirement"]>[1] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_patch");
  const patch = body as Record<string, unknown>;
  if (!Object.keys(patch).length || Object.keys(patch).some((key) => !PATCH_FIELDS.has(key))) throw new HttpError(400, "invalid_patch_fields");
  if (patch.status !== undefined && !REQUIREMENT_STATUSES.has(patch.status as RequirementStatus)) throw new HttpError(400, "invalid_status");
  if (patch.visibility !== undefined && !["public", "requester", "private"].includes(String(patch.visibility))) throw new HttpError(400, "invalid_visibility");
  return patch as Parameters<RequirementStore["updateRequirement"]>[1];
}

export function createHttpServer(processor: MessageProcessor, store: RequirementStore, options: HttpServerOptions) {
  return createServer(async (request, response) => {
    const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
    const requireAuth = async (role: ApiRole): Promise<string | undefined> => {
      const result = authenticateRequest(request, role, options.auth);
      if (result.authenticated) return result.actorId;
      if (role === "admin") await store.recordAudit({ actorId: result.actorId, action: `${request.method} ${request.url}`, result: "denied" }).catch(() => undefined);
      json(response, 401, { ok: false, error: "unauthorized", requestId });
      return undefined;
    };

    try {
      if (request.method === "GET" && request.url === "/healthz") {
        await store.healthCheck();
        return json(response, 200, { ok: true, service: "feishu-bp-agent" });
      }

      if (request.method === "POST" && request.url === "/api/messages") {
        if (!await requireAuth("ingress")) return;
        const raw = await readBody(request);
        if (options.requireIngressSignature && !verifyIngressSignature(raw, typeof request.headers["x-ingress-signature"] === "string" ? request.headers["x-ingress-signature"] : undefined, options.ingressSigningSecret || "")) {
          return json(response, 401, { ok: false, error: "invalid_ingress_signature", requestId });
        }
        let body: unknown;
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "invalid_json"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_message");
        const reply = await processor.process(normalizedMessage(body as Record<string, unknown>));
        return json(response, 200, { ok: true, reply });
      }

      if (request.method === "GET" && (request.url === "/api/requirements" || request.url?.startsWith("/api/requirements?"))) {
        if (!await requireAuth("admin")) return;
        const url = new URL(request.url, "http://localhost");
        const status = url.searchParams.get("status") as RequirementStatus | null;
        if (status && !REQUIREMENT_STATUSES.has(status)) throw new HttpError(400, "invalid_status");
        const requesterId = url.searchParams.get("requesterId") || undefined;
        return json(response, 200, { ok: true, requirements: await store.listRequirements({ status: status || undefined, requesterId }) });
      }

      if (request.method === "POST" && request.url === "/api/admin/confirmations") {
        const actorId = await requireAuth("admin");
        if (!actorId) return;
        const rawBody = await readJson(request);
        if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) throw new HttpError(400, "invalid_confirmation_request");
        const body = rawBody as Record<string, unknown>;
        if (!["PATCH_REQUIREMENT", "DELETE_REQUIREMENT"].includes(String(body.action)) || typeof body.resourceId !== "string") throw new HttpError(400, "invalid_confirmation_request");
        const confirmation = options.confirmation.issue({ action: String(body.action), actorId, resourceId: body.resourceId, body: body.body ?? {} });
        await store.recordAudit({ actorId, action: "ISSUE_CONFIRMATION", resourceId: body.resourceId, payload: { operation: body.action }, result: "success" });
        return json(response, 201, { ok: true, ...confirmation });
      }

      const mutationMatch = request.url?.match(/^\/api\/requirements\/([^/?]+)$/);
      if (mutationMatch && (request.method === "PATCH" || request.method === "DELETE")) {
        const actorId = await requireAuth("admin");
        if (!actorId) return;
        let id: string;
        try {
          id = decodeURIComponent(mutationMatch[1]);
        } catch {
          throw new HttpError(400, "invalid_requirement_id");
        }
        const body = request.method === "PATCH" ? validatePatch(await readJson(request)) : {};
        const action = request.method === "PATCH" ? "PATCH_REQUIREMENT" : "DELETE_REQUIREMENT";
        const confirmationHeader = request.headers["x-confirmation-token"];
        const confirmationToken = Array.isArray(confirmationHeader) ? confirmationHeader[0] : confirmationHeader;
        if (!confirmationToken || !await options.confirmation.consumePersistent(confirmationToken, { action, actorId, resourceId: id, body }, store)) {
          await store.recordAudit({ actorId, action, resourceId: id, payload: body, result: "denied" });
          return json(response, 409, { ok: false, error: "confirmation_required", requestId });
        }
        if (request.method === "PATCH") {
          const updated = await store.updateRequirement(id, body as Parameters<RequirementStore["updateRequirement"]>[1]);
          await store.recordAudit({ actorId, action, resourceId: id, payload: body, result: updated ? "success" : "failed" });
          return updated ? json(response, 200, { ok: true, requirement: updated }) : json(response, 404, { ok: false, error: "requirement_not_found" });
        }
        const deleted = await store.deleteRequirement(id);
        await store.recordAudit({ actorId, action, resourceId: id, result: deleted ? "success" : "failed" });
        return deleted ? json(response, 200, { ok: true }) : json(response, 404, { ok: false, error: "requirement_not_found" });
      }

      return json(response, 404, { ok: false, error: "not_found", requestId });
    } catch (error) {
      if (error instanceof HttpError) return json(response, error.status, { ok: false, error: error.code, requestId });
      options.logger.error("http_request_failed", { requestId, method: request.method, path: request.url, error });
      return json(response, 500, { ok: false, error: "internal_error", requestId });
    }
  });
}
