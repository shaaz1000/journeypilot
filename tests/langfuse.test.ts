import { describe, expect, it, vi } from "vitest";
import { LangfuseSink, toLangfuse } from "../src/trace/langfuse.js";
import { Tracer } from "../src/trace/tracer.js";

function capture() {
  const bodies: { batch: { type: string; body: Record<string, unknown> }[] }[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    headers.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ successes: [], errors: [] }), { status: 207 });
  });
  return { bodies, headers, fetchImpl: fetchImpl as unknown as typeof fetch };
}

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

describe("Langfuse export", () => {
  it("maps a request to a trace with nested generations and spans", async () => {
    const { bodies, headers, fetchImpl } = capture();
    const sink = new LangfuseSink({ baseUrl: "https://cloud.example", publicKey: "pk-lf-1", secretKey: "sk-lf-1", fetchImpl });
    const tracer = new Tracer([sink]);
    const { agentSpan } = runTrace(tracer);
    await sink.close();

    expect(headers[0]?.Authorization).toBe(`Basic ${Buffer.from("pk-lf-1:sk-lf-1").toString("base64")}`);
    const items = bodies.flatMap((b) => b.batch);
    const types = items.map((i) => i.type);
    expect(types.filter((t) => t === "trace-create")).toHaveLength(2); // created on request, updated with the output
    const generation = items.find((i) => i.type === "generation-create")!.body;
    expect(generation).toMatchObject({ name: "model:agent:flight", model: "nemotron", usage: { input: 300, output: 40, total: 340, unit: "TOKENS" } });
    expect(generation.input).toEqual([{ role: "system", content: "You are the Flight Agent" }, { role: "user", content: "LHR to JFK" }]);
    expect((generation.output as { thinking: string }).thinking).toContain("call search_flights");

    const agentObservation = `${tracer.traceId.slice(0, 8)}-${agentSpan}`;
    expect(generation.parentObservationId).toBe(agentObservation);
    const tool = items.find((i) => i.body.name === "tool:search_flights")!.body;
    expect(tool).toMatchObject({ parentObservationId: agentObservation, level: "ERROR", statusMessage: "timed out" });
    const agent = items.find((i) => i.body.name === "agent:flight")!.body;
    expect(agent).toMatchObject({ id: agentObservation, level: "ERROR" });
    expect(agent.parentObservationId).toBeUndefined(); // direct child of the request attaches to the trace
    expect(Date.parse(String(agent.startTime))).toBeLessThan(Date.parse(String(agent.endTime)));
  });

  it("flushes as soon as a request finishes", async () => {
    const { bodies, fetchImpl } = capture();
    const sink = new LangfuseSink({ baseUrl: "https://cloud.example", publicKey: "pk", secretKey: "sk", fetchImpl, flushIntervalMs: 60_000 });
    runTrace(new Tracer([sink]));
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    await sink.close();
  });

  it("sends redacted data only", async () => {
    const { bodies, fetchImpl } = capture();
    const sink = new LangfuseSink({ baseUrl: "https://cloud.example", publicKey: "pk", secretKey: "sk-lf-secret-value", fetchImpl });
    const tracer = new Tracer([sink], { secrets: ["nvapi-should-never-leave", "sk-lf-secret-value"] });
    tracer.emit("request", { message: "email me at jo@example.com, key nvapi-should-never-leave" });
    tracer.emit("final", { status: "declined", answer: "no" });
    await sink.close();
    const sent = JSON.stringify(bodies);
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
    expect(toLangfuse({ kind: "other" as never, traceId: "t", requestId: "r", spanId: "s", timestamp: new Date().toISOString() }, undefined)).toEqual([]);
  });
});
