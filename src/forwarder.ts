import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ingressSignature } from "./auth.ts";
import type { Logger } from "./logger.ts";
import { normalizeLarkEvent } from "./lark.ts";
import { isSafeMessageIdentifier, MAX_MESSAGE_CONTENT_CHARS, MAX_MESSAGE_IDENTIFIER_CHARS, type BotReply, type IncomingMessage } from "./types.ts";

export interface CoreAgentConfig {
  url: string;
  ingressApiKey: string;
  ingressSigningSecret?: string;
  timeoutMs: number;
}

export interface DeliveryConfig {
  maxRetries: number;
  retryBaseMs: number;
}

export interface CoreAgent {
  process(message: IncomingMessage): Promise<BotReply>;
}

export interface ReplySender {
  reply(messageId: string, reply: BotReply): Promise<void>;
}

export interface SpoolStore {
  save(message: IncomingMessage): Promise<void>;
  remove(messageId: string): Promise<void>;
  list(): Promise<IncomingMessage[]>;
  count(): Promise<number>;
}

export type CommandRunner = (command: string, args: string[]) => Promise<{ code: number | null; stdout?: string; stderr: string }>;

class CoreAgentError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

function bounded(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spoolName(messageId: string): string {
  return `${createHash("sha256").update(messageId).digest("hex")}.json`;
}

function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.chatId === "string" && Boolean(item.chatId) && item.chatId.length <= MAX_MESSAGE_IDENTIFIER_CHARS && isSafeMessageIdentifier(item.chatId)
    && typeof item.senderId === "string" && Boolean(item.senderId) && item.senderId.length <= MAX_MESSAGE_IDENTIFIER_CHARS && isSafeMessageIdentifier(item.senderId)
    && typeof item.messageId === "string" && Boolean(item.messageId) && item.messageId.length <= MAX_MESSAGE_IDENTIFIER_CHARS && isSafeMessageIdentifier(item.messageId)
    && typeof item.content === "string" && Boolean(item.content.trim()) && item.content.length <= MAX_MESSAGE_CONTENT_CHARS;
}

