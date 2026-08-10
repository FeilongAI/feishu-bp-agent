import type { Logger } from "./logger.ts";
import type { McpToolProvider } from "./mcpClient.ts";
import { MAX_MESSAGE_NAME_CHARS, type IncomingMessage } from "./types.ts";
import type { AgentToolDefinition } from "./understanding.ts";

export interface SenderDirectory {
  enrich(message: IncomingMessage): Promise<IncomingMessage>;
}

interface CacheEntry {
  name?: string;
  expiresAt: number;
}

interface SenderDirectoryConfig {
  cacheTtlMs?: number;
  negativeCacheTtlMs?: number;
}

const SUPPORTED_TOOL_NAMES = new Set([
  "contact_v3_user_get",
  "contact_user_get",
  "get_user",
]);

function boundedDuration(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1_000, Math.min(Math.trunc(value!), maximum));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function findContactTool(tools: AgentToolDefinition[]): AgentToolDefinition | undefined {
  return tools.find((tool) => SUPPORTED_TOOL_NAMES.has(normalizedToolName(tool.function.name)));
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  return asObject(asObject(schema)?.properties) ?? {};
}

function requiredProperties(schema: unknown): string[] {
  const required = asObject(schema)?.required;
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
}

function buildFromSchema(schema: unknown, senderId: string, depth = 0): { value: Record<string, unknown>; foundId: boolean } {
  if (depth > 5) return { value: {}, foundId: false };
  const properties = schemaProperties(schema);
  const value: Record<string, unknown> = {};
  let foundId = false;

  for (const [key, childSchema] of Object.entries(properties)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized === "userid") {
      value[key] = senderId;
      foundId = true;
      continue;
    }
    if (normalized === "useridtype") {
      value[key] = "open_id";
      continue;
    }
    if (Object.keys(schemaProperties(childSchema)).length) {
      const child = buildFromSchema(childSchema, senderId, depth + 1);
      if (Object.keys(child.value).length) value[key] = child.value;
      foundId ||= child.foundId;
    }
  }

  return { value, foundId };
}

function satisfiesRequired(schema: unknown, value: Record<string, unknown>, depth = 0): boolean {
  if (depth > 5) return false;
  for (const key of requiredProperties(schema)) {
    if (!(key in value)) return false;
  }
  for (const [key, childValue] of Object.entries(value)) {
    const childSchema = schemaProperties(schema)[key];
    const childObject = asObject(childValue);
    if (childObject && !satisfiesRequired(childSchema, childObject, depth + 1)) return false;
  }
  return true;
}

export function buildContactLookupArguments(parameters: Record<string, unknown>, senderId: string): Record<string, unknown> | undefined {
  const built = buildFromSchema(parameters, senderId);
  if (!built.foundId || !satisfiesRequired(parameters, built.value)) return undefined;
  return built.value;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { /* try a fenced or diagnostic-wrapped payload */ }
  const unfenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  if (unfenced) {
    try { return JSON.parse(unfenced); } catch { return undefined; }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return undefined; }
  }
  return undefined;
}

function resultRoots(result: unknown): unknown[] {
  const wrapper = asObject(result);
  if (!wrapper || wrapper.ok === false) return [];
  const roots: unknown[] = [];
  if (wrapper.structuredContent !== undefined) roots.push(wrapper.structuredContent);
  if (Array.isArray(wrapper.content)) {
    for (const block of wrapper.content) {
      const item = asObject(block);
      if (typeof item?.text === "string") {
        const parsed = parseJsonText(item.text);
        if (parsed !== undefined) roots.push(parsed);
      }
    }
  }
  if (!roots.length) roots.push(result);
  return roots;
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().replaceAll("\u0000", "");
  return name ? name.slice(0, MAX_MESSAGE_NAME_CHARS) : undefined;
}

function nameFromUser(user: Record<string, unknown>): string | undefined {
  const localized = asObject(user.name_i18n) ?? asObject(user.nameI18n) ?? {};
  for (const value of [user.name, user.display_name, user.displayName, user.user_name, user.userName, localized.zh_cn, localized["zh-CN"], localized.en_us, localized["en-US"]]) {
    const name = cleanName(value);
    if (name) return name;
  }
  return undefined;
}

export function extractMcpSenderName(result: unknown, senderId: string): string | undefined {
  const pending = resultRoots(result).map((value) => ({ value, depth: 0 }));
  let visited = 0;
  while (pending.length && visited < 300) {
    const current = pending.shift()!;
    visited += 1;
    if (current.depth > 8) continue;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    const object = asObject(current.value);
    if (!object) continue;
    const openId = object.open_id ?? object.openId;
    if (typeof openId === "string" && openId === senderId) {
      const name = nameFromUser(object);
      if (name) return name;
    }
    for (const child of Object.values(object)) {
      if (child && typeof child === "object") pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

export class McpSenderDirectory implements SenderDirectory {
  private readonly provider: McpToolProvider;
  private readonly logger: Logger;
  private readonly cacheTtlMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string | undefined>>();

  constructor(provider: McpToolProvider, logger: Logger, config: SenderDirectoryConfig = {}) {
    this.provider = provider;
    this.logger = logger;
    this.cacheTtlMs = boundedDuration(config.cacheTtlMs, 86_400_000, 30 * 86_400_000);
    this.negativeCacheTtlMs = boundedDuration(config.negativeCacheTtlMs, 300_000, 3_600_000);
  }

  async enrich(message: IncomingMessage): Promise<IncomingMessage> {
    if (message.senderName || !message.senderId) return message;
    const now = Date.now();
    const cached = this.cache.get(message.senderId);
    if (cached && cached.expiresAt > now) return cached.name ? { ...message, senderName: cached.name } : message;

    let lookup = this.inFlight.get(message.senderId);
    if (!lookup) {
      lookup = this.lookup(message.senderId);
      this.inFlight.set(message.senderId, lookup);
    }
    let name: string | undefined;
    try {
      name = await lookup;
    } finally {
      if (this.inFlight.get(message.senderId) === lookup) this.inFlight.delete(message.senderId);
    }
    this.cache.set(message.senderId, { name, expiresAt: Date.now() + (name ? this.cacheTtlMs : this.negativeCacheTtlMs) });
    return name ? { ...message, senderName: name } : message;
  }

  private async lookup(senderId: string): Promise<string | undefined> {
    try {
      const tool = findContactTool(await this.provider.listTools());
      if (!tool) {
        this.logger.warn("sender_name_lookup_skipped", { reason: "contact_tool_not_exposed" });
        return undefined;
      }
      const args = buildContactLookupArguments(tool.function.parameters, senderId);
      if (!args) {
        this.logger.warn("sender_name_lookup_skipped", { tool: tool.function.name, reason: "unsupported_tool_schema" });
        return undefined;
      }
      const result = await this.provider.callTool(tool.function.name, JSON.stringify(args));
      const name = extractMcpSenderName(result, senderId);
      if (!name) this.logger.warn("sender_name_lookup_failed", { tool: tool.function.name, reason: "no_matching_user" });
      return name;
    } catch (error) {
      this.logger.warn("sender_name_lookup_failed", { reason: error instanceof Error ? error.name : "unknown" });
      return undefined;
    }
  }
}
