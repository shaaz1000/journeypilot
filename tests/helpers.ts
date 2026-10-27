import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { SPECIALISTS, TOOL_PERMISSIONS } from "../src/agents/definitions.js";
import type { ChatRequest, ChatResponse, LlmClient } from "../src/llm/types.js";
import { McpConnection } from "../src/mcp/connection.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { createFetchOfficialPageTool, findOfficialSourcesTool } from "../src/tools/benefits.js";
import { createFlightSearchTool } from "../src/tools/flights.js";
import { ToolGateway } from "../src/tools/gateway.js";
import { createCityTransportTool, createCurrencyTool, createLocalTimeTool, createThingsToDoTool } from "../src/tools/destination.js";
import { searchHotelsTool } from "../src/tools/hotels.js";
import { createFetchRightsPageTool, findRightsSourcesTool } from "../src/tools/rights.js";
import { createFetchVisaPageTool, findVisaSourcesTool, planLayoverTool } from "../src/tools/transit.js";
import { Tracer, type TraceEvent } from "../src/trace/tracer.js";

export const TEST_SECRET = "nvapi-test-secret-value-1234567890";

export const recordedKiwi = JSON.parse(readFileSync(new URL("./fixtures/kiwi-search-flight.recorded.json", import.meta.url), "utf8"));

export function toolCall(name: string, args: unknown): ChatResponse {
  return {
    content: null,
    toolCalls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    finishReason: "tool_calls",
  };
}

export function text(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: "stop" };
}

export function classification(fields: Partial<{ conversation_use: string; intents: string[]; confidence: number; travel_task: string; unsupported_portion: string; clarifying_question: string; missing_details: string[] }>): ChatResponse {
  return toolCall("classify_request", { intents: [], confidence: 0.9, travel_task: "", unsupported_portion: "", ...fields });
}

export type Script = (request: ChatRequest, toolResultsSoFar: number) => ChatResponse | Promise<ChatResponse>;

/** The orchestrator's structured answer: prose plus references to results that code renders. */
export function composed(fields: { summary?: string; picks?: { ref: string; comment?: string }[]; notes?: string[]; follow_up_question?: string }): ChatResponse {
  return toolCall("compose_answer", { summary: "", picks: [], notes: [], follow_up_question: "", ...fields });
}

/** A grounding judge that supports every statement except the ids listed in `reject`. */
export function judge(reject: string[] = []): Script {
  return (request) => {
    const content = String(request.messages[1]?.content ?? "");
    const open = "<statements>";
    const statements = JSON.parse(content.slice(content.indexOf(open) + open.length, content.indexOf("</statements>"))) as { id: string }[];
    return toolCall("record_verdicts", {
      verdicts: statements.map((s) => ({ id: s.id, supported: !reject.includes(s.id), reason: reject.includes(s.id) ? "not stated in the evidence" : "stated in the evidence" })),
    });
  };
}

/** Deterministic stand-in for the model. Scripts are keyed by the request purpose recorded in traces. */
export class ScriptedLlm implements LlmClient {
  readonly provider = "scripted";
  readonly model = "scripted-model";
  readonly calls: ChatRequest[] = [];

  private readonly scripts: Record<string, Script>;

  /** The grounding judge defaults to supporting everything; tests that exercise it pass their own. */
  constructor(scripts: Record<string, Script>) {
    this.scripts = { judge: judge(), ...scripts };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(structuredClone(request));
    const script = this.scripts[request.purpose];
    if (!script) throw new Error(`no script for purpose ${request.purpose}`);
    return script(request, request.messages.filter((m) => m.role === "tool").length);
  }

  purposes(): string[] {
    return this.calls.map((c) => c.purpose);
  }
}

export type KiwiBehaviour = "ok" | "error" | "non_json";

/**
 * A real MCP server over an in-memory transport, advertising a flight tool under a different name.
 * Each connection gets its own server instance, as a remote server gives each session its own state.
 */
export async function fakeKiwi(behaviour: KiwiBehaviour = "ok") {
  const received: Record<string, unknown>[] = [];
  const servers: McpServer[] = [];
  const serverTransports: InMemoryTransport[] = [];
  const newTransport = () => {
    const server = buildFakeKiwi(behaviour, received);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    servers.push(server);
    serverTransports.push(serverTransport);
    return clientTransport;
  };
  const connection = await McpConnection.open("kiwi", newTransport, 5000);
  return {
    connection,
    received,
    /** Simulates the remote side expiring the current session. */
    expireSession: async () => serverTransports[serverTransports.length - 1]!.close(),
    close: async () => {
      await connection.close();
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}

function buildFakeKiwi(behaviour: KiwiBehaviour, received: Record<string, unknown>[]): McpServer {
  const server = new McpServer({ name: "fake-kiwi", version: "1.0.0" });
  server.registerTool(
    "find-trips",
    {
      description: "fake flight search",
      inputSchema: {
        flyFrom: z.string(),
        flyTo: z.string(),
        departureDate: z.string(),
        returnDate: z.string().optional(),
        adults: z.number().optional(),
        cabinClass: z.string().optional(),
        currency: z.string().optional(),
        sort: z.string().optional(),
        max_sector_stopovers: z.number().optional(),
      },
    },
    async (args) => {
      received.push(args);
      if (behaviour === "error") return { isError: true, content: [{ type: "text", text: "upstream search failed" }] };
      if (behaviour === "non_json") return { content: [{ type: "text", text: "<html>maintenance</html>" }] };
      return { content: [{ type: "text", text: JSON.stringify(recordedKiwi) }] };
    },
  );
  return server;
}

export function pageResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, { status, headers: { "content-type": "text/html", ...headers } });
}

