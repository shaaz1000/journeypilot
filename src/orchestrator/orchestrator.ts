import { runSpecialist, type SpecialistConfig } from "../agents/specialist.js";
import type { LlmClient } from "../llm/types.js";
import { AGENT_LABELS, MAX_HISTORY_TURNS, type AgentName, type ChatTurn, type Citation, type FinalAnswer, type FinalStatus, type PolicyDecision, type RequiredDetail, type SpecialistResult } from "../schemas.js";
import type { ToolGateway } from "../tools/gateway.js";
import type { Tracer } from "../trace/tracer.js";
import { classify } from "./classifier.js";
import { composeAnswer } from "./compose.js";
import { decidePolicy } from "./policy.js";

export interface OrchestratorDeps {
  llm: LlmClient;
  gateway: ToolGateway;
  specialists: Record<AgentName, SpecialistConfig>;
  newTracer: () => Tracer;
}

export const MAX_MESSAGE_CHARS = 2000;

const SCOPE_TEXT = "I can help with flights, hotels, trip planning, airport lounges, Priority Pass and travel-card benefits.";

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Handles one message. `history` holds the conversation so far, so "15 November" can complete
   * "a Bombay to Delhi ticket" and "in INR, business class" can refine the last search.
   */
  async handle(message: string, options: { history?: ChatTurn[]; conversationId?: string } = {}): Promise<{ result: FinalAnswer; tracer: Tracer }> {
    const tracer = this.deps.newTracer();
    const rootSpan = tracer.newSpanId();
    const started = performance.now();
    const history = (options.history ?? [])
      .slice(-MAX_HISTORY_TURNS)
      .map((turn) => ({ role: turn.role, text: turn.text.trim().slice(0, MAX_MESSAGE_CHARS) }))
      .filter((turn) => turn.text);
    tracer.emit("request", { message, chars: message.length, conversationId: options.conversationId, history }, { spanId: rootSpan });

    let conversationUse: FinalAnswer["conversationUse"] = "new_request";
    const finish = (
      status: FinalStatus,
      answer: string,
      extra: Partial<Omit<FinalAnswer, "requestId" | "traceId" | "status" | "answer">> = {},
    ) => {
      const result: FinalAnswer = {
        requestId: tracer.requestId,
        traceId: tracer.traceId,
        status,
        conversationUse,
        answer,
        body: extra.body ?? answer,
        agentsUsed: extra.agentsUsed ?? [],
        citations: extra.citations ?? [],
        limitations: extra.limitations ?? [],
        review: extra.review ?? { passed: true, findings: [], replaced: false },
      };
      tracer.emit(
        "final",
        {
          status,
          durationMs: Math.round(performance.now() - started),
          agentsUsed: result.agentsUsed,
          sources: result.citations.map((c) => c.url),
          limitations: result.limitations,
          review: result.review,
          // The answer is the system's own output, so it is logged in full (redacted) for review.
          answer,
        },
        { parentSpanId: rootSpan },
      );
      return { result, tracer };
    };

    const trimmed = message.trim();
    if (!trimmed || trimmed.length > MAX_MESSAGE_CHARS) {
      tracer.emit("policy", { outcome: "refuse_malformed", reason: "empty or over-long message", agents: [] }, { parentSpanId: rootSpan });
      return finish("refused", `Please send a travel question of up to ${MAX_MESSAGE_CHARS} characters. ${SCOPE_TEXT}`);
    }

    // 1. Classify and plan. Any failure here fails closed: no agent or tool runs.
    let raw: unknown;
    try {
      raw = await classify(this.deps.llm, tracer, trimmed, rootSpan, history);
    } catch (error) {
      tracer.emit("policy", { outcome: "refuse_malformed", reason: `classifier unavailable: ${String(error)}`, agents: [] }, { parentSpanId: rootSpan });
      return finish("failed", "JourneyPilot could not process your request right now because the language model is unavailable. Please try again shortly.");
    }
    const decision = decidePolicy(raw);
    const classification = raw as Record<string, unknown> | null;
    // Only a validated classification with real history can claim to continue the conversation.
    if (decision.outcome !== "refuse_malformed" && history.length > 0 && classification?.conversation_use === "continue") conversationUse = "continue";
    tracer.emit(
      "classification",
      { valid: decision.outcome !== "refuse_malformed", conversationUse: classification?.conversation_use, historyTurns: history.length, intents: classification?.intents, confidence: classification?.confidence, travelTask: classification?.travel_task, missingDetails: classification?.missing_details, unsupportedPortion: classification?.unsupported_portion },
      { parentSpanId: rootSpan },
    );
    tracer.emit("policy", { outcome: decision.outcome, reason: decision.reason, agents: decision.agents, declinedPortion: decision.declinedPortion, missingDetails: decision.missingDetails }, { parentSpanId: rootSpan });

    if (decision.outcome === "refuse_malformed") {
      return finish("refused", `I couldn't interpret that request safely, so I haven't acted on it. ${SCOPE_TEXT}`);
    }
    if (decision.outcome === "decline") {
      return finish("declined", `Sorry, that's outside what JourneyPilot covers. ${SCOPE_TEXT}`, { limitations: declinedNote(decision) });
    }
    if (decision.outcome === "clarify") {
      if (decision.missingDetails?.length) return finish("clarify", askFor(decision.missingDetails), { limitations: declinedNote(decision) });
      const question = typeof classification?.clarifying_question === "string" && classification.clarifying_question.trim();
      return finish("clarify", question || `Could you tell me a bit more about your trip? ${SCOPE_TEXT}`);
    }

    // 2. Delegate: only the agents the validated intents justify, each given only the travel task.
    const task = String(classification?.travel_task);
    const results = await Promise.all(
      decision.agents.map((agent) => {
        const reason = `policy selected ${agent} for ${decision.reason}`;
        tracer.emit("delegation", { agent, reason, task }, { parentSpanId: rootSpan });
        return runSpecialist(this.deps.specialists[agent], task, { llm: this.deps.llm, gateway: this.deps.gateway, tracer }, { reason, parentSpanId: rootSpan });
      }),
    );

    // 3. Combine: the model picks results and writes the prose, code renders the data, a judge checks the prose.
    const citations = uniqueCitations(results);
    const limitations = [...limitationsFor(results), ...declinedNote(decision)];
    const { body, review } = await composeAnswer(this.deps.llm, tracer, task, results, rootSpan);
    tracer.emit("review", { passed: review.passed, findings: review.findings, replaced: review.replaced }, { parentSpanId: rootSpan });

    const failed = results.filter((r) => r.status === "failed").length;
    const status: FinalStatus = results.every((r) => r.status === "needs_input")
      ? "clarify"
      : failed === results.length
        ? "failed"
        : failed > 0 || results.some((r) => r.status === "partial" || r.status === "needs_input")
          ? "partial"
          : "answered";
    return finish(status, compose(body, citations, limitations), {
      body,
      agentsUsed: results.map((r) => r.agent),
      citations,
      limitations,
      review,
    });
  }
}

