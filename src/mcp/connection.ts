import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ToolError } from "../tools/types.js";

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

export type TransportFactory = () => Transport;

async function connect(transport: Transport, timeoutMs: number): Promise<{ client: Client; tools: DiscoveredTool[] }> {
  const client = new Client({ name: "journeypilot", version: "0.1.0" });
  await client.connect(transport, { timeout: timeoutMs });
  const { tools } = await client.listTools(undefined, { timeout: timeoutMs });
  return { client, tools: tools as DiscoveredTool[] };
}

/**
 * A client session with one MCP server, with the tools it advertised at connect time.
 * Remote sessions expire, so after a connection-level failure the next call opens a fresh session.
 */
export class McpConnection {
  private stale = false;
  reconnects = 0;

  private constructor(
    readonly serverName: string,
    private client: Client,
    readonly tools: DiscoveredTool[],
    private readonly newTransport: TransportFactory,
    private readonly timeoutMs: number,
  ) {}

  static async open(serverName: string, newTransport: TransportFactory, timeoutMs: number): Promise<McpConnection> {
    const { client, tools } = await connect(newTransport(), timeoutMs);
    return new McpConnection(serverName, client, tools, newTransport, timeoutMs);
  }

  private async reconnect(): Promise<void> {
    await this.client.close().catch(() => undefined);
    this.client = (await connect(this.newTransport(), this.timeoutMs)).client;
    this.stale = false;
    this.reconnects++;
  }

  /** Calls a discovered tool and returns its JSON text content, mapping protocol failures to ToolErrors. */
  async callJson(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      if (this.stale) await this.reconnect();
      result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs });
    } catch (error) {
      // Anything below the tool level (expired session, dropped stream, timeout) makes the session suspect.
      this.stale = true;
      const message = error instanceof Error ? error.message : String(error);
      // Decided from the error's type and code, not its wording.
      const timedOut =
        (error instanceof McpError && error.code === ErrorCode.RequestTimeout) ||
        (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
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
