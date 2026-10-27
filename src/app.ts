import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SPECIALISTS, TOOL_PERMISSIONS } from "./agents/definitions.js";
import type { AppConfig } from "./config.js";
import { NvidiaClient } from "./llm/nvidia.js";
import type { LlmClient } from "./llm/types.js";
import { McpConnection } from "./mcp/connection.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createFetchOfficialPageTool, findOfficialSourcesTool } from "./tools/benefits.js";
import { createFlightSearchTool, findFlightSearchTool } from "./tools/flights.js";
import { ToolGateway } from "./tools/gateway.js";
import { searchHotelsTool } from "./tools/hotels.js";
import { JsonlFileSink, pruneOldLogs, Tracer, type TraceSink } from "./trace/tracer.js";

export interface McpStatus {
  server: string;
  url: string;
  connected: boolean;
  discoveredTools: string[];
  flightTool?: string;
  error?: string;
}

export interface App {
  orchestrator: Orchestrator;
  mcp: McpStatus;
  close(): Promise<void>;
}

export interface AppOverrides {
  llm?: LlmClient;
  sinks?: TraceSink[];
}

export async function createApp(config: AppConfig, overrides: AppOverrides = {}): Promise<App> {
  const llm =
    overrides.llm ??
    new NvidiaClient({ apiKey: config.NVIDIA_API_KEY, baseUrl: config.NVIDIA_BASE_URL, model: config.NVIDIA_MODEL, timeoutMs: config.LLM_TIMEOUT_MS });

  // The MCP server is optional at runtime: if it is down, flight search reports itself unavailable instead of failing startup.
  const mcp: McpStatus = { server: "kiwi", url: config.KIWI_MCP_URL, connected: false, discoveredTools: [] };
  let connection: McpConnection | null = null;
  try {
    connection = await openWithRetry(() => McpConnection.open("kiwi", new StreamableHTTPClientTransport(new URL(config.KIWI_MCP_URL)), config.MCP_TIMEOUT_MS));
    mcp.connected = true;
    mcp.discoveredTools = connection.tools.map((t) => t.name);
    mcp.flightTool = findFlightSearchTool(connection.tools)?.name;
    if (!mcp.flightTool) mcp.error = "connected, but no tool with a flight search schema was advertised";
  } catch (error) {
    mcp.error = `could not connect: ${error instanceof Error ? error.message : String(error)}`;
  }

  const gateway = new ToolGateway(
    [
      createFlightSearchTool({ connection, timeoutMs: config.MCP_TIMEOUT_MS, unavailableReason: mcp.error }),
      searchHotelsTool,
      findOfficialSourcesTool,
      createFetchOfficialPageTool(),
    ],
    TOOL_PERMISSIONS,
  );

  pruneOldLogs(config.LOG_DIR, config.LOG_RETENTION_DAYS);
  const sinks = overrides.sinks ?? [new JsonlFileSink(config.LOG_DIR)];
  const orchestrator = new Orchestrator({
    llm,
    gateway,
    specialists: SPECIALISTS,
    newTracer: () => new Tracer(sinks, { rawPayloads: config.LOG_RAW_PAYLOADS, secrets: [config.NVIDIA_API_KEY] }),
  });

  // Closing the HTTP transport can wait on an open SSE stream; never let shutdown hang on it.
  const close = async () => {
    await Promise.race([connection?.close(), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
  };
  return { orchestrator, mcp, close };
}

/** One retry: the public Kiwi endpoint occasionally drops the first TCP connect. */
async function openWithRetry(open: () => Promise<McpConnection>, attempts = 2): Promise<McpConnection> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await open();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
