import { createHash } from "node:crypto";
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

type Level = "DEFAULT" | "WARNING" | "ERROR";
type ObservationType = "span" | "generation" | "event" | "agent" | "tool" | "guardrail";

interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}

/** OTLP wants 32-hex trace IDs and 16-hex span IDs; ours are UUIDs and short UUID slices, so derive stable ones. */
export const otelTraceId = (traceId: string) => traceId.replaceAll("-", "").padEnd(32, "0").slice(0, 32);
export const otelSpanId = (traceId: string, spanId: string) => createHash("sha256").update(`${traceId}:${spanId}`).digest("hex").slice(0, 16);

const nanos = (iso: string) => `${BigInt(Date.parse(iso)) * 1_000_000n}`;
const json = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

function attrs(values: Record<string, unknown>): OtlpAttribute[] {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, v]) => ({ key, value: { stringValue: json(v) } }));
}

interface Observation {
  name: string;
  type: ObservationType;
  start: string;
  end: string;
  input?: unknown;
  output?: unknown;
  level?: Level;
  statusMessage?: string;
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  /** Overrides for the root span. */
  spanId?: string;
  parentSpanId?: string | null;
}

/** Per-trace state the mapping needs: the request's span (the root) and its message. */
export interface TraceState {
  rootSpanId: string;
  startedAt: string;
  message: unknown;
  /** The chat conversation; Langfuse groups traces with the same session id. */
  sessionId?: unknown;
}

/**
 * Maps one JourneyPilot trace event (already redacted) to OTLP spans with Langfuse attributes.
 * The request becomes the root span, written when the final event arrives so it carries the answer.
 */
export function toOtelSpans(e: TraceEvent, state: TraceState | undefined): OtlpSpan[] {
  const traceId = otelTraceId(e.traceId);
  const startOf = typeof e.durationMs === "number" ? new Date(Date.parse(e.timestamp) - e.durationMs).toISOString() : e.timestamp;

  const span = (o: Observation): OtlpSpan => {
    const parent = o.parentSpanId === null ? undefined : (o.parentSpanId ?? e.parentSpanId);
    const metadata = Object.fromEntries(Object.entries(o.metadata ?? {}).map(([k, v]) => [`langfuse.observation.metadata.${k}`, v]));
    return {
      traceId,
      spanId: otelSpanId(e.traceId, o.spanId ?? e.spanId),
      parentSpanId: parent ? otelSpanId(e.traceId, parent) : undefined,
      name: o.name,
      kind: 1,
      startTimeUnixNano: nanos(o.start),
      endTimeUnixNano: nanos(o.end),
      attributes: attrs({
        "langfuse.observation.type": o.type,
        "langfuse.observation.input": o.input,
        "langfuse.observation.output": o.output,
        "langfuse.observation.level": o.level ?? "DEFAULT",
        "langfuse.observation.status_message": o.statusMessage,
        ...metadata,
        ...o.extra,
      }),
      status: o.level === "ERROR" ? { code: 2, message: o.statusMessage } : { code: 0 },
    };
  };
  const event = (name: string, type: ObservationType, output: unknown, level: Level = "DEFAULT", input?: unknown) =>
    span({ name, type, start: e.timestamp, end: e.timestamp, input, output, level });

  switch (e.kind) {
    case "request":
      return [];
    case "classification":
      return [event("classification", "event", { valid: e.valid, conversationUse: e.conversationUse, historyTurns: e.historyTurns, intents: e.intents, confidence: e.confidence, travelTask: e.travelTask, unsupportedPortion: e.unsupportedPortion }, e.valid ? "DEFAULT" : "WARNING")];
    case "policy":
      return [event(`policy:${e.outcome}`, "guardrail", { outcome: e.outcome, reason: e.reason, agents: e.agents, declinedPortion: e.declinedPortion }, e.outcome === "allow" ? "DEFAULT" : "WARNING")];
    case "delegation":
      return [event(`delegate:${e.agent}`, "event", { reason: e.reason, task: e.task })];
    case "agent": {
      if (e.status === "reminded" || e.status === "model_error") {
        return [event(`agent:${e.agent}:${e.status}`, "event", { reason: e.reason, reply: e.reply, error: e.error }, "WARNING")];
      }
      const errors = Array.isArray(e.errors) ? (e.errors as string[]) : [];
      return [
        span({
          name: `agent:${e.agent}`,
          type: "agent",
          start: startOf,
          end: e.timestamp,
          input: { reason: e.reason },
          output: { status: e.status, summary: e.summary, toolCalls: e.toolCalls, errors },
          level: e.status === "failed" ? "ERROR" : e.status === "partial" ? "WARNING" : "DEFAULT",
          statusMessage: errors.length ? errors.join("; ") : undefined,
          metadata: { reminded: e.reminded },
        }),
      ];
    }
    case "model": {
      const usage = e.usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
      return [
        span({
          name: `model:${String(e.purpose)}`,
          type: "generation",
          start: startOf,
          end: e.timestamp,
          input: e.prompt,
          output: { thinking: e.reasoning ?? undefined, content: e.response ?? undefined, toolCalls: e.toolCalls },
          level: e.status === "error" ? "ERROR" : "DEFAULT",
          statusMessage: e.status === "error" ? String(e.error) : undefined,
          metadata: { provider: e.provider, toolsOffered: e.toolsOffered, toolChoice: e.toolChoice, finishReason: e.finishReason },
          extra: {
            "langfuse.observation.model.name": e.model,
            "langfuse.observation.usage_details": usage ? { input: usage.promptTokens, output: usage.completionTokens, total: usage.totalTokens } : undefined,
          },
        }),
      ];
    }
    case "tool":
      return [
        span({
          name: `tool:${e.tool}`,
          type: "tool",
          start: startOf,
          end: e.timestamp,
          input: e.args,
          output: e.status === "ok" ? e.result : { error: e.error },
          level: e.status === "ok" ? "DEFAULT" : "ERROR",
          statusMessage: e.status === "ok" ? undefined : String(e.error ?? e.status),
          metadata: { agent: e.agent, status: e.status, source: e.source, mcpServer: e.server, attempts: e.attempts, dataSource: e.dataSource, toolCallId: e.toolCallId },
        }),
      ];
    case "review":
      return [event("evidence-review", "guardrail", { passed: e.passed, findings: e.findings, replaced: e.replaced }, e.replaced ? "WARNING" : "DEFAULT", e.rejectedBody)];
    case "final": {
      if (!state) return [];
      const status = String(e.status);
      return [
        span({
          name: "travel-request",
          type: "span",
          spanId: state.rootSpanId,
          parentSpanId: null,
          start: state.startedAt,
          end: e.timestamp,
          input: state.message,
          output: e.answer,
          level: status === "failed" ? "ERROR" : status === "partial" ? "WARNING" : "DEFAULT",
          metadata: { requestId: e.requestId, status, agentsUsed: e.agentsUsed, sources: e.sources, limitations: e.limitations, review: e.review },
          extra: {
            "langfuse.trace.name": "travel-request",
            "langfuse.session.id": typeof state.sessionId === "string" ? state.sessionId : undefined,
            "langfuse.trace.input": state.message,
            "langfuse.trace.output": e.answer,
            "langfuse.trace.tags": ["journeypilot", status],
            "langfuse.trace.metadata.requestId": e.requestId,
            "langfuse.trace.metadata.status": status,
          },
        }),
      ];
    }
    default:
      return [];
  }
}