export const CAA_PAGE = `<html><head><title>Flight delays | UK Civil Aviation Authority</title></head><body>
<p>If your flight is delayed by more than three hours on arrival you may be entitled to compensation of up to 520 pounds, unless the delay was caused by extraordinary circumstances.</p>
<p>While you wait, the airline must provide food and drink, and accommodation if the delay is overnight.</p></body></html>`;

export const QATAR_VISA_PAGE = `<html><head><title>Visas | Visit Qatar</title></head><body>
<p>Citizens of India can enter Qatar visa-free for up to 30 days with a passport valid for six months and a confirmed return ticket.</p>
<p>Transit passengers with at least five hours between flights may apply for a free transit visa through Qatar Airways.</p></body></html>`;

export const AMEX_PAGE = `<html><head><title>Platinum Card | AMEX UK</title></head><body>
<p>Priority Pass membership: cardmembers get complimentary access to Priority Pass lounges worldwide for the cardmember and one guest.</p>
<p>Additional guests are charged at GBP 24 per guest per visit.</p></body></html>`;

/** Offline stand-ins for the exchange-rate, geocoding and Wikivoyage services. */
export const destinationFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.startsWith("https://api.frankfurter.dev/")) {
    if (url.includes("base=AED")) return new Response("{}", { status: 404 });
    return Response.json({ amount: 1, base: "GBP", date: "2026-10-27", rates: { INR: 126.78 } });
  }
  if (url.startsWith("https://open.er-api.com/")) return Response.json({ result: "success", time_last_update_utc: "Tue, 27 Oct 2026 00:02:31 +0000", rates: { INR: 25.94 } });
  if (url.startsWith("https://geocoding-api.open-meteo.com/")) return Response.json({ results: [{ name: "Doha", country: "Qatar", timezone: "Asia/Qatar", latitude: 25.28, longitude: 51.53 }] });
  if (url.startsWith("https://en.wikivoyage.org/")) {
    const html = `<div class="mw-parser-output">
      <div class="mw-heading mw-heading2"><h2 id="See">See</h2></div>
      <ul><li><span class="geo">25.29 51.53</span><span class="listing-name"><b>Museum of Islamic Art</b></span>, on the Corniche. One of the finest collections of Islamic art in the world.</li></ul>
      <div class="mw-heading mw-heading2"><h2 id="Get_in">Get in</h2></div>
      <p>The Doha Metro Red Line runs from Hamad International Airport to the city centre in about 20 minutes.</p>
    </div>`;
    return Response.json({ parse: { title: "Doha", text: html } });
  }
  return new Response("not found", { status: 404 });
};

export interface TestAppOptions {
  llm: LlmClient;
  kiwi?: McpConnection | null;
  fetchImpl?: typeof fetch;
}

export function testOrchestrator({ llm, kiwi = null, fetchImpl }: TestAppOptions) {
  const gateway = new ToolGateway(
    [
      createFlightSearchTool({ connect: async () => { if (!kiwi) throw new Error("test: no MCP connection"); return kiwi; }, serverName: "kiwi", timeoutMs: 2000 }),
      searchHotelsTool,
      findOfficialSourcesTool,
      createCurrencyTool(destinationFetch),
      createLocalTimeTool(destinationFetch, () => new Date("2026-11-02T14:30:00Z")),
      createThingsToDoTool(destinationFetch),
      findRightsSourcesTool,
      createFetchRightsPageTool(fetchImpl ?? (async () => pageResponse(CAA_PAGE))),
      planLayoverTool,
      createCityTransportTool(destinationFetch),
      findVisaSourcesTool,
      createFetchVisaPageTool(fetchImpl ?? (async () => pageResponse(QATAR_VISA_PAGE))),
      createFetchOfficialPageTool(fetchImpl ?? (async () => pageResponse(AMEX_PAGE)), 2000),
    ],
    TOOL_PERMISSIONS,
  );
  const tracers: Tracer[] = [];
  const orchestrator = new Orchestrator({
    llm,
    gateway,
    specialists: SPECIALISTS,
    newTracer: () => {
      const tracer = new Tracer([], { secrets: [TEST_SECRET] });
      tracers.push(tracer);
      return tracer;
    },
  });
  return { orchestrator, gateway, tracers };
}

export function eventsOf(events: TraceEvent[], kind: TraceEvent["kind"]): TraceEvent[] {
  return events.filter((e) => e.kind === kind);
}
