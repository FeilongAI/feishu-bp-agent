import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { IncomingMessage } from "./types.ts";

export interface LarkClient {
  start(onMessage: (message: IncomingMessage) => Promise<void> | void): ChildProcessWithoutNullStreams;
  reply(messageId: string, text: string): Promise<void>;
}

export class LarkCliClient implements LarkClient {
  private readonly bin: string;

  constructor(bin = process.env.LARK_CLI_BIN || "lark-cli") {
    this.bin = bin;
  }

  start(onMessage: (message: IncomingMessage) => Promise<void> | void): ChildProcessWithoutNullStreams {
    const child = spawn(this.bin, ["event", "consume", process.env.LARK_EVENT_KEY || "im.message.receive_v1", "--as", "bot"], { stdio: "pipe" });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.sender_type === "bot") return;
        void onMessage({ chatId: String(event.chat_id), senderId: String(event.sender_id), messageId: String(event.message_id), content: String(event.content ?? ""), senderType: event.sender_type === "bot" ? "bot" : "user", threadId: typeof event.thread_id === "string" ? event.thread_id : undefined });
      } catch (error) {
        process.stderr.write(`[lark] invalid event: ${String(error)}\n`);
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(`[lark] ${chunk}`));
    return child;
  }

  reply(messageId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, ["im", "+messages-reply", "--message-id", messageId, "--text", text, "--as", "bot", "--idempotency-key", `bp-agent-${messageId}`], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `lark reply exited with ${code}`)));
    });
  }
}
