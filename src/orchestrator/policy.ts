import { ClassificationSchema, type AgentName, type PolicyDecision, type RequiredDetail, type TravelIntent } from "../schemas.js";

const FLIGHT_DETAILS = new Set<RequiredDetail>(["origin", "destination", "departure_date"]);
const HOTEL_DETAILS = new Set<RequiredDetail>(["hotel_city", "check_in_date"]);

export const MIN_CONFIDENCE = 0.6;

const AGENT_FOR_INTENT: Record<TravelIntent, AgentName | null> = {
  flight_search: "flight",
  hotel_search: "hotel",
  lounge_benefits: "benefits",
  destination_info: "destination",
  // Planning is the orchestrator's own synthesis step; it needs at least one data intent alongside it.
  trip_planning: null,
};

/**
 * Deterministic gate between the model's classification and any agent or tool execution.
 * Input is untyped on purpose: a malformed classification must be refused here, not trusted.
 */
export function decidePolicy(raw: unknown): PolicyDecision {
  const parsed = ClassificationSchema.safeParse(raw);
  if (!parsed.success) {
    return { outcome: "refuse_malformed", agents: [], reason: "classification failed schema validation" };
  }
  const c = parsed.data;
  const declinedPortion = c.unsupported_portion.trim() || undefined;

  if (c.intents.length === 0) {
    return { outcome: "decline", agents: [], reason: "no travel intent detected", declinedPortion };
  }
  if (c.confidence < MIN_CONFIDENCE) {
    return { outcome: "clarify", agents: [], reason: `confidence ${c.confidence} below ${MIN_CONFIDENCE}`, declinedPortion };
  }
  if (!c.travel_task.trim()) {
    return { outcome: "clarify", agents: [], reason: "travel intent without a usable task", declinedPortion };
  }

  const agents = [...new Set(c.intents.map((intent) => AGENT_FOR_INTENT[intent]).filter((a): a is AgentName => a !== null))];
  if (agents.length === 0) {
    return { outcome: "clarify", agents: [], reason: "planning request without flight, hotel or lounge details", declinedPortion };
  }
  // Only details that belong to a selected agent count; a stray hotel slot on a flight search is ignored.
  const relevant = c.missing_details.filter((d) => (FLIGHT_DETAILS.has(d) && agents.includes("flight")) || (HOTEL_DETAILS.has(d) && agents.includes("hotel")));
  if (relevant.length > 0) {
    return { outcome: "clarify", agents: [], reason: `missing ${relevant.join(", ")}`, declinedPortion, missingDetails: [...new Set(relevant)] };
  }
  return { outcome: "allow", agents, reason: `intents: ${c.intents.join(", ")}`, declinedPortion };
}
