import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "./logger.ts";
import { isSafeMessageIdentifier, MAX_MESSAGE_CONTENT_CHARS, MAX_MESSAGE_IDENTIFIER_CHARS, MAX_MESSAGE_MENTIONS, MAX_MESSAGE_NAME_CHARS, type IncomingMessage } from "./types.ts";

export interface LarkClient {
  start(onMessage: (message: IncomingMessage) => Promise<void> | void): ChildProcessWithoutNullStreams;
  reply(messageId: string, text: string): Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function textContent(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.text === "string" ? parsed.text : raw;
  } catch {
    return raw;
  }
}

export function normalizeLarkEvent(input: Record<string, unknown>): IncomingMessage | undefined {
  const envelope = object(input.event ?? input);
  const message = object(envelope.message ?? envelope);
  const sender = object(envelope.sender);
  const senderId = object(sender.sender_id);
  const header = object(input.header);
  const senderType = String(sender.sender_type ?? envelope.sender_type ?? "user");
  if (senderType === "bot" || senderType === "app") return undefined;
  const messageType = message.message_type ?? envelope.message_type;
  if (typeof messageType === "string" && messageType !== "text") return undefined;
  const chatId = message.chat_id ?? envelope.chat_id;
  const messageId = message.message_id ?? envelope.message_id;
  const openId = senderId.open_id ?? envelope.sender_id;
  const content = textContent(message.content ?? envelope.content);
  const chatType = message.chat_type ?? envelope.chat_type;
  const senderTypeValue = message.sender_type ?? envelope.sender_type;
  if (chatType !== undefined && chatType !== "group" && chatType !== "p2p") return undefined;
  if (senderTypeValue !== undefined && senderTypeValue !== "user") return undefined;
  const threadId = message.thread_id ?? message.root_id;
  const tenantKey = header.tenant_key;
  if (typeof chatId !== "string" || !chatId || chatId.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(chatId)
    || typeof messageId !== "string" || !messageId || messageId.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(messageId)
    || typeof openId !== "string" || !openId || openId.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(openId)
    || (threadId !== undefined && (typeof threadId !== "string" || threadId.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(threadId)))
    || (tenantKey !== undefined && (typeof tenantKey !== "string" || tenantKey.length > MAX_MESSAGE_IDENTIFIER_CHARS || !isSafeMessageIdentifier(tenantKey)))
    || !content.trim() || content.length > MAX_MESSAGE_CONTENT_CHARS) return undefined;
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.slice(0, MAX_MESSAGE_MENTIONS).flatMap((item) => {
      const mention = object(item);
      const id = object(mention.id).open_id ?? mention.open_id ?? mention.id;
      return typeof id === "string" && isSafeMessageIdentifier(id) ? [{ id, name: typeof mention.name === "string" ? mention.name.slice(0, MAX_MESSAGE_NAME_CHARS) : undefined }] : [];
    })
    : undefined;
  return {
    chatId,
    chatType: chatType === "group" ? "group" : "p2p",
    tenantKey: typeof tenantKey === "string" ? tenantKey : undefined,
    senderId: openId,
    senderName: typeof sender.sender_name === "string" && sender.sender_name.length <= MAX_MESSAGE_NAME_CHARS ? sender.sender_name : undefined,
    messageId,
    content,
    senderType: "user",
    threadId: typeof threadId === "string" ? threadId : undefined,
    mentions,
  };
}

export class LarkCliClient implements LarkClient {
  private readonly bin: string;
  private readonly logger: Logger;

  constructor(logger: Logger, bin = process.env.LARK_CLI_BIN || "lark-cli") {
    this.logger = logger;
    this.bin = bin;
  }

  start(onMessage: (message: IncomingMessage) => Promise<void> | void): ChildProcessWithoutNullStreams {
    const child = spawn(this.bin, ["event", "consume", process.env.LARK_EVENT_KEY || "im.message.receive_v1", "--as", "bot"], { stdio: "pipe" });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = normalizeLarkEvent(JSON.parse(line) as Record<string, unknown>);
        if (message) void Promise.resolve(onMessage(message)).catch((error) => this.logger.error("lark_message_callback_failed", { messageId: message.messageId, error }));
      } catch (error) {
        this.logger.warn("lark_event_invalid", { error });
      }
    });
    child.on("error", (error) => this.logger.error("lark_consumer_failed", { error }));
    child.stderr.on("data", (chunk) => this.logger.warn("lark_consumer_stderr", { output: String(chunk) }));
    return child;
  }

  reply(messageId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, ["im", "+messages-reply", "--message-id", messageId, "--text", text, "--as", "bot", "--idempotency-key", `bp-agent-${messageId}`], { stdio: ["ignore", "pipe", "pipe"] });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`lark_reply_failed:exit_${code ?? "unknown"}`)));
    });
  }
}
