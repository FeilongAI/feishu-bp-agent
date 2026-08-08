import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

interface ConfirmationPayload {
  id: string;
  action: string;
  actorId: string;
  bodyHash: string;
  expiresAt: number;
  resourceId: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function encode(value: string): string { return Buffer.from(value).toString("base64url"); }
function sign(encodedPayload: string, secret: string): Buffer { return createHmac("sha256", secret).update(encodedPayload).digest(); }

export function hashConfirmationBody(body: unknown): string {
  return createHmac("sha256", "feishu-bp-agent-body-v1").update(stableJson(body)).digest("base64url");
}

export class ConfirmationService {
  private readonly secret: string;
  private readonly ttlSeconds: number;
  private readonly consumed = new Map<string, number>();

  constructor(secret: string, ttlSeconds = 300) {
    if (secret.length < 32) throw new Error("CONFIRMATION_SECRET must be at least 32 characters");
    this.secret = secret;
    this.ttlSeconds = ttlSeconds;
  }

  issue(input: { action: string; actorId: string; resourceId: string; body: unknown }, now = Date.now()): { token: string; expiresAt: string } {
    const payload: ConfirmationPayload = {
      id: randomUUID(),
      action: input.action,
      actorId: input.actorId,
      bodyHash: hashConfirmationBody(input.body),
      expiresAt: now + this.ttlSeconds * 1000,
      resourceId: input.resourceId,
    };
    const encoded = encode(JSON.stringify(payload));
    return { token: `${encoded}.${sign(encoded, this.secret).toString("base64url")}`, expiresAt: new Date(payload.expiresAt).toISOString() };
  }

  verify(token: string, expected: { action: string; actorId: string; resourceId: string; body: unknown }, now = Date.now()): boolean {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) return false;
    const actual = Buffer.from(signature, "base64url");
    const wanted = sign(encoded, this.secret);
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ConfirmationPayload;
      return payload.expiresAt >= now
        && payload.action === expected.action
        && payload.actorId === expected.actorId
        && payload.resourceId === expected.resourceId
        && payload.bodyHash === hashConfirmationBody(expected.body);
    } catch {
      return false;
    }
  }

  consume(token: string, expected: { action: string; actorId: string; resourceId: string; body: unknown }, now = Date.now()): boolean {
    for (const [key, expiresAt] of this.consumed) if (expiresAt < now) this.consumed.delete(key);
    if (!this.verify(token, expected, now) || this.consumed.has(token)) return false;
    this.consumed.set(token, now + this.ttlSeconds * 1000);
    return true;
  }
}
