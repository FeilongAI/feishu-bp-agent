import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { EventDeliveryService, FileSpoolStore, CoreAgentHttpClient, LarkCliReplySender, LarkCliSenderDirectory } from "./forwarder.ts";
import { logger } from "./logger.ts";

function numberEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value))) : fallback;
}

const bin = process.env.LARK_CLI_BIN || "lark-cli";
const eventKey = process.env.LARK_EVENT_KEY || "im.message.receive_v1";
const concurrency = numberEnv("FORWARDER_CONCURRENCY", 4, 1, 32);
const spool = new FileSpoolStore(process.env.FORWARDER_SPOOL_DIR || "/var/lib/feishu-bp-forwarder/spool");
const delivery = new EventDeliveryService(
  spool,
  new CoreAgentHttpClient({
    url: process.env.FORWARDER_CORE_URL || "http://127.0.0.1:8090",
    ingressApiKey: process.env.INGRESS_API_KEY || "",
    timeoutMs: numberEnv("FORWARDER_HTTP_TIMEOUT_MS", 20_000, 500, 60_000),
  }),
  new LarkCliReplySender(bin),
  logger,
  {
    maxRetries: numberEnv("FORWARDER_MAX_RETRIES", 5, 0, 10),
    retryBaseMs: numberEnv("FORWARDER_RETRY_BASE_MS", 500, 10, 30_000),
  },
  new LarkCliSenderDirectory(bin),
);

const state: { ready: boolean; startedAt: string; connectedAt?: string; lastEventAt?: string; restarts: number } = {
  ready: false,
  startedAt: new Date().toISOString(),
  restarts: 0,
};
let stopping = false;
let child: ChildProcessWithoutNullStreams | undefined;
let replaying = false;
let wakeRestart: (() => void) | undefined;

const healthHost = process.env.FORWARDER_HEALTH_HOST || "127.0.0.1";
const healthPort = numberEnv("FORWARDER_HEALTH_PORT", 8091, 1, 65_535);
const healthServer = createServer(async (request, response) => {
  if (request.method !== "GET" || !["/healthz", "/readyz"].includes(request.url || "")) {
    response.writeHead(404, { "content-type": "application/json" });
    return response.end(JSON.stringify({ ok: false, error: "not_found" }));
  }
  const pending = await delivery.pendingCount().catch(() => -1);
  const ok = state.ready && pending >= 0;
  response.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ ok, service: "feishu-bp-forwarder", ...state, pending }));
});
healthServer.listen(healthPort, healthHost, () => logger.info("forwarder_health_started", { host: healthHost, port: healthPort }));

async function processLine(line: string): Promise<void> {
  state.lastEventAt = new Date().toISOString();
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("event_not_object");
    await delivery.accept(value as Record<string, unknown>);
  } catch (error) {
    logger.error("lark_event_processing_failed", { error });
  }
}

function consumeOnce(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const running = new Set<Promise<void>>();
    let ready = false;
    let settled = false;
    child = spawn(bin, ["event", "consume", eventKey, "--as", "bot"], {
      stdio: "pipe",
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });

    stdout.on("line", (line) => {
      const task = processLine(line).finally(() => {
        running.delete(task);
        if (running.size < concurrency && !stopping) child?.stdout.resume();
      });
      running.add(task);
      if (running.size >= concurrency) child?.stdout.pause();
    });
    stderr.on("line", (line) => {
      if (line.includes(`[event] ready event_key=${eventKey}`)) {
        ready = true;
        state.ready = true;
        state.connectedAt = new Date().toISOString();
        logger.info("lark_consumer_ready", { eventKey });
      } else if (line.trim()) {
        logger.warn("lark_consumer_output", { output: line });
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      state.ready = false;
      reject(error);
    });
    child.on("close", async (code, signal) => {
      await Promise.allSettled([...running]);
      state.ready = false;
      child = undefined;
      if (settled) return;
      settled = true;
      logger.warn("lark_consumer_exited", { code, signal, ready });
      resolve(ready);
    });
  });
}

async function replay(): Promise<void> {
  if (replaying) return;
  replaying = true;
  try {
    await delivery.replay();
  } catch (error) {
    logger.error("forwarder_replay_failed", { error });
  } finally {
    replaying = false;
  }
}

async function run(): Promise<void> {
  void replay();
  const replayTimer = setInterval(() => void replay(), numberEnv("FORWARDER_REPLAY_INTERVAL_MS", 30_000, 1_000, 600_000));
  let failures = 0;
  while (!stopping) {
    try {
      const wasReady = await consumeOnce();
      failures = wasReady ? 0 : failures + 1;
    } catch (error) {
      failures += 1;
      state.ready = false;
      logger.error("lark_consumer_start_failed", { error, failures });
    }
    if (stopping) break;
    state.restarts += 1;
    const waitMs = Math.min(1_000 * (2 ** Math.min(failures, 5)), 30_000);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      wakeRestart = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wakeRestart = undefined;
  }
  clearInterval(replayTimer);
}

const running = run().catch((error) => {
  logger.error("forwarder_failed", { error });
  process.exitCode = 1;
});

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  state.ready = false;
  logger.info("forwarder_shutdown_started", { signal });
  wakeRestart?.();
  child?.stdin.end();
  const gracefulTimer = setTimeout(() => child?.kill("SIGTERM"), 5_000);
  await running;
  clearTimeout(gracefulTimer);
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown(signal));
