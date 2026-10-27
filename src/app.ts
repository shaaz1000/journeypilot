import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SPECIALISTS, TOOL_PERMISSIONS } from "./agents/definitions.js";
import type { AppConfig } from "./config.js";
import { NvidiaEmbedder } from "./llm/embeddings.js";
import { NvidiaClient } from "./llm/nvidia.js";
import type { LlmClient } from "./llm/types.js";
import { McpConnection } from "./mcp/connection.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createFetchOfficialPageTool, findOfficialSourcesTool } from "./tools/benefits.js";
import { createFlightSearchTool, findFlightSearchTool } from "./tools/flights.js";
import { ToolGateway } from "./tools/gateway.js";
import { createCurrencyTool, createLocalTimeTool, createThingsToDoTool } from "./tools/destination.js";
import { searchHotelsTool } from "./tools/hotels.js";
import { createFetchRightsPageTool, findRightsSourcesTool } from "./tools/rights.js";
import { LangfuseSink } from "./trace/langfuse.js";
import { JsonlFileSink, pruneOldLogs, Tracer, type TraceSink } from "./trace/tracer.js";

export interface McpStatus {
  server: string;
  url: string;
  connected: boolean;
  discoveredTools: string[];
  flightTool?: string;
  error?: string;
}

export interface CloudTracing {
  provider: "langfuse";
  enabled: boolean;
  url: string;
}

export interface App {
  orchestrator: Orchestrator;
  mcp: McpStatus;
  cloud: CloudTracing;
  close(): Promise<void>;
}

export interface AppOverrides {
  llm?: LlmClient;
  sinks?: TraceSink[];
}

export async function createApp(config: AppConfig, overrides: AppOverrides = {}): Promise<App> {
  const llm =
    overrides.llm ??
    new NvidiaClient({
      apiKey: config.NVIDIA_API_KEY,
      baseUrl: config.NVIDIA_BASE_URL,
      model: config.NVIDIA_MODEL,
      timeoutMs: config.LLM_TIMEOUT_MS,
      thinking: config.NVIDIA_THINKING,
      thinkingTokens: config.NVIDIA_THINKING_TOKENS,
    });

  // The MCP server is optional at runtime: if it is down, flight search reports itself unavailable instead of failing startup.
  const mcp: McpStatus = { server: "kiwi", url: config.KIWI_MCP_URL, connected: false, discoveredTools: [] };
  let connection: McpConnection | null = null;
  let connecting: Promise<McpConnection> | null = null;
  // Opens the Kiwi session on first use and again after a failed attempt, so a network blip at startup
  // does not leave flight search unavailable for the life of the process.
  const connect = (): Promise<McpConnection> => {
    if (connection) return Promise.resolve(connection);
    connecting ??= openWithRetry(() => McpConnection.open("kiwi", () => new StreamableHTTPClientTransport(new URL(config.KIWI_MCP_URL)), config.MCP_TIMEOUT_MS))
      .then((opened) => {
        connection = opened;
        mcp.connected = true;
        mcp.error = undefined;
        mcp.discoveredTools = opened.tools.map((t) => t.name);
        mcp.flightTool = findFlightSearchTool(opened.tools)?.name;
        if (!mcp.flightTool) mcp.error = "connected, but no tool with a flight search schema was advertised";
        return opened;
      })
      .catch((error: unknown) => {
        mcp.error = `could not connect: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  };
  await connect().catch(() => undefined);

  const embedder = new NvidiaEmbedder({ apiKey: config.NVIDIA_API_KEY, baseUrl: config.NVIDIA_BASE_URL, model: config.NVIDIA_EMBED_MODEL, timeoutMs: 15_000 });
  const gateway = new ToolGateway(
    [
      createFlightSearchTool({ connect, serverName: "kiwi", timeoutMs: config.MCP_TIMEOUT_MS }),
      searchHotelsTool,
      findOfficialSourcesTool,
      createCurrencyTool(),
      createLocalTimeTool(),
      createThingsToDoTool(),
      findRightsSourcesTool,
      createFetchRightsPageTool(fetch, embedder),
      createFetchOfficialPageTool(fetch, 20_000, embedder),
    ],
    TOOL_PERMISSIONS,
  );

  pruneOldLogs(config.LOG_DIR, config.LOG_RETENTION_DAYS);
  const sinks: TraceSink[] = overrides.sinks ?? [new JsonlFileSink(config.LOG_DIR)];
  const cloud: CloudTracing = { provider: "langfuse", enabled: false, url: config.LANGFUSE_BASE_URL };
  if (config.LANGFUSE_PUBLIC_KEY && config.LANGFUSE_SECRET_KEY) {
    sinks.push(new LangfuseSink({ baseUrl: config.LANGFUSE_BASE_URL, publicKey: config.LANGFUSE_PUBLIC_KEY, secretKey: config.LANGFUSE_SECRET_KEY }));
    cloud.enabled = true;
  }
  const secrets = [config.NVIDIA_API_KEY, config.LANGFUSE_SECRET_KEY].filter((s): s is string => Boolean(s));
  const orchestrator = new Orchestrator({
    llm,
    gateway,
    specialists: SPECIALISTS,
    newTracer: () => new Tracer(sinks, { rawPayloads: config.LOG_RAW_PAYLOADS, secrets }),
  });

  // Closing the HTTP transport can wait on an open SSE stream; never let shutdown hang on it.
  const close = async () => {
    await Promise.all(sinks.map((sink) => sink.close?.()));
    await Promise.race([connection?.close(), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
  };
  return { orchestrator, mcp, cloud, close };
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
