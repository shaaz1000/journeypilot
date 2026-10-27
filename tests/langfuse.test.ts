import { describe, expect, it, vi } from "vitest";
import { LangfuseSink, otelSpanId, otelTraceId, toOtelSpans, type OtlpSpan } from "../src/trace/langfuse.js";
import { Tracer } from "../src/trace/tracer.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  spans: OtlpSpan[];
}

function capture() {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, spans: body.resourceSpans[0].scopeSpans[0].spans });
    return new Response("{}", { status: 200 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const attr = (span: OtlpSpan, key: string) => span.attributes.find((a) => a.key === key)?.value.stringValue;

/** Emits a small but complete request through a Tracer, the way the orchestrator does. */
function runTrace(tracer: Tracer) {
  const root = tracer.emit("request", { message: "Flights LHR to JFK" });
  tracer.emit("classification", { valid: true, intents: ["flight_search"], confidence: 0.9 }, { parentSpanId: root });
  tracer.emit("policy", { outcome: "allow", agents: ["flight"] }, { parentSpanId: root });
  tracer.emit("delegation", { agent: "flight", reason: "intent" }, { parentSpanId: root });
  const agentSpan = tracer.newSpanId();
  tracer.emit("model", {
    purpose: "agent:flight", model: "nemotron", status: "ok", durationMs: 900,
    prompt: [{ role: "system", content: "You are the Flight Agent" }, { role: "user", content: "LHR to JFK" }],
    reasoning: "The user wants flights, call search_flights", toolsOffered: ["search_flights"], toolCalls: [{ name: "search_flights", arguments: "{}" }],
    usage: { promptTokens: 300, completionTokens: 40, totalTokens: 340 },
  }, { parentSpanId: agentSpan });
  tracer.emit("tool", { agent: "flight", tool: "search_flights", source: "mcp", server: "kiwi", status: "timeout", error: "timed out", args: { origin: "LHR" }, durationMs: 45000 }, { parentSpanId: agentSpan });
  tracer.emit("agent", { agent: "flight", status: "failed", durationMs: 47000, errors: ["search_flights: timeout"] }, { spanId: agentSpan, parentSpanId: root });
  tracer.emit("final", { status: "failed", durationMs: 48000, answer: "Flight data is unavailable." }, { parentSpanId: root });
  return { root, agentSpan };
}

describe("Langfuse export (OTLP)", () => {
  it("sends spans to the OTLP endpoint with basic auth and the v4 ingestion header", async () => {
    const { calls, fetchImpl } = capture();
    const sink = new LangfuseSink({ baseUrl: "https://jp.cloud.example/", publicKey: "pk-lf-1", secretKey: "sk-lf-1", fetchImpl });
    runTrace(new Tracer([sink]));
    await sink.close();
    expect(calls[0]?.url).toBe("https://jp.cloud.example/api/public/otel/v1/traces");
    expect(calls[0]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("pk-lf-1:sk-lf-1").toString("base64")}`,
      "Content-Type": "application/json",
      "x-langfuse-ingestion-version": "4",
    });
  });

  it("maps a request to a root span with nested agent, generation and tool observations", async () => {
    const { calls, fetchImpl } = capture();
    const sink = new LangfuseSink({ baseUrl: "https://cloud.example", publicKey: "pk", secretKey: "sk", fetchImpl });
    const tracer = new Tracer([sink]);
    const { root, agentSpan } = runTrace(tracer);
    await sink.close();

    const spans = calls.flatMap((c) => c.spans);
    const byName = (name: string) => spans.find((s) => s.name === name)!;
    const traceId = otelTraceId(tracer.traceId);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans.every((s) => s.traceId === traceId && /^[0-9a-f]{16}$/.test(s.spanId))).toBe(true);

    const rootSpan = byName("travel-request");
    expect(rootSpan.spanId).toBe(otelSpanId(tracer.traceId, root));
    expect(rootSpan.parentSpanId).toBeUndefined();
    expect(attr(rootSpan, "langfuse.observation.input")).toBe("Flights LHR to JFK");
    expect(attr(rootSpan, "langfuse.observation.output")).toBe("Flight data is unavailable.");
    expect(attr(rootSpan, "langfuse.trace.name")).toBe("travel-request");

    const agent = byName("agent:flight");
    expect(agent.parentSpanId).toBe(rootSpan.spanId);
    expect(attr(agent, "langfuse.observation.type")).toBe("agent");
    expect(agent.status.code).toBe(2);

    const generation = byName("model:agent:flight");
    expect(generation.parentSpanId).toBe(otelSpanId(tracer.traceId, agentSpan));
    expect(attr(generation, "langfuse.observation.type")).toBe("generation");
    expect(attr(generation, "langfuse.observation.model.name")).toBe("nemotron");
    expect(JSON.parse(attr(generation, "langfuse.observation.input")!)).toEqual([{ role: "system", content: "You are the Flight Agent" }, { role: "user", content: "LHR to JFK" }]);
    expect(JSON.parse(attr(generation, "langfuse.observation.output")!).thinking).toContain("call search_flights");
    expect(JSON.parse(attr(generation, "langfuse.observation.usage_details")!)).toEqual({ input: 300, output: 40, total: 340 });
    expect(attr(generation, "langfuse.observation.metadata.toolsOffered")).toBe('["search_flights"]');

    const tool = byName("tool:search_flights");
    expect(tool.parentSpanId).toBe(generation.parentSpanId);
    expect(attr(tool, "langfuse.observation.type")).toBe("tool");
    expect(attr(tool, "langfuse.observation.level")).toBe("ERROR");
    expect(attr(tool, "langfuse.observation.metadata.mcpServer")).toBe("kiwi");
    expect(BigInt(tool.endTimeUnixNano) - BigInt(tool.startTimeUnixNano)).toBe(45_000_000_000n);

    expect(attr(byName("policy:allow"), "langfuse.observation.type")).toBe("guardrail");
  });

  it("flushes as soon as a request finishes", async () => {
    const { calls, fetchImpl } = capture();
    const sink = new LangfuseSink({ baseUrl: "https://cloud.example", publicKey: "pk", secretKey: "sk", fetchImpl, flushIntervalMs: 60_000 });
    runTrace(new Tracer([sink]));
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await sink.close();
  });

  it("sends redacted data only", async () => {
    const { calls, fetchImpl } = capture();
    const sink = new LangfuseSink({ baseUrl: "https://cloud.example", publicKey: "pk", secretKey: "sk-lf-secret-value", fetchImpl });
    const tracer = new Tracer([sink], { secrets: ["nvapi-should-never-leave", "sk-lf-secret-value"] });
    tracer.emit("request", { message: "email me at jo@example.com, key nvapi-should-never-leave" });
    tracer.emit("final", { status: "declined", answer: "no" });
    await sink.close();
    const sent = JSON.stringify(calls.map((c) => c.spans));
    expect(sent).not.toContain("jo@example.com");
    expect(sent).not.toContain("nvapi-should-never-leave");
    expect(sent).not.toContain("sk-lf-secret-value");
  });

  it("never throws into the request when the cloud is unreachable", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const sink = new LangfuseSink({ baseUrl: "https://cloud.example", publicKey: "pk", secretKey: "sk", fetchImpl });
    expect(() => runTrace(new Tracer([sink]))).not.toThrow();
    await sink.close();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one retry, then reported
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("langfuse: could not send"));
    stderr.mockRestore();
  });

  it("ignores unknown event kinds", () => {
    expect(toOtelSpans({ kind: "other" as never, traceId: "t", requestId: "r", spanId: "s", timestamp: new Date().toISOString() }, undefined)).toEqual([]);
  });
});
