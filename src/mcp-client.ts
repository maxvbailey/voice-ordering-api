/**
 * MCP Client — Connects to Spoonity + Deliverect MCP servers
 *
 * Uses the MCP SDK's StreamableHTTPClientTransport to connect
 * to the Cloud Run-hosted MCP servers and call their tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpClientConfig {
  spoonityUrl: string;
  deliverectUrl: string;
  apiKey?: string;
}

export class McpClientManager {
  private config: McpClientConfig;

  constructor(config: McpClientConfig) {
    this.config = config;
  }

  /**
   * Connect to a specific MCP server and call a tool.
   * Creates a short-lived connection per request (appropriate for serverless).
   */
  async callTool(
    server: "spoonity" | "deliverect",
    toolName: string,
    args: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<any> {
    const url = server === "spoonity" ? this.config.spoonityUrl : this.config.deliverectUrl;

    const transport = new StreamableHTTPClientTransport(
      new URL(url),
      {
        requestInit: {
          headers: {
            ...(this.config.apiKey ? { "X-Api-Key": this.config.apiKey } : {}),
            ...(headers || {}),
          },
        },
      }
    );

    const client = new Client({ name: "voice-ordering-api", version: "1.0.0" });

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: toolName, arguments: args });
      return result;
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  }

  /**
   * List available tools on a server (for discovery/debugging).
   */
  async listTools(server: "spoonity" | "deliverect"): Promise<any> {
    const url = server === "spoonity" ? this.config.spoonityUrl : this.config.deliverectUrl;

    const transport = new StreamableHTTPClientTransport(
      new URL(url),
      {
        requestInit: {
          headers: this.config.apiKey ? { "X-Api-Key": this.config.apiKey } : {},
        },
      }
    );

    const client = new Client({ name: "voice-ordering-api", version: "1.0.0" });

    try {
      await client.connect(transport);
      return await client.listTools();
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}
