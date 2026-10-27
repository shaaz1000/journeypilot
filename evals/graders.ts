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

  if (expect.conversationUse) {
    checks.push({ name: "conversation_use", passed: result.conversationUse === expect.conversationUse, detail: `got ${result.conversationUse}, expected ${expect.conversationUse}` });
  }
  if (expect.toolArgs) {
    const { tool, args } = expect.toolArgs;
    const matched = tools.some((t) => t.tool === tool && t.status === "ok" && Object.entries(args).every(([k, v]) => (t.args as Record<string, unknown> | undefined)?.[k] === v));
    checks.push({ name: `tool_args:${tool}`, passed: matched, detail: matched ? JSON.stringify(args) : `no successful ${tool} call with ${JSON.stringify(args)}` });
  }

  if (expect.status) {
    checks.push({ name: "status", passed: expect.status.includes(result.status), detail: `got ${result.status}` });
  }

  if (policy === "allow") {
    checks.push({ name: "grounding_review", passed: result.review.passed, detail: result.review.findings.join("; ") || "no findings" });
    // A replaced answer is still safe, but frequent replacement is a quality regression worth tracking.
    checks.push({ name: "synthesis_kept", passed: !result.review.replaced, detail: result.review.replaced ? "some of the model's text was removed or not structured" : "model answer kept in full", soft: true });
  }

  if (expect.citations) {
    checks.push({ name: "citations", passed: result.citations.length > 0, detail: result.citations.map((c) => c.url).join(", ") || "none" });
  }
  const answer = result.answer.toLowerCase();
  for (const group of expect.answerIncludes ?? []) {
    checks.push({ name: `answer has ${group.join(" or ")}`, passed: group.some((phrase) => answer.includes(phrase.toLowerCase())), detail: "must contain one of these" });
  }
  for (const phrase of expect.answerExcludes ?? []) {
    checks.push({ name: `answer lacks ${phrase}`, passed: !answer.includes(phrase.toLowerCase()), detail: "must not contain" });
  }

  // The grounding judge's verdicts are in the trace: how many of the model's sentences it had to remove.
  const removed = (of(events, "review")[0]?.findings as string[] | undefined)?.filter((f) => f.startsWith("removed ")).length ?? 0;
  if (policy === "allow") checks.push({ name: "statements_supported", passed: removed === 0, detail: removed ? `${removed} sentence(s) removed by the grounding judge` : "all sentences supported", soft: true });

  return checks;
}
