import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { build } from "esbuild";
import type { CloudTracing, McpStatus } from "../app.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { TraceStore } from "./traceStore.js";

export interface ServerOptions {
  orchestrator: Pick<Orchestrator, "handle">;
  logDir: string;
  adminToken: string;
  info: { model: string; mcp: McpStatus; cloud: CloudTracing };
  webDir?: string;
}

const MAX_BODY_BYTES = 16_384;

interface Asset {
  type: string;
  body: string;
}

/** Bundles the browser TypeScript once at startup and keeps the pages in memory. */
export async function buildAssets(webDir: string): Promise<Map<string, Asset>> {
  const bundle = await build({
    entryPoints: { chat: join(webDir, "chat.ts"), admin: join(webDir, "admin.ts") },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    outdir: "out",
    minify: false,
  });
  const assets = new Map<string, Asset>();
  for (const file of bundle.outputFiles) {
    const name = file.path.split("/").pop()!;
    assets.set(`/assets/${name}`, { type: "text/javascript; charset=utf-8", body: file.text });
  }
  assets.set("/", { type: "text/html; charset=utf-8", body: readFileSync(join(webDir, "chat.html"), "utf8") });
  assets.set("/admin", { type: "text/html; charset=utf-8", body: readFileSync(join(webDir, "admin.html"), "utf8") });
  assets.set("/assets/styles.css", { type: "text/css; charset=utf-8", body: readFileSync(join(webDir, "styles.css"), "utf8") });
  return assets;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const value = header ?? "";
  const given = Buffer.from(value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : value);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

const TRACE_ID_CHARS = new Set("0123456789abcdef-");
const TRACES_PREFIX = "/api/admin/traces/";

/** Trace IDs are UUIDs; anything else is rejected before touching the store. */
function traceIdFrom(pathname: string): string | null {
  if (!pathname.startsWith(TRACES_PREFIX)) return null;
  const id = pathname.slice(TRACES_PREFIX.length);
  return id.length >= 8 && id.length <= 64 && [...id].every((c) => TRACE_ID_CHARS.has(c)) ? id : null;
}

/**
 * The server only answers to its own local origin. Checking Host blocks DNS rebinding; requiring JSON and a
 * matching Origin on POST blocks other websites from driving the chat endpoint (and spending model quota).
 */
function sameOriginProblem(req: IncomingMessage): string | null {
  const port = req.socket.localPort;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!allowedHosts.has(req.headers.host ?? "")) return "unexpected Host header";
  const origin = req.headers.origin;
  if (origin && !allowedHosts.has(originHost(origin))) return "cross-origin request";
  if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) return "content type must be application/json";
  return null;
}

export async function createWebServer(options: ServerOptions): Promise<Server> {
  const assets = await buildAssets(options.webDir ?? "web");
  const traces = new TraceStore(options.logDir);

  return createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const url = new URL(req.url ?? "/", "http://localhost");
    const problem = sameOriginProblem(req);
    if (problem) return sendJson(res, 403, { error: `Request refused: ${problem}.` });
    try {
      if (req.method === "GET" && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname)!;
        res.writeHead(200, { "Content-Type": asset.type });
        res.end(asset.body);
        return;
      }

      // Traveller endpoint: returns the answer only. Tool calls and traces stay on the admin side.
      if (req.method === "POST" && url.pathname === "/api/chat") {
        let body: { message?: unknown; previous?: unknown };
        try {
          body = ((await readJson(req)) ?? {}) as typeof body;
        } catch {
          return sendJson(res, 400, { error: "Send JSON like {\"message\": \"...\"} under 16 KB." });
        }
        if (typeof body.message !== "string") return sendJson(res, 400, { error: "message must be a string" });
        if (body.previous !== undefined && typeof body.previous !== "string") return sendJson(res, 400, { error: "previous must be a string" });
        const { result } = await options.orchestrator.handle(body.message, { previousMessage: body.previous });
        return sendJson(res, 200, {
          requestId: result.requestId,
          status: result.status,
          body: result.body,
          agentsUsed: result.agentsUsed,
          citations: result.citations,
          limitations: result.limitations,
        });
      }

      if (url.pathname.startsWith("/api/admin/")) {
        if (!tokenMatches(req.headers.authorization, options.adminToken)) return sendJson(res, 401, { error: "admin token required" });
        if (req.method === "GET" && url.pathname === "/api/admin/status") return sendJson(res, 200, options.info);
        if (req.method === "GET" && url.pathname === "/api/admin/traces") {
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
          return sendJson(res, 200, traces.list(limit));
        }
        const traceId = traceIdFrom(url.pathname);
        if (req.method === "GET" && traceId) {
          const events = traces.get(traceId);
          return events ? sendJson(res, 200, events) : sendJson(res, 404, { error: "trace not found" });
        }
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      process.stderr.write(`request failed: ${String(error)}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong handling that request. Check the server log." });
    }
  });
}
