import { validateAuthConfig } from "./auth.ts";
import { ConfirmationService } from "./confirmation.ts";
import { ConversationService } from "./conversation.ts";
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

server.listen(port, host, () => logger.info("server_started", { host, port }));

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
      await store.close();
      process.exit(0);
    });
  });
}
