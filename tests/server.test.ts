import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer } from "../src/web/server.js";
import { JsonlFileSink, Tracer } from "../src/trace/tracer.js";
import type { FinalAnswer } from "../src/schemas.js";

const TOKEN = "test-admin-token-123";
let server: Server;
let base: string;
let lastTraceId = "";

beforeAll(async () => {
  const logDir = mkdtempSync(join(tmpdir(), "jp-web-"));
  const sink = new JsonlFileSink(logDir);
  const orchestrator = {
    async handle(message: string) {
      const tracer = new Tracer([sink]);
      const root = tracer.emit("request", { message });
      tracer.emit("tool", { agent: "flight", tool: "search_flights", status: "ok", args: { origin: "LHR" } }, { parentSpanId: root });
      tracer.emit("final", { status: "answered", answer: "Fares from 312 GBP" }, { parentSpanId: root });
      lastTraceId = tracer.traceId;
      const result: FinalAnswer = {
        requestId: tracer.requestId, traceId: tracer.traceId, status: "answered", answer: "Fares from 312 GBP\n\nLimitations:\n- live fares",
        body: "Fares from 312 GBP", agentsUsed: ["flight"], citations: [], limitations: ["live fares"], review: { passed: true, findings: [], replaced: false },
      };
      return { result, tracer };
    },
  };
  server = await createWebServer({
    orchestrator,
    logDir,
    adminToken: TOKEN,
    info: { model: "test-model", mcp: { server: "kiwi", url: "x", connected: true, discoveredTools: [] }, cloud: { provider: "langfuse", enabled: false, url: "x" } },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const chat = (body: unknown) => fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const admin = (path: string, token?: string) => fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe("web server", () => {
  it("serves both pages and the bundled TypeScript", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/admin`)).status).toBe(200);
    const script = await fetch(`${base}/assets/admin.js`);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toContain("/api/admin/traces");
  });

  it("sets a strict content security policy", async () => {
    expect((await fetch(`${base}/`)).headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("returns the answer to the traveller without tool calls or trace data", async () => {
    const response = await chat({ message: "Flights LHR to JFK" });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ status: "answered", body: "Fares from 312 GBP", agentsUsed: ["flight"] });
    expect(Object.keys(data).sort()).toEqual(["agentsUsed", "body", "citations", "limitations", "requestId", "status"]);
    expect(JSON.stringify(data)).not.toContain("search_flights");
  });

  it("rejects malformed chat requests", async () => {
    expect((await chat({ text: "hi" })).status).toBe(400);
    expect((await fetch(`${base}/api/chat`, { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await chat({ message: "x".repeat(20_000) })).status).toBe(400);
  });

  it("requires the admin token for trace data", async () => {
    expect((await admin("/api/admin/traces")).status).toBe(401);
    expect((await admin("/api/admin/traces", "wrong-token-of-same-size")).status).toBe(401);
    const list = await (await admin("/api/admin/traces", TOKEN)).json();
    expect(list[0]).toMatchObject({ message: "Flights LHR to JFK", status: "answered", toolCalls: 1 });
  });

  it("returns every logged event of a trace to an admin", async () => {
    await chat({ message: "second request" });
    const events = await (await admin(`/api/admin/traces/${lastTraceId}`, TOKEN)).json();
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(["request", "tool", "final"]);
    expect(events[1].args).toEqual({ origin: "LHR" });
    expect((await admin("/api/admin/traces/does-not-exist", TOKEN)).status).toBe(404);
  });
});