export class CoreAgentHttpClient implements CoreAgent {
  private readonly config: CoreAgentConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: CoreAgentConfig, fetchImpl: typeof fetch = fetch) {
    if (!config.url.trim()) throw new Error("FORWARDER_CORE_URL is required");
    if (!config.ingressApiKey.trim()) throw new Error("INGRESS_API_KEY is required for the forwarder");
    this.config = {
      url: config.url.replace(/\/+$/, ""),
      ingressApiKey: config.ingressApiKey,
      ingressSigningSecret: config.ingressSigningSecret,
      timeoutMs: bounded(config.timeoutMs, 10_000, 500, 60_000),
    };
    this.fetchImpl = fetchImpl;
  }

  async process(message: IncomingMessage): Promise<BotReply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const body = JSON.stringify(message);
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.config.ingressApiKey}`,
        "content-type": "application/json",
        "x-request-id": `lark-${message.messageId}`.slice(0, 120),
      };
      if (this.config.ingressSigningSecret) headers["x-ingress-signature"] = ingressSignature(body, this.config.ingressSigningSecret);
      const response = await this.fetchImpl(`${this.config.url}/api/messages`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new CoreAgentError(`core_agent_http_${response.status}`, response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500);
      const payload = await response.json() as { ok?: unknown; reply?: { text?: unknown; replyInThread?: unknown } };
      if (payload.ok !== true || !payload.reply || typeof payload.reply.text !== "string") throw new CoreAgentError("core_agent_invalid_response", true);
      return { text: payload.reply.text, replyInThread: payload.reply.replyInThread === true };
    } catch (error) {
      if (error instanceof CoreAgentError) throw error;
      throw new CoreAgentError(error instanceof Error ? `core_agent_${error.name}` : "core_agent_unknown_error", true);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const runCommand: CommandRunner = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-20_000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4_000); });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
});

export class LarkCliReplySender implements ReplySender {
  private readonly bin: string;
  private readonly runner: CommandRunner;

  constructor(bin = "lark-cli", runner: CommandRunner = runCommand) {
    this.bin = bin;
    this.runner = runner;
  }

  async reply(messageId: string, reply: BotReply): Promise<void> {
    if (!reply.text) return;
    const key = `bp-${createHash("sha256").update(messageId).digest("hex").slice(0, 40)}`;
    const args = ["im", "+messages-reply", "--message-id", messageId, "--text", reply.text, "--as", "bot", "--idempotency-key", key];
    if (reply.replyInThread) args.push("--reply-in-thread");
    const result = await this.runner(this.bin, args);
    if (result.code !== 0) {
      let reason = "unknown";
      try {
        const parsed = JSON.parse(result.stderr) as { error?: { subtype?: unknown; type?: unknown } };
        reason = String(parsed.error?.subtype ?? parsed.error?.type ?? reason).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "unknown";
      } catch { /* keep a non-sensitive generic reason */ }
      throw new Error(`lark_reply_failed:${reason}:exit_${result.code}`);
    }
  }
}

export class LarkCliSenderDirectory {
  private readonly bin: string;
  private readonly runner: CommandRunner;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { name?: string; expiresAt: number }>();

  constructor(bin = "lark-cli", runner: CommandRunner = runCommand, cacheTtlMs = 86_400_000) {
    this.bin = bin;
    this.runner = runner;
    this.cacheTtlMs = Math.max(60_000, cacheTtlMs);
  }

  async enrich(message: IncomingMessage): Promise<IncomingMessage> {
    if (message.senderName || !message.senderId) return message;
    const now = Date.now();
    const cached = this.cache.get(message.senderId);
    if (cached && cached.expiresAt > now) return cached.name ? { ...message, senderName: cached.name } : message;
    const result = await this.runner(this.bin, ["contact", "+get-user", "--user-id", message.senderId, "--user-id-type", "open_id", "--as", "bot"]);
    const name = result.code === 0 ? extractUserName(result.stdout || "") : undefined;
    this.cache.set(message.senderId, { name, expiresAt: now + (name ? this.cacheTtlMs : 300_000) });
    return name ? { ...message, senderName: name } : message;
  }
}

function extractUserName(stdout: string): string | undefined {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : payload;
      const user = data.user && typeof data.user === "object" ? data.user as Record<string, unknown> : data;
      const localized = user.name_i18n && typeof user.name_i18n === "object" ? user.name_i18n as Record<string, unknown> : {};
      for (const value of [user.name, user.display_name, user.user_name, localized.zh_cn, localized["zh-CN"], localized.en_us]) {
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
      }
    } catch { /* CLI may include non-JSON diagnostics; try the next line */ }
  }
  return undefined;
}

export class FileSpoolStore implements SpoolStore {
  private readonly directory: string;

  constructor(directory: string) {
    if (!directory.trim()) throw new Error("FORWARDER_SPOOL_DIR is required");
    this.directory = directory;
  }

  async save(message: IncomingMessage): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = join(this.directory, spoolName(message.messageId));
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(message), { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async remove(messageId: string): Promise<void> {
    await rm(join(this.directory, spoolName(messageId)), { force: true });
  }

  async list(): Promise<IncomingMessage[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    const messages: IncomingMessage[] = [];
    for (const name of names) {
      try {
        const value = JSON.parse(await readFile(join(this.directory, name), "utf8"));
        if (!isIncomingMessage(value)) throw new Error("invalid_spool_item");
        messages.push(value);
      } catch {
        await rename(join(this.directory, name), join(this.directory, `${name}.invalid-${Date.now()}`)).catch(() => undefined);
      }
    }
    return messages;
  }

  async count(): Promise<number> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return (await readdir(this.directory)).filter((name) => name.endsWith(".json")).length;
  }
}

export class EventDeliveryService {
  private readonly spool: SpoolStore;
  private readonly core: CoreAgent;
  private readonly replies: ReplySender;
  private readonly logger: Logger;
  private readonly config: DeliveryConfig;
  private readonly directory?: LarkCliSenderDirectory;
  private readonly active = new Set<string>();

  constructor(spool: SpoolStore, core: CoreAgent, replies: ReplySender, logger: Logger, config: DeliveryConfig, directory?: LarkCliSenderDirectory) {
    this.spool = spool;
    this.core = core;
    this.replies = replies;
    this.logger = logger;
    this.directory = directory;
    this.config = {
      maxRetries: bounded(config.maxRetries, 5, 0, 10),
      retryBaseMs: bounded(config.retryBaseMs, 500, 10, 30_000),
    };
  }

  async accept(rawEvent: Record<string, unknown>): Promise<boolean> {
    const message = normalizeLarkEvent(rawEvent);
    if (!message) return true;
    return this.acceptMessage(message);
  }

  async acceptMessage(message: IncomingMessage): Promise<boolean> {
    const enriched = this.directory ? await this.directory.enrich(message).catch(() => message) : message;
    let saved = false;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        await this.spool.save(enriched);
        saved = true;
        break;
      } catch (error) {
        if (attempt === this.config.maxRetries) {
          this.logger.error("lark_event_spool_failed", { messageId: enriched.messageId, attempt: attempt + 1, error });
          throw error;
        }
        await delay(Math.min(this.config.retryBaseMs * (2 ** attempt), 30_000));
      }
    }
    if (!saved) return false;
    return this.deliver(enriched);
  }

  async replay(): Promise<void> {
    for (const message of await this.spool.list()) await this.deliver(message);
  }

  async pendingCount(): Promise<number> {
    return this.spool.count();
  }

  private async deliver(message: IncomingMessage): Promise<boolean> {
    if (this.active.has(message.messageId)) return false;
    this.active.add(message.messageId);
    try {
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
        try {
          const reply = await this.core.process(message);
          await this.replies.reply(message.messageId, reply);
          await this.spool.remove(message.messageId);
          this.logger.info("lark_event_delivered", { messageId: message.messageId, chatId: message.chatId });
          return true;
        } catch (error) {
          const retryable = !(error instanceof CoreAgentError) || error.retryable;
          if (!retryable || attempt === this.config.maxRetries) {
            this.logger.error("lark_event_delivery_failed", { messageId: message.messageId, attempt: attempt + 1, retryable, error });
            return false;
          }
          await delay(Math.min(this.config.retryBaseMs * (2 ** attempt), 30_000));
        }
      }
      return false;
    } finally {
      this.active.delete(message.messageId);
    }
  }
}
