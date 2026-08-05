import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from "node:http";
import type { ConversationService } from "./conversation.ts";
import type { IncomingMessage, RequirementStore, RequirementStatus } from "./types.ts";

async function readJson(request: HttpRequest): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body ? JSON.parse(body) : {};
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

export function createHttpServer(service: ConversationService, store: RequirementStore) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") return json(response, 200, { ok: true, service: "feishu-bp-agent" });
      if (request.method === "GET" && request.url?.startsWith("/api/requirements")) {
        const url = new URL(request.url, "http://localhost");
        const status = url.searchParams.get("status") as RequirementStatus | null;
        const requesterId = url.searchParams.get("requesterId") || undefined;
        return json(response, 200, { ok: true, requirements: store.listRequirements({ status: status || undefined, requesterId }) });
      }
      const updateMatch = request.method === "PATCH" ? request.url?.match(/^\/api\/requirements\/([^/]+)$/) : null;
      if (updateMatch) {
        const patch = await readJson(request) as Parameters<RequirementStore["updateRequirement"]>[1];
        const updated = store.updateRequirement(decodeURIComponent(updateMatch[1]), patch);
        return updated ? json(response, 200, { ok: true, requirement: updated }) : json(response, 404, { ok: false, error: "requirement_not_found" });
      }
      if (request.method === "POST" && request.url === "/api/messages") {
        const body = await readJson(request) as Partial<IncomingMessage>;
        if (!body.chatId || !body.senderId || !body.messageId || typeof body.content !== "string") return json(response, 400, { ok: false, error: "chatId, senderId, messageId and content are required" });
        const reply = service.handleMessage(body as IncomingMessage);
        return json(response, 200, { ok: true, reply });
      }
      return json(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      return json(response, 500, { ok: false, error: String(error) });
    }
  });
}
