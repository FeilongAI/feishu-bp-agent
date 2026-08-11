import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import type { Logger } from "./logger.ts";
import type { AgentToolDefinition } from "./understanding.ts";

export interface McpClientConfig {
  url: string;
  authToken?: string;
  authType?: "uat" | "tat";
  appId?: string;
  appSecret?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

export interface McpToolProvider {
  listTools(): Promise<AgentToolDefinition[]>;
  callTool(name: string, argumentsJson: string): Promise<unknown>;
  close(): Promise<void>;
}

interface McpToolShape {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

export function isMcpMutationTool(name: string): boolean {
  const normalized = name.toLowerCase();
  const mutation = /(?:^|[-_.])(?:create|delete|update|patch|write|modify|set|rename|grant|revoke|publish|archive|append|insert|replace|upsert|send|move|copy|upload|remove|clear|add|batch|subscribe|unsubscribe|invite|permission)(?:[-_.]|$)/i.test(normalized);
  if (mutation) return true;
  // Unknown tools are held for confirmation. Only names that clearly describe
  // a read/query operation are safe to execute without approval.
  return !/(?:^|[-_.])(?:get|list|search|fetch|find|query|read|describe|check|view|retrieve|download|export|lookup)(?:[-_.]|$)/i.test(normalized);
}

export function exposedMcpToolName(remoteName: string, usedNames = new Map<string, string>()): string {
  const safeName = remoteName.replace(/[^A-Za-z0-9_-]/g, "_");
  const digest = createHash("sha256").update(remoteName).digest("hex").slice(0, 8);
  let exposed = safeName.length <= 64 ? safeName : `${safeName.slice(0, 55)}_${digest}`;
  const existing = usedNames.get(exposed);
  if (existing && existing !== remoteName) exposed = `${safeName.slice(0, Math.max(1, 55 - digest.length - 1))}_${digest}`.slice(0, 64);
  return exposed;
}

export class LarkMcpClient implements McpToolProvider {
  private readonly config: Required<Omit<McpClientConfig, "authToken" | "authType" | "appId" | "appSecret" | "apiBaseUrl">> & Pick<McpClientConfig, "authToken" | "authType" | "appId" | "appSecret" | "apiBaseUrl">;
  private readonly logger: Logger;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private tools?: AgentToolDefinition[];
  private readonly exposedToRemoteName = new Map<string, string>();
  private authTokenExpiresAt = 0;
  private connecting?: Promise<void>;

  constructor(config: McpClientConfig, logger: Logger) {
    if (!config.url.trim()) throw new Error("MCP_URL is required when MCP_ENABLED=true");
    this.config = {
      url: config.url,
      authToken: config.authToken,
      authType: config.authType,
      appId: config.appId,
      appSecret: config.appSecret,
      apiBaseUrl: config.apiBaseUrl || "https://open.feishu.cn/open-apis",
      timeoutMs: Number.isFinite(config.timeoutMs) ? Math.max(500, Math.min(Math.trunc(config.timeoutMs!), 60_000)) : 15_000,
    };
    this.logger = logger;
  }

  async listTools(): Promise<AgentToolDefinition[]> {
    await this.ensureConnected();
    if (this.tools) return this.tools;
    const result = await this.client!.listTools().catch(async (error) => {
      await this.close();
      throw error;
    });
    this.tools = result.tools
      .filter((tool) => typeof tool.name === "string")
      .map((tool) => this.toAgentDefinition(tool as McpToolShape));
    this.logger.info("mcp_tools_discovered", { count: this.tools.length });
    return this.tools;
  }

