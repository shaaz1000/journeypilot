import { TOOL_PERMISSIONS } from "../src/agents/definitions.js";
import type { AgentName, FinalAnswer } from "../src/schemas.js";
import type { TraceEvent } from "../src/trace/tracer.js";
import type { EvalCase } from "./cases.js";

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
  /** Soft checks are reported but do not fail the case. */
  soft?: boolean;
}

const of = (events: TraceEvent[], kind: TraceEvent["kind"]) => events.filter((e) => e.kind === kind);
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Grades behaviour from the trace (policy, delegation, tools, grounding) before looking at the final text,
 * so a fluent answer produced by the wrong path still fails.
 */
export function grade(testCase: EvalCase, result: FinalAnswer, events: TraceEvent[]): Check[] {
  const { expect } = testCase;
  const checks: Check[] = [];
  const policy = of(events, "policy")[0]?.outcome as string | undefined;
  const delegated = of(events, "delegation").map((e) => e.agent as AgentName);
  const tools = of(events, "tool");

  checks.push({ name: "policy", passed: !!policy && expect.policy.includes(policy as never), detail: `got ${policy}, expected ${expect.policy.join("|")}` });
  checks.push({ name: "delegation", passed: sameSet(delegated, expect.agents), detail: `delegated [${delegated.join(", ")}], expected [${expect.agents.join(", ")}]` });

  if (policy !== "allow") {
    checks.push({ name: "blocked_before_execution", passed: tools.length === 0 && delegated.length === 0, detail: `${delegated.length} delegations, ${tools.length} tool calls` });
  }

  const violations = tools.filter((t) => t.status === "not_permitted" || !TOOL_PERMISSIONS[t.agent as AgentName]?.includes(t.tool as string));
  checks.push({ name: "tool_permissions", passed: violations.length === 0, detail: violations.length ? violations.map((v) => `${v.agent}->${v.tool}`).join(", ") : "all calls within permissions" });

  for (const tool of expect.requiredTools ?? []) {
    const calls = tools.filter((t) => t.tool === tool);
    const ok = calls.some((t) => t.status === "ok");
    checks.push({ name: `tool:${tool}`, passed: ok, detail: calls.length ? calls.map((c) => c.status).join(", ") : "never called" });
  }

  if (expect.mcp) {
    const mcpOk = tools.filter((t) => t.source === "mcp" && t.status === "ok");
    checks.push({ name: "mcp_used", passed: mcpOk.length > 0, detail: mcpOk.length ? `server ${mcpOk[0]?.server}` : "no successful MCP call" });
  }

  if (expect.status) {
    checks.push({ name: "status", passed: expect.status.includes(result.status), detail: `got ${result.status}` });
  }

  if (policy === "allow") {
    checks.push({ name: "grounding_review", passed: result.review.passed, detail: result.review.findings.join("; ") || "no findings" });
    // A replaced answer is still safe, but frequent replacement is a quality regression worth tracking.
    checks.push({ name: "synthesis_kept", passed: !result.review.replaced, detail: result.review.replaced ? "model answer replaced by evidence digest" : "model answer kept", soft: true });
  }

  if (expect.citations) {
    checks.push({ name: "citations", passed: result.citations.length > 0, detail: result.citations.map((c) => c.url).join(", ") || "none" });
  }
  for (const pattern of expect.answerIncludes ?? []) {
    checks.push({ name: `answer~${pattern.source}`, passed: pattern.test(result.answer), detail: "must match" });
  }
  for (const pattern of expect.answerExcludes ?? []) {
    checks.push({ name: `answer!~${pattern.source}`, passed: !pattern.test(result.answer), detail: "must not match" });
  }

  const support = excerptSupport(result, events);
  if (support) checks.push({ name: "excerpt_support", passed: support.ratio >= 0.6, detail: `${support.supported}/${support.total} answer lines overlap fetched page text`, soft: true });

  return checks;
}

const STOPWORDS = new Set(["about", "their", "there", "which", "would", "could", "should", "these", "those", "where", "while", "access", "lounge", "lounges", "priority"]);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{5,}/g)?.filter((w) => !STOPWORDS.has(w)) ?? []);

/**
 * Heuristic claim support for benefit answers: share of answer lines whose content words mostly appear in
 * fetched official excerpts. Needs raw payloads in the trace. A model-based judge would be the next step.
 */
function excerptSupport(result: FinalAnswer, events: TraceEvent[]): { supported: number; total: number; ratio: number } | null {
  const pages = of(events, "tool").filter((t) => t.tool === "fetch_official_page" && t.status === "ok");
  const excerpts = pages.flatMap((p) => ((p.result as { excerpts?: string[] } | undefined)?.excerpts ?? []));
  if (excerpts.length === 0) return null;
  const pageWords = words(excerpts.join(" "));
  const body = result.answer.split(/\n\n(?:Limitations|Sources):/)[0] ?? "";
  const lines = body.split("\n").map((l) => words(l)).filter((w) => w.size >= 3);
  if (lines.length === 0) return null;
  const supported = lines.filter((w) => [...w].filter((x) => pageWords.has(x)).length / w.size >= 0.4).length;
  return { supported, total: lines.length, ratio: supported / lines.length };
}
