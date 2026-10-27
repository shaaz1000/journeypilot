import { randomUUID } from "node:crypto";
import type { TraceEvent, TraceSink } from "./tracer.js";

export interface LangfuseOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  fetchImpl?: typeof fetch;
}

interface IngestionItem {
  id: string;
  timestamp: string;
  type: "trace-create" | "span-create" | "generation-create" | "event-create";
  body: Record<string, unknown>;
}

type Level = "DEFAULT" | "WARNING" | "ERROR";

const startOf = (e: TraceEvent) =>
  typeof e.durationMs === "number" ? new Date(Date.parse(e.timestamp) - e.durationMs).toISOString() : e.timestamp;

/**
 * Maps one JourneyPilot trace event to Langfuse ingestion items. Events arrive already redacted.
 * `rootSpanId` is the request's span: its children attach to the trace itself rather than to an observation.
 */
export function toLangfuse(e: TraceEvent, rootSpanId: string | undefined): IngestionItem[] {
  const obs = (spanId: string) => `${e.traceId.slice(0, 8)}-${spanId}`;
  const parent = e.parentSpanId && e.parentSpanId !== rootSpanId ? obs(e.parentSpanId) : undefined;
  const item = (type: IngestionItem["type"], body: Record<string, unknown>): IngestionItem => ({ id: randomUUID(), timestamp: e.timestamp, type, body });
  const observation = (name: string, extra: Record<string, unknown>, level: Level = "DEFAULT") => ({
    id: obs(e.spanId),
    traceId: e.traceId,
    parentObservationId: parent,
    name,
    level,
    ...extra,
  });
  const event = (name: string, output: unknown, level: Level = "DEFAULT", input?: unknown) =>
    item("event-create", observation(name, { startTime: e.timestamp, input, output }, level));

  switch (e.kind) {
    case "request":
      return [item("trace-create", { id: e.traceId, timestamp: e.timestamp, name: "travel-request", input: e.message, metadata: { requestId: e.requestId }, tags: ["journeypilot"] })];
    case "classification":
      return [event("classification", { valid: e.valid, intents: e.intents, confidence: e.confidence, travelTask: e.travelTask, unsupportedPortion: e.unsupportedPortion }, e.valid ? "DEFAULT" : "WARNING")];
    case "policy":
      return [event(`policy:${e.outcome}`, { outcome: e.outcome, reason: e.reason, agents: e.agents, declinedPortion: e.declinedPortion }, e.outcome === "allow" ? "DEFAULT" : "WARNING")];
    case "delegation":
      return [event(`delegate:${e.agent}`, { reason: e.reason, task: e.task })];
    case "agent": {
      if (e.status === "reminded" || e.status === "model_error") return [event(`agent:${e.agent}:${e.status}`, { reason: e.reason, reply: e.reply, error: e.error }, "WARNING")];
      const level: Level = e.status === "failed" ? "ERROR" : e.status === "partial" ? "WARNING" : "DEFAULT";
      return [
        item("span-create", observation(`agent:${e.agent}`, {
          startTime: startOf(e),
          endTime: e.timestamp,
          input: { reason: e.reason },
          output: { status: e.status, summary: e.summary, toolCalls: e.toolCalls, errors: e.errors },
          metadata: { reminded: e.reminded },
          statusMessage: Array.isArray(e.errors) && e.errors.length ? e.errors.join("; ") : undefined,
        }, level)),
      ];
    }
    case "model": {
      const usage = e.usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
      return [
        item("generation-create", observation(`model:${String(e.purpose)}`, {
          startTime: startOf(e),
          endTime: e.timestamp,
          model: e.model,
          input: e.prompt,
          output: { thinking: e.reasoning ?? undefined, content: e.response ?? undefined, toolCalls: e.toolCalls },
          usage: usage ? { input: usage.promptTokens, output: usage.completionTokens, total: usage.totalTokens, unit: "TOKENS" } : undefined,
          metadata: { provider: e.provider, toolsOffered: e.toolsOffered, toolChoice: e.toolChoice, finishReason: e.finishReason },
          statusMessage: e.status === "error" ? e.error : undefined,
        }, e.status === "error" ? "ERROR" : "DEFAULT")),
      ];
    }
    case "tool":
      return [
        item("span-create", observation(`tool:${e.tool}`, {
          startTime: startOf(e),
          endTime: e.timestamp,
          input: e.args,
          output: e.status === "ok" ? e.result : { error: e.error },
          metadata: { agent: e.agent, status: e.status, source: e.source, mcpServer: e.server, attempts: e.attempts, dataSource: e.dataSource, toolCallId: e.toolCallId },
          statusMessage: e.status === "ok" ? undefined : String(e.error ?? e.status),
        }, e.status === "ok" ? "DEFAULT" : "ERROR")),
      ];
    case "review":
      return [event("evidence-review", { passed: e.passed, findings: e.findings, replaced: e.replaced }, e.replaced ? "WARNING" : "DEFAULT", e.rejectedBody)];
    case "final":
      return [
        item("trace-create", {
          id: e.traceId,
          output: e.answer,
          metadata: { requestId: e.requestId, status: e.status, durationMs: e.durationMs, agentsUsed: e.agentsUsed, sources: e.sources, limitations: e.limitations, review: e.review },
          tags: ["journeypilot", String(e.status)],
        }),
      ];
    default:
      return [];
  }
}