function uniqueCitations(results: SpecialistResult[]): Citation[] {
  const byUrl = new Map<string, Citation>();
  for (const e of results.flatMap((r) => r.evidence)) if (e.citation) byUrl.set(e.citation.url, e.citation);
  return [...byUrl.values()];
}

const SERVICE = AGENT_LABELS;

/** Plain-language reason for a failure; the technical detail stays in the trace. */
function failureNote(agent: AgentName, errors: string[]): string {
  const kind = errors[0]?.split(": ").pop() ?? "";
  const service = SERVICE[agent];
  if (kind === "timeout") return `The ${service} service took too long to reply. Please try again in a minute.`;
  if (kind === "invalid_args") return `The ${service} couldn't use some details, for example a date in the past. Please check the dates and places.`;
  if (kind === "provider" || kind === "malformed_output") return `The ${service} service isn't responding properly right now. Please try again shortly.`;
  return `The ${service} couldn't be completed this time. Please try again.`;
}

const QUESTION: Record<RequiredDetail, string> = {
  origin: "Where are you flying from?",
  destination: "Where are you flying to?",
  departure_date: "Which date do you want to fly?",
  hotel_city: "Which city do you want to stay in?",
  check_in_date: "Which date do you want to check in?",
  nationality: "Which passport will you be travelling on?",
  layover_city: "Which city is the layover in?",
};

/** A short, direct question for the details a search needs, with an example of a complete request. */
function askFor(missing: RequiredDetail[]): string {
  const flight = missing.some((d) => d === "origin" || d === "destination" || d === "departure_date");
  const transit = missing.some((d) => d === "nationality" || d === "layover_city");
  const example = flight ? "Mumbai to Delhi on 15 November for 2 people" : transit ? "a 10 hour layover in Doha on an Indian passport" : "London, 3 nights from 10 December";
  return `I can search that for you. ${missing.map((d) => QUESTION[d]).join(" ")}\n\nFor example: "${example}".`;
}

function limitationsFor(results: SpecialistResult[]): string[] {
  const notes: string[] = [];
  for (const r of results) {
    if (r.status === "failed") notes.push(failureNote(r.agent, r.errors));
    else if (r.status === "partial") notes.push(`Some ${SERVICE[r.agent]} results may be missing because part of the search didn't respond.`);
  }
  if (results.some((r) => r.evidence.some((e) => e.dataSource === "demo_fixture"))) {
    notes.push("Hotel options are demo data, not live availability or bookable rates.");
  }
  if (results.some((r) => r.evidence.some((e) => e.dataSource === "live"))) {
    notes.push("Flight fares are live search results from Kiwi.com and can change before booking.");
  }
  return notes;
}

function declinedNote(decision: PolicyDecision): string[] {
  return decision.declinedPortion ? [`Not answered because it is outside travel and airport topics: ${decision.declinedPortion}`] : [];
}

function compose(body: string, citations: Citation[], limitations: string[]): string {
  const parts = [body];
  if (limitations.length) parts.push(`Limitations:\n${limitations.map((l) => `- ${l}`).join("\n")}`);
  if (citations.length) parts.push(`Sources:\n${citations.map((c) => `- ${c.title}: ${c.url} (retrieved ${c.retrievedAt})`).join("\n")}`);
  return parts.join("\n\n");
}
