import { validateAuthConfig } from "./auth.ts";
import { BaseSyncWorker, isBaseOutboxStore } from "./baseSync.ts";
import { ConfirmationService } from "./confirmation.ts";
import { ConversationService } from "./conversation.ts";
import { FeishuBaseClient, parseBaseFieldMap } from "./feishuBase.ts";
import { createHttpServer } from "./http.ts";
import { LarkCliClient } from "./lark.ts";
import { logger } from "./logger.ts";
import { MessageProcessor } from "./messageProcessor.ts";
import { csvSet } from "./permissions.ts";
import { PostgresRequirementStore } from "./postgres.ts";
import { InMemoryRequirementStore } from "./store.ts";
import { OpenAICompatibleAgentClient, OpenAICompatibleUnderstandingClient } from "./understanding.ts";
import { LarkMcpClient, parseMcpToolAllowlist } from "./mcpClient.ts";

const auth = {
  adminApiKey: process.env.ADMIN_API_KEY || "",
  ingressApiKey: process.env.INGRESS_API_KEY || "",
};
validateAuthConfig(auth);

if (process.env.NODE_ENV === "production") {
  const productionSecrets = {
    ADMIN_API_KEY: auth.adminApiKey,
    INGRESS_API_KEY: auth.ingressApiKey,
    CONFIRMATION_SECRET: process.env.CONFIRMATION_SECRET || "",
    DATABASE_URL: process.env.DATABASE_URL || "",
    ...(process.env.BASE_SYNC_ENABLED === "true" || process.env.BASE_ADMIN_ENABLED === "true" ? { FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || "" } : {}),
    ...(process.env.LLM_ENABLED === "true" ? { LLM_API_KEY: process.env.LLM_API_KEY || "" } : {}),
  };
  const invalid = Object.entries(productionSecrets)
    .filter(([, value]) => !value || /change_me|replace_with/i.test(value))
    .map(([name]) => name);
  if (invalid.length) throw new Error(`Production secrets are missing or still placeholders: ${invalid.join(", ")}`);
}

const store = process.env.DATABASE_URL
  ? new PostgresRequirementStore(process.env.DATABASE_URL)
  : new InMemoryRequirementStore(process.env.DATA_FILE || "data/state.json");
const baseSyncEnabled = process.env.BASE_SYNC_ENABLED === "true";
const baseAdminEnabled = process.env.BASE_ADMIN_ENABLED === "true";
const baseUrl = process.env.FEISHU_BASE_URL || (process.env.FEISHU_BASE_TOKEN && process.env.FEISHU_BASE_TABLE_ID
  ? `https://feishu.cn/base/${encodeURIComponent(process.env.FEISHU_BASE_TOKEN)}?table=${encodeURIComponent(process.env.FEISHU_BASE_TABLE_ID)}`
  : undefined);
let baseClient: FeishuBaseClient | undefined;
if (baseSyncEnabled || baseAdminEnabled) {
  if (!isBaseOutboxStore(store)) throw new Error("BASE_SYNC_ENABLED or BASE_ADMIN_ENABLED requires DATABASE_URL and PostgreSQL storage");
  const required = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BASE_TOKEN", "FEISHU_BASE_TABLE_ID"] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Base configuration missing: ${missing.join(", ")}`);
  baseClient = new FeishuBaseClient({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    baseToken: process.env.FEISHU_BASE_TOKEN!,
    tableId: process.env.FEISHU_BASE_TABLE_ID!,
    apiBaseUrl: process.env.FEISHU_API_BASE_URL,
    fieldMap: parseBaseFieldMap(process.env.FEISHU_BASE_FIELD_MAP),
    requestTimeoutMs: Number(process.env.FEISHU_API_TIMEOUT_MS || 15_000),
  });
}
const understanding = process.env.LLM_ENABLED === "true"
  ? new OpenAICompatibleUnderstandingClient({
    baseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "",
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 8_000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES || 1),
    maxInputChars: Number(process.env.LLM_MAX_INPUT_CHARS || 6_000),
  }, logger)
  : undefined;
const agent = process.env.LLM_ENABLED === "true" && process.env.LLM_AGENT_ENABLED !== "false"
  ? new OpenAICompatibleAgentClient({
    baseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "",
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 8_000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES || 1),
    maxInputChars: Number(process.env.LLM_MAX_INPUT_CHARS || 6_000),
  }, logger)
  : undefined;
const mcp = process.env.MCP_ENABLED === "true"
  ? new LarkMcpClient({
    url: process.env.MCP_URL || "",
    toolAllowlist: parseMcpToolAllowlist(process.env.MCP_TOOL_ALLOWLIST),
    authToken: process.env.MCP_TAT || process.env.MCP_UAT,
    authType: process.env.MCP_TAT ? "tat" : process.env.MCP_UAT ? "uat" : undefined,
    allowedTools: parseMcpToolAllowlist(process.env.MCP_ALLOWED_TOOLS),
    maxTools: Number(process.env.MCP_MAX_TOOLS || 80),
    timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 15_000),
  }, logger)
  : undefined;
const service = new ConversationService(store, {
  ownerId: process.env.OWNER_OPEN_ID || "",
  ownerName: process.env.OWNER_NAME || "负责人",
  baseAdmin: baseAdminEnabled ? baseClient : undefined,
  baseTableLabel: process.env.FEISHU_BASE_TABLE_LABEL || "多维表格",
  baseUrl,
  agent,
  mcp,
}, understanding);
const processor = new MessageProcessor(store, service, {
  allowedTenantKeys: csvSet(process.env.ALLOWED_TENANT_KEYS),
  allowedUserIds: csvSet(process.env.ALLOWED_USER_IDS),
  allowedChatIds: csvSet(process.env.ALLOWED_CHAT_IDS),
  groupRequireMention: process.env.GROUP_REQUIRE_MENTION !== "false",
  botOpenId: process.env.BOT_OPEN_ID,
}, logger);
const confirmation = new ConfirmationService(process.env.CONFIRMATION_SECRET || "");
const server = createHttpServer(processor, store, { auth, confirmation, logger });
const port = Number(process.env.PORT || 8090);
const host = process.env.HOST || "127.0.0.1";

let baseSyncWorker: BaseSyncWorker | undefined;
if (baseSyncEnabled) {
  baseSyncWorker = new BaseSyncWorker(store, baseClient!, logger, {
    batchSize: Number(process.env.BASE_SYNC_BATCH_SIZE || 20),
    pollIntervalMs: Number(process.env.BASE_SYNC_POLL_MS || 5_000),
  });
}

server.listen(port, host, () => {
  logger.info("server_started", { host, port });
  baseSyncWorker?.start();
  if (baseSyncWorker) logger.info("base_sync_started", { tableId: process.env.FEISHU_BASE_TABLE_ID });
});

if (process.env.RUN_LARK_CONSUMER === "true") {
  const lark = new LarkCliClient(logger);
  lark.start(async (message) => {
    const reply = await processor.process(message);
    if (reply.text) await lark.reply(message.messageId, reply.text);
  });
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_started", { signal });
    server.close(async () => {
      await baseSyncWorker?.stop();
      await mcp?.close();
      await store.close();
      process.exit(0);
    });
  });
}
