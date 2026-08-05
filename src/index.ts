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
    ...(process.env.BASE_SYNC_ENABLED === "true" ? { FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || "" } : {}),
  };
  const invalid = Object.entries(productionSecrets)
    .filter(([, value]) => !value || /change_me|replace_with/i.test(value))
    .map(([name]) => name);
  if (invalid.length) throw new Error(`Production secrets are missing or still placeholders: ${invalid.join(", ")}`);
}

const store = process.env.DATABASE_URL
  ? new PostgresRequirementStore(process.env.DATABASE_URL)
  : new InMemoryRequirementStore(process.env.DATA_FILE || "data/state.json");
const service = new ConversationService(store, { ownerId: process.env.OWNER_OPEN_ID || "", ownerName: process.env.OWNER_NAME || "负责人" });
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
if (process.env.BASE_SYNC_ENABLED === "true") {
  if (!isBaseOutboxStore(store)) throw new Error("BASE_SYNC_ENABLED requires DATABASE_URL and PostgreSQL storage");
  const required = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BASE_TOKEN", "FEISHU_BASE_TABLE_ID"] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Base sync configuration missing: ${missing.join(", ")}`);
  const baseClient = new FeishuBaseClient({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    baseToken: process.env.FEISHU_BASE_TOKEN!,
    tableId: process.env.FEISHU_BASE_TABLE_ID!,
    apiBaseUrl: process.env.FEISHU_API_BASE_URL,
    fieldMap: parseBaseFieldMap(process.env.FEISHU_BASE_FIELD_MAP),
    requestTimeoutMs: Number(process.env.FEISHU_API_TIMEOUT_MS || 15_000),
  });
  baseSyncWorker = new BaseSyncWorker(store, baseClient, logger, {
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
      await store.close();
      process.exit(0);
    });
  });
}