/**
 * Sends trace events to Langfuse Cloud through its public ingestion API. Batches in the background;
 * failures are reported on stderr and never affect request handling.
 */
export class LangfuseSink implements TraceSink {
  private queue: IngestionItem[] = [];
  private readonly roots = new Map<string, string>();
  private readonly timer: NodeJS.Timeout;
  private sending: Promise<void> = Promise.resolve();
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: LangfuseOptions) {
    this.auth = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timer = setInterval(() => void this.flush(), options.flushIntervalMs ?? 2000);
    this.timer.unref();
  }

  write(event: TraceEvent): void {
    try {
      if (event.kind === "request") this.roots.set(event.traceId, event.spanId);
      this.queue.push(...toLangfuse(event, this.roots.get(event.traceId)));
      const max = this.options.maxQueue ?? 2000;
      if (this.queue.length > max) {
        process.stderr.write(`langfuse: queue over ${max} items, dropping the oldest\n`);
        this.queue.splice(0, this.queue.length - max);
      }
      if (event.kind === "final") {
        this.roots.delete(event.traceId);
        void this.flush();
      } else if (this.queue.length >= (this.options.maxBatch ?? 50)) void this.flush();
    } catch (error) {
      process.stderr.write(`langfuse: could not map event: ${String(error)}\n`);
    }
  }

  /** Sends everything queued so far. Calls are serialised so batches stay in order. */
  flush(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, this.options.maxBatch ?? 50);
        await this.send(batch);
      }
    });
    return this.sending;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private async send(batch: IngestionItem[], attempt = 1): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/api/public/ingestion`, {
        method: "POST",
        headers: { Authorization: this.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ batch }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 500 && attempt < 2) return this.send(batch, attempt + 1);
      if (!response.ok) {
        process.stderr.write(`langfuse: ingestion returned ${response.status}: ${(await response.text()).slice(0, 200)}\n`);
        return;
      }
      const result = (await response.json().catch(() => ({}))) as { errors?: { status?: number; message?: string }[] };
      if (result.errors?.length) process.stderr.write(`langfuse: ${result.errors.length} of ${batch.length} events rejected: ${result.errors[0]?.message ?? ""}\n`);
    } catch (error) {
      if (attempt < 2) return this.send(batch, attempt + 1);
      process.stderr.write(`langfuse: could not send ${batch.length} events: ${String(error)}\n`);
    }
  }
}
