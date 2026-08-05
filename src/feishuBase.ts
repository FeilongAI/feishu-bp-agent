import { createHash } from "node:crypto";
import type { Requirement } from "./types.ts";

export interface BaseFieldMap {
  requirementId: string;
  title: string;
  goal: string;
  scope: string;
  acceptanceCriteria: string;
  requesterId: string;
  requesterName: string;
  platforms: string;
  desiredDate: string;
  priority: string;
  status: string;
  ownerId: string;
  ownerName: string;
  progress: string;
  visibility: string;
  sourceChatId: string;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_BASE_FIELD_MAP: BaseFieldMap = {
  requirementId: "需求ID",
  title: "需求标题",
  goal: "业务目标",
  scope: "需求范围",
  acceptanceCriteria: "验收标准",
  requesterId: "提出人ID",
  requesterName: "提出人",
  platforms: "投放平台",
  desiredDate: "期望时间",
  priority: "优先级",
  status: "状态",
  ownerId: "负责人ID",
  ownerName: "负责人",
  progress: "当前进展",
  visibility: "可见范围",
  sourceChatId: "来源会话ID",
  createdAt: "创建时间",
  updatedAt: "更新时间",
};

export interface FeishuBaseConfig {
  appId: string;
  appSecret: string;
  baseToken: string;
  tableId: string;
  apiBaseUrl?: string;
  fieldMap?: BaseFieldMap;
  requestTimeoutMs?: number;
}

export interface BaseRecordClient {
  createRequirement(requirement: Requirement, clientToken: string): Promise<string>;
  updateRequirement(recordId: string, requirement: Requirement): Promise<void>;
  deleteRequirement(recordId: string): Promise<void>;
}

export class FeishuApiError extends Error {
  readonly status: number;
  readonly code?: number;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = "FeishuApiError";
    this.status = status;
    this.code = code;
  }
}

export function outboxClientToken(outboxId: number): string {
  const hex = createHash("sha256").update(`feishu-bp-agent:base-create:${outboxId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function compactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== ""));
}

export class FeishuBaseClient implements BaseRecordClient {
  private readonly config: Required<Omit<FeishuBaseConfig, "fieldMap">> & { fieldMap: BaseFieldMap };
  private readonly fetchImpl: typeof fetch;
  private accessToken?: string;
  private tokenExpiresAt = 0;

  constructor(config: FeishuBaseConfig, fetchImpl: typeof fetch = fetch) {
    this.config = {
      ...config,
      apiBaseUrl: (config.apiBaseUrl || "https://open.feishu.cn/open-apis").replace(/\/$/, ""),
      fieldMap: config.fieldMap ?? DEFAULT_BASE_FIELD_MAP,
      requestTimeoutMs: config.requestTimeoutMs ?? 15_000,
    };
    this.fetchImpl = fetchImpl;
  }

  async createRequirement(requirement: Requirement, clientToken: string): Promise<string> {
    const data = await this.request("POST", `${this.recordsPath()}?client_token=${encodeURIComponent(clientToken)}`, { fields: this.requirementFields(requirement) });
    const record = this.asObject(data.record);
    const recordId = record.record_id ?? record.recordId ?? data.record_id;
    if (typeof recordId !== "string" || !recordId) throw new FeishuApiError("Feishu Base create response has no record_id", 502);
    return recordId;
  }

  async updateRequirement(recordId: string, requirement: Requirement): Promise<void> {
    await this.request("PUT", `${this.recordsPath()}/${encodeURIComponent(recordId)}`, { fields: this.requirementFields(requirement) });
  }

  async deleteRequirement(recordId: string): Promise<void> {
    try {
      await this.request("DELETE", `${this.recordsPath()}/${encodeURIComponent(recordId)}`);
    } catch (error) {
      if (error instanceof FeishuApiError && error.code === 1254043) return;
      throw error;
    }
  }

  requirementFields(requirement: Requirement): Record<string, unknown> {
    const field = this.config.fieldMap;
    return compactFields({
      [field.requirementId]: requirement.id,
      [field.title]: requirement.title,
      [field.goal]: requirement.goal,
      [field.scope]: requirement.scope,
      [field.acceptanceCriteria]: requirement.acceptanceCriteria,
      [field.requesterId]: requirement.requesterId,
      [field.requesterName]: requirement.requesterName,
      [field.platforms]: requirement.platforms,
      [field.desiredDate]: requirement.desiredDate,
      [field.priority]: requirement.priority,
      [field.status]: requirement.status,
      [field.ownerId]: requirement.ownerId,
      [field.ownerName]: requirement.ownerName,
      [field.progress]: requirement.progress,
      [field.visibility]: requirement.visibility,
      [field.sourceChatId]: requirement.sourceChatId,
      [field.createdAt]: Date.parse(requirement.createdAt),
      [field.updatedAt]: Date.parse(requirement.updatedAt),
    });
  }

  private recordsPath(): string {
    return `/bitable/v1/apps/${encodeURIComponent(this.config.baseToken)}/tables/${encodeURIComponent(this.config.tableId)}/records`;
  }

  private async tenantToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiresAt > Date.now() + 60_000) return this.accessToken;
    const response = await this.fetchImpl(`${this.config.apiBaseUrl}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const payload = await this.responseJson(response);
    const token = payload.tenant_access_token;
    if (!response.ok || payload.code !== 0 || typeof token !== "string") {
      throw new FeishuApiError(String(payload.msg || "Unable to obtain tenant access token"), response.status, typeof payload.code === "number" ? payload.code : undefined);
    }
    this.accessToken = token;
    this.tokenExpiresAt = Date.now() + Number(payload.expire || 7200) * 1000;
    return token;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.tenantToken();
      const response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (response.status === 401 && attempt === 0) {
        this.accessToken = undefined;
        this.tokenExpiresAt = 0;
        continue;
      }
      const payload = await this.responseJson(response);
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(String(payload.msg || `Feishu Base request failed with HTTP ${response.status}`), response.status, typeof payload.code === "number" ? payload.code : undefined);
      }
      return this.asObject(payload.data);
    }
    throw new FeishuApiError("Feishu Base authorization failed", 401);
  }

  private async responseJson(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    try {
      return this.asObject(text ? JSON.parse(text) : {});
    } catch {
      throw new FeishuApiError("Feishu returned a non-JSON response", response.status);
    }
  }

  private asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }
}

export function parseBaseFieldMap(value: string | undefined): BaseFieldMap | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as Partial<BaseFieldMap>;
  const merged = { ...DEFAULT_BASE_FIELD_MAP, ...parsed };
  if (Object.values(merged).some((field) => typeof field !== "string" || !field.trim())) throw new Error("FEISHU_BASE_FIELD_MAP values must be non-empty strings");
  return merged;
}
