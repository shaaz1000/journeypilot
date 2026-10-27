import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent } from "../trace/tracer.js";

export interface TraceSummary {
  traceId: string;
  requestId: string;
  startedAt: string;
  message: string;
  status: string;
  policy: string;
  agents: string[];
  toolCalls: number;
  toolErrors: number;
  reviewReplaced: boolean;
  durationMs: number | null;
}

/**
 * Reads the JSONL trace files the app writes. The files are the source of truth, so the admin view
 * shows exactly what was logged (already redacted), including requests from the CLI.
 */
export class TraceStore {
  constructor(private readonly dir: string) {}

  private readAll(): TraceEvent[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((name) => name.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
    const events: TraceEvent[] = [];
    for (const name of files) {
      for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as TraceEvent);
        } catch {
          // A partially written line is skipped rather than breaking the whole view.
        }
      }
    }
    return events;
  }

  private grouped(): Map<string, TraceEvent[]> {
    const byTrace = new Map<string, TraceEvent[]>();
    for (const event of this.readAll()) {
      const list = byTrace.get(event.traceId) ?? [];
      list.push(event);
      byTrace.set(event.traceId, list);
    }
    return byTrace;
  }

  list(limit = 100): TraceSummary[] {
    const summaries = [...this.grouped().values()].map(summarise);
    return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  get(traceId: string): TraceEvent[] | undefined {
    const events = this.grouped().get(traceId);
    return events?.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}

function summarise(events: TraceEvent[]): TraceSummary {
  const first = events[0]!;
  const find = (kind: TraceEvent["kind"]) => events.find((e) => e.kind === kind);
  const request = find("request");
  const final = find("final");
  const review = find("review");
  const tools = events.filter((e) => e.kind === "tool");
  return {
    traceId: first.traceId,
    requestId: first.requestId,
    startedAt: (request ?? first).timestamp,
    message: typeof request?.message === "string" ? request.message : "",
    status: typeof final?.status === "string" ? final.status : "in_progress",
    policy: typeof find("policy")?.outcome === "string" ? (find("policy")!.outcome as string) : "",
    agents: events.filter((e) => e.kind === "delegation").map((e) => String(e.agent)),
    toolCalls: tools.length,
    toolErrors: tools.filter((e) => e.status !== "ok").length,
    reviewReplaced: review?.replaced === true,
    durationMs: typeof final?.durationMs === "number" ? final.durationMs : null,
  };
}