  async callTool(name: string, argumentsJson: string): Promise<unknown> {
    const tools = await this.listTools();
    if (!tools.some((tool) => tool.function.name === name)) return { ok: false, error: "mcp_tool_not_allowlisted" };
    let args: unknown = {};
    try { args = JSON.parse(argumentsJson || "{}"); } catch { return { ok: false, error: "invalid_tool_arguments" }; }
    try {
      const remoteName = this.exposedToRemoteName.get(name) ?? name;
      const result = await this.client!.callTool({ name: remoteName, arguments: args as Record<string, unknown> });
      const failureDetail = result.isError === true ? mcpFailureDetail(result.content, result.structuredContent) : undefined;
      if (result.isError === true) this.logger.warn("mcp_tool_failed", { tool: name, reason: "remote_tool_error", detail: failureDetail });
      return {
        ok: result.isError !== true,
        content: result.content,
        structuredContent: result.structuredContent,
        ...(result.isError === true ? { error: "mcp_tool_failed", detail: failureDetail } : {}),
      };
    } catch (error) {
      this.logger.warn("mcp_tool_call_failed", { tool: name, reason: error instanceof Error ? error.name : "unknown" });
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.transport?.close().catch(() => undefined);
    this.transport = undefined;
    this.client = undefined;
    this.tools = undefined;
    this.exposedToRemoteName.clear();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: "feishu-bp-agent", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          const authToken = await this.authToken();
          if (authToken && this.config.authType) headers.set(`X-Lark-MCP-${this.config.authType.toUpperCase()}`, authToken);
          return fetch(url, { ...init, headers, signal: AbortSignal.timeout(this.config.timeoutMs) });
        },
      });
      transport.onerror = (error) => this.logger.warn("mcp_transport_error", { reason: error.name });
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.logger.info("mcp_connected", { url: this.config.url });
    })();
    try {
      await this.connecting;
    } catch (error) {
      this.logger.warn("mcp_connect_failed", { reason: error instanceof Error ? error.name : "unknown" });
      throw error;
    } finally {
      this.connecting = undefined;
    }
  }

  private async authToken(): Promise<string | undefined> {
    if (this.config.authType !== "tat" || !this.config.appId || !this.config.appSecret) return this.config.authToken;
    if (this.config.authToken && this.authTokenExpiresAt > Date.now() + 60_000) return this.config.authToken;
    const response = await fetch(`${this.config.apiBaseUrl}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const payload = await response.json() as { code?: unknown; tenant_access_token?: unknown; expire?: unknown; msg?: unknown };
    if (!response.ok || payload.code !== 0 || typeof payload.tenant_access_token !== "string") {
      throw new Error(typeof payload.msg === "string" ? payload.msg : "tenant_access_token_unavailable");
    }
    this.config.authToken = payload.tenant_access_token;
    this.authTokenExpiresAt = Date.now() + (typeof payload.expire === "number" ? payload.expire : 7200) * 1000;
    return this.config.authToken;
  }

  private toAgentDefinition(tool: McpToolShape): AgentToolDefinition {
    const name = String(tool.name);
    const description = typeof tool.description === "string" && tool.description.trim() ? tool.description : `调用飞书工具 ${name}`;
    const parameters = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema as Record<string, unknown>
      : { type: "object", properties: {} };
    // Sanitization can collide with an already exposed remote name (for
    // example `foo.bar` and `foo_bar`). Keep the mapping one-to-one.
    const exposedName = exposedMcpToolName(name, this.exposedToRemoteName);
    this.exposedToRemoteName.set(exposedName, name);
    return { type: "function", function: { name: exposedName, description: description.slice(0, 800), parameters } };
  }
}

export function mcpFailureDetail(content: unknown, structuredContent: unknown): string | undefined {
  const values: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const itemText = (item as Record<string, unknown>).text;
      if (typeof itemText === "string" && itemText.trim()) values.push(itemText.trim());
    }
  }
  if (structuredContent && typeof structuredContent === "object") {
    try { values.push(JSON.stringify(structuredContent)); } catch { /* diagnostic data can be non-serializable */ }
  }
  const detail = values.join("; ").replace(/\s+/g, " ").trim();
  return detail ? detail.slice(0, 800) : undefined;
}