/**
 * Sends trace events to Langfuse Cloud over its OpenTelemetry endpoint (OTLP/HTTP JSON). Batches in the
 * background; failures are reported on stderr and never affect request handling.
 */
export class LangfuseSink implements TraceSink {
  private queue: OtlpSpan[] = [];
  private readonly traces = new Map<string, TraceState>();
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
      if (event.kind === "request") this.traces.set(event.traceId, { rootSpanId: event.spanId, startedAt: event.timestamp, message: event.message, sessionId: event.conversationId });
      this.queue.push(...toOtelSpans(event, this.traces.get(event.traceId)));
      const max = this.options.maxQueue ?? 2000;
      if (this.queue.length > max) {
        process.stderr.write(`langfuse: queue over ${max} spans, dropping the oldest\n`);
        this.queue.splice(0, this.queue.length - max);
      }
      if (event.kind === "final") {
        this.traces.delete(event.traceId);
        void this.flush();
      } else if (this.queue.length >= (this.options.maxBatch ?? 50)) void this.flush();
    } catch (error) {
      process.stderr.write(`langfuse: could not map event: ${String(error)}\n`);
    }
  }

  /** Sends everything queued so far. Calls are serialised so batches stay in order. */
  flush(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.queue.length) await this.send(this.queue.splice(0, this.options.maxBatch ?? 50));
    });
    return this.sending;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private async send(spans: OtlpSpan[], attempt = 1): Promise<void> {
    const body = {
      resourceSpans: [
        {
          resource: { attributes: attrs({ "service.name": "journeypilot" }) },
          scopeSpans: [{ scope: { name: "journeypilot", version: "0.1.0" }, spans }],
        },
      ],
    };
    try {
      const base = this.options.baseUrl.endsWith("/") ? this.options.baseUrl.slice(0, -1) : this.options.baseUrl;
      const response = await this.fetchImpl(`${base}/api/public/otel/v1/traces`, {
        method: "POST",
        headers: { Authorization: this.auth, "Content-Type": "application/json", "x-langfuse-ingestion-version": "4" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 500 && attempt < 2) return this.send(spans, attempt + 1);
      if (!response.ok) {
        process.stderr.write(`langfuse: OTLP export returned ${response.status}: ${(await response.text()).slice(0, 200)}\n`);
        return;
      }
      const result = (await response.json().catch(() => ({}))) as { partialSuccess?: { rejectedSpans?: number | string; errorMessage?: string } };
      if (Number(result.partialSuccess?.rejectedSpans ?? 0) > 0) {
        process.stderr.write(`langfuse: ${result.partialSuccess?.rejectedSpans} of ${spans.length} spans rejected: ${result.partialSuccess?.errorMessage ?? ""}\n`);
      }
    } catch (error) {
      if (attempt < 2) return this.send(spans, attempt + 1);
      process.stderr.write(`langfuse: could not send ${spans.length} spans: ${String(error)}\n`);
    }
  }
}
