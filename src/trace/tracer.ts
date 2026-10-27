import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redact, redactString } from "./redact.js";

export type TraceKind = "request" | "classification" | "policy" | "delegation" | "agent" | "tool" | "model" | "review" | "final";

export interface TraceEvent {
  kind: TraceKind;
  traceId: string;
  requestId: string;
  spanId: string;
  parentSpanId?: string;
  timestamp: string;
  [field: string]: unknown;
}

export interface TraceSink {
  write(event: TraceEvent): void;
  /** Sends anything buffered and stops background work; called on shutdown. */
  close?(): Promise<void>;
}

export class JsonlFileSink implements TraceSink {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  write(event: TraceEvent): void {
    try {
      appendFileSync(join(this.dir, `${event.timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(event)}\n`);
    } catch (error) {
      // A logging failure must never change request handling; report it and carry on.
      process.stderr.write(`trace write failed: ${String(error)}\n`);
    }
  }
}

export function pruneOldLogs(dir: string, retentionDays: number, now = Date.now()): string[] {
  const removed: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return removed;
  }
  for (const name of files) {
    const path = join(dir, name);
    if (now - statSync(path).mtimeMs > retentionDays * 86_400_000) {
      unlinkSync(path);
      removed.push(name);
    }
  }
  return removed;
}

export interface TracerOptions {
  rawPayloads?: boolean;
  secrets?: string[];
}

/** Collects correlated, redacted events for one request. Tests and evals read `events` directly. */
export class Tracer {
  readonly traceId = randomUUID();
  readonly requestId = `req_${randomUUID().slice(0, 8)}`;
  readonly events: TraceEvent[] = [];

  constructor(
    private readonly sinks: TraceSink[] = [],
    private readonly options: TracerOptions = {},
  ) {}

  get rawPayloads(): boolean {
    return this.options.rawPayloads ?? false;
  }

  newSpanId(): string {
    return randomUUID().slice(0, 12);
  }

  emit(kind: TraceKind, fields: Record<string, unknown>, span: { spanId?: string; parentSpanId?: string } = {}): string {
    const spanId = span.spanId ?? this.newSpanId();
    const event: TraceEvent = {
      ...redact(fields, { secrets: this.options.secrets }),
      kind,
      traceId: this.traceId,
      requestId: this.requestId,
      spanId,
      parentSpanId: span.parentSpanId,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    for (const sink of this.sinks) sink.write(event);
    return spanId;
  }

  /** Raw payloads only when enabled; otherwise a bounded preview. Redaction applies either way. */
  payload(value: unknown): unknown {
    if (this.rawPayloads) return value;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return null;
    // Redact the whole text before truncating so a cut can never leave a partial secret behind.
    return { preview: redactString(text, { secrets: this.options.secrets }).slice(0, 300), chars: text.length };
  }
}
