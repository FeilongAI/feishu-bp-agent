import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "./logger.ts";
import type { AgentToolDefinition } from "./understanding.ts";

export interface McpClientConfig {
  url: string;
  toolAllowlist?: Set<string>;
  maxTools?: number;
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
  return /(?:^|_)(?:create|delete|update|patch|batch_create|batch_delete|batch_update|send|move|copy|upload|remove|clear)(?:_|$)/i.test(name);
}

export class LarkMcpClient implements McpToolProvider {
  private readonly config: Required<Omit<McpClientConfig, "toolAllowlist">> & { toolAllowlist?: Set<string> };
  private readonly logger: Logger;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private tools?: AgentToolDefinition[];
  private connecting?: Promise<void>;

  constructor(config: McpClientConfig, logger: Logger) {
    if (!config.url.trim()) throw new Error("MCP_URL is required when MCP_ENABLED=true");
    this.config = {
      url: config.url,
      toolAllowlist: config.toolAllowlist,
      maxTools: Number.isFinite(config.maxTools) ? Math.max(1, Math.min(Math.trunc(config.maxTools!), 200)) : 80,
      timeoutMs: Number.isFinite(config.timeoutMs) ? Math.max(500, Math.min(Math.trunc(config.timeoutMs!), 60_000)) : 15_000,
    };
    this.logger = logger;
  }

  async listTools(): Promise<AgentToolDefinition[]> {
    await this.ensureConnected();
    if (this.tools) return this.tools;
    const result = await this.client!.listTools();
    const allowed = this.config.toolAllowlist;
    this.tools = result.tools
      .filter((tool) => typeof tool.name === "string" && !isMcpMutationTool(tool.name) && (!allowed || allowed.has(tool.name)))
      .slice(0, this.config.maxTools)
      .map((tool) => this.toAgentDefinition(tool as McpToolShape));
    return this.tools;
  }

  async callTool(name: string, argumentsJson: string): Promise<unknown> {
    if (isMcpMutationTool(name)) return { ok: false, error: "mcp_mutation_requires_application_confirmation" };
    const tools = await this.listTools();
    if (!tools.some((tool) => tool.function.name === name)) return { ok: false, error: "mcp_tool_not_allowlisted" };
    let args: unknown = {};
    try { args = JSON.parse(argumentsJson || "{}"); } catch { return { ok: false, error: "invalid_tool_arguments" }; }
    const result = await this.client!.callTool({ name, arguments: args as Record<string, unknown> });
    return {
      ok: result.isError !== true,
      content: result.content,
      structuredContent: result.structuredContent,
      ...(result.isError === true ? { error: "mcp_tool_failed" } : {}),
    };
  }

  async close(): Promise<void> {
    await this.transport?.close().catch(() => undefined);
    this.transport = undefined;
    this.client = undefined;
    this.tools = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: "feishu-bp-agent", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        fetch: async (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs) }),
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

  private toAgentDefinition(tool: McpToolShape): AgentToolDefinition {
    const name = String(tool.name);
    const description = typeof tool.description === "string" && tool.description.trim() ? tool.description : `调用飞书工具 ${name}`;
    const parameters = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema as Record<string, unknown>
      : { type: "object", properties: {} };
    return { type: "function", function: { name: name.slice(0, 64), description: description.slice(0, 800), parameters } };
  }
}

export function parseMcpToolAllowlist(value: string | undefined): Set<string> | undefined {
  const names = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return names?.length ? new Set(names) : undefined;
}
