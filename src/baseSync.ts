import { redact, type Logger } from "./logger.ts";
import { FeishuApiError, outboxClientToken, type BaseRecordClient } from "./feishuBase.ts";
import type { BaseOutboxItem, BaseOutboxStore, Requirement } from "./types.ts";

export interface BaseSyncOptions {
  batchSize?: number;
  pollIntervalMs?: number;
}

function errorText(error: unknown): string {
  const sanitized = redact(error);
  return (typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized)).slice(0, 2000);
}

export class BaseSyncWorker {
  private readonly store: BaseOutboxStore;
  private readonly client: BaseRecordClient;
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(store: BaseOutboxStore, client: BaseRecordClient, logger: Logger, options: BaseSyncOptions = {}) {
    this.store = store;
    this.client = client;
    this.logger = logger;
    this.batchSize = options.batchSize ?? 20;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.pollIntervalMs);
    this.timer.unref();
    void this.runOnce();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.processBatch().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async processBatch(): Promise<void> {
    let items: BaseOutboxItem[];
    try {
      items = await this.store.claimBaseOutbox(this.batchSize);
    } catch (error) {
      this.logger.error("base_outbox_claim_failed", { error });
      return;
    }
    if (!items.length) return;
    try {
      for (const item of items) await this.processItem(item);
    } finally {
      await this.store.releaseBaseOutboxLease(items[0].lockToken).catch((error) => this.logger.error("base_outbox_lease_release_failed", { error }));
    }
  }

  private async processItem(item: BaseOutboxItem): Promise<void> {
    try {
      const existingRecordId = await this.store.getBaseRecordId(item.requirementId);
      if (item.operation === "delete") {
        if (existingRecordId) await this.client.deleteRequirement(existingRecordId);
        await this.store.completeBaseOutbox(item);
      } else {
        const requirement = item.payload as Requirement;
        let recordId = existingRecordId;
        if (recordId) {
          try {
            await this.client.updateRequirement(recordId, requirement);
          } catch (error) {
            if (!(error instanceof FeishuApiError) || error.code !== 1254043) throw error;
            recordId = await this.client.createRequirement(requirement, outboxClientToken(item.id));
          }
        } else {
          recordId = await this.client.createRequirement(requirement, outboxClientToken(item.id));
        }
        await this.store.completeBaseOutbox(item, recordId);
      }
      this.logger.info("base_outbox_completed", { outboxId: item.id, requirementId: item.requirementId, operation: item.operation });
    } catch (error) {
      const delayMs = Math.min(3_600_000, 5_000 * 2 ** Math.min(item.attempts - 1, 9));
      await this.store.failBaseOutbox(item, errorText(error), new Date(Date.now() + delayMs)).catch((storeError) => {
        this.logger.error("base_outbox_failure_record_failed", { outboxId: item.id, error: storeError });
      });
      this.logger.error("base_outbox_item_failed", { outboxId: item.id, requirementId: item.requirementId, attempt: item.attempts, error });
    }
  }
}

export function isBaseOutboxStore(value: unknown): value is BaseOutboxStore {
  const candidate = value as Partial<BaseOutboxStore>;
  return typeof candidate?.claimBaseOutbox === "function"
    && typeof candidate.releaseBaseOutboxLease === "function"
    && typeof candidate.getBaseRecordId === "function"
    && typeof candidate.completeBaseOutbox === "function"
    && typeof candidate.failBaseOutbox === "function";
}
