import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type ApiRole = "admin" | "ingress";

export interface ApiAuthConfig {
  adminApiKey: string;
  ingressApiKey: string;
}

export interface AuthResult {
  authenticated: boolean;
  actorId: string;
}

function equalSecret(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function presentedKey(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  const header = request.headers["x-api-key"];
  return Array.isArray(header) ? header[0] ?? "" : header ?? "";
}

export function authenticateRequest(request: IncomingMessage, role: ApiRole, config: ApiAuthConfig): AuthResult {
  const expected = role === "admin" ? config.adminApiKey : config.ingressApiKey;
  const actorHeader = request.headers["x-actor-id"];
  const actorId = (Array.isArray(actorHeader) ? actorHeader[0] : actorHeader) || `${role}-api`;
  return { authenticated: equalSecret(presentedKey(request), expected), actorId };
}

export function validateAuthConfig(config: ApiAuthConfig): void {
  if (!config.adminApiKey || config.adminApiKey.length < 24) throw new Error("ADMIN_API_KEY must be at least 24 characters");
  if (!config.ingressApiKey || config.ingressApiKey.length < 24) throw new Error("INGRESS_API_KEY must be at least 24 characters");
  if (equalSecret(config.adminApiKey, config.ingressApiKey)) throw new Error("ADMIN_API_KEY and INGRESS_API_KEY must be different");
}
