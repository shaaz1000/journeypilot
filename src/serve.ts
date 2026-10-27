import { randomBytes } from "node:crypto";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createWebServer } from "./web/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  const adminToken = process.env.ADMIN_TOKEN || randomBytes(18).toString("base64url");
  const port = Number(process.env.PORT ?? 3000);
  const server = await createWebServer({ orchestrator: app.orchestrator, logDir: config.LOG_DIR, adminToken, info: { model: config.NVIDIA_MODEL, mcp: app.mcp, cloud: app.cloud } });

  // Bound to localhost only: the admin view exposes traces of every request.
  server.listen(port, "127.0.0.1", () => {
    console.log(`model ${config.NVIDIA_MODEL} | MCP ${app.mcp.server}: ${app.mcp.connected ? "connected" : app.mcp.error}`);
    console.log(`Chat:  http://127.0.0.1:${port}/`);
    console.log(`Admin: http://127.0.0.1:${port}/admin`);
    console.log(`Cloud tracing: ${app.cloud.enabled ? `Langfuse at ${app.cloud.url}` : "off (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY)"}`);
    console.log(`Admin token: ${process.env.ADMIN_TOKEN ? "(from ADMIN_TOKEN)" : adminToken}`);
  });

  const stop = async () => {
    server.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
