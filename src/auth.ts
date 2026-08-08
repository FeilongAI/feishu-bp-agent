import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type ApiRole = "admin" | "ingress";

export interface ApiAuthConfig {
  adminApiKey: string;
  ingressApiKey: string;
}

export function ingressSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyIngressSignature(rawBody: string, presented: string | undefined, secret: string): boolean {
  if (!secret || !presented) return false;
  if (!/^sha256=[0-9a-f]{64}$/i.test(presented)) return false;
  const expected = ingressSignature(rawBody, secret);
  const actualHex = presented.slice(7).toLowerCase();
  const actual = Buffer.from(actualHex, "hex");
  const wanted = Buffer.from(expected.slice(7), "hex");
  if (actual.toString("hex") !== actualHex) return false;
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
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
  const actorId = role === "admin" ? "admin-api" : "ingress-forwarder";
  return { authenticated: equalSecret(presentedKey(request), expected), actorId };
}

export function validateAuthConfig(config: ApiAuthConfig): void {
  if (!config.adminApiKey || config.adminApiKey.length < 24) throw new Error("ADMIN_API_KEY must be at least 24 characters");
  if (!config.ingressApiKey || config.ingressApiKey.length < 24) throw new Error("INGRESS_API_KEY must be at least 24 characters");
  if (equalSecret(config.adminApiKey, config.ingressApiKey)) throw new Error("ADMIN_API_KEY and INGRESS_API_KEY must be different");
}
