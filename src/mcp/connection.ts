import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolError } from "../tools/types.js";

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

/** A live client connection to one MCP server, with the tools it advertised at connect time. */
export class McpConnection {
  private constructor(
    readonly serverName: string,
    private readonly client: Client,
    readonly tools: DiscoveredTool[],
  ) {}

  static async open(serverName: string, transport: Transport, timeoutMs: number): Promise<McpConnection> {
    const client = new Client({ name: "journeypilot", version: "0.1.0" });
    await client.connect(transport, { timeout: timeoutMs });
    const { tools } = await client.listTools(undefined, { timeout: timeoutMs });
    return new McpConnection(serverName, client, tools as DiscoveredTool[]);
  }

  /** Calls a discovered tool and returns its JSON text content, mapping protocol failures to ToolErrors. */
  async callJson(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timed out|-32001|abort/i.test(message);
      throw new ToolError(`${this.serverName} MCP call failed: ${message}`, timedOut ? "timeout" : "provider", true);
    }
    const text = Array.isArray(result.content)
      ? result.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("")
      : "";
    if (result.isError) throw new ToolError(`${this.serverName} returned an error: ${text.slice(0, 300)}`, "provider", false);
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolError(`${this.serverName} returned non-JSON content`, "malformed_output", false);
    }
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
