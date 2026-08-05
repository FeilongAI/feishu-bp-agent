import { ConversationService } from "./conversation.ts";
import { createHttpServer } from "./http.ts";
import { LarkCliClient } from "./lark.ts";
import { PostgresRequirementStore } from "./postgres.ts";
import { InMemoryRequirementStore } from "./store.ts";

const store = process.env.DATABASE_URL
  ? new PostgresRequirementStore(process.env.DATABASE_URL)
  : new InMemoryRequirementStore(process.env.DATA_FILE || "data/state.json");
const service = new ConversationService(store, { ownerId: process.env.OWNER_OPEN_ID || "", ownerName: process.env.OWNER_NAME || "负责人" });
const server = createHttpServer(service, store);
const port = Number(process.env.PORT || 8090);
const host = process.env.HOST || "127.0.0.1";

server.listen(port, host, () => process.stdout.write(`feishu-bp-agent listening on http://${host}:${port}\n`));

if (process.env.RUN_LARK_CONSUMER === "true") {
  const lark = new LarkCliClient();
  lark.start(async (message) => {
    const reply = service.handleMessage(message);
    if (reply.text) await lark.reply(message.messageId, reply.text);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await store.close();
    process.exit(0);
  });
}
