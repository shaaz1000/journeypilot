import { z } from "zod";

export const AGENT_NAMES = ["flight", "hotel", "benefits"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const TRAVEL_INTENTS = ["flight_search", "hotel_search", "lounge_benefits", "trip_planning"] as const;
export type TravelIntent = (typeof TRAVEL_INTENTS)[number];

/** What the orchestrator's classification call must return. Anything else fails closed. */
export const ClassificationSchema = z.object({
  intents: z.array(z.enum(TRAVEL_INTENTS)).max(4),
  confidence: z.number().min(0).max(1),
  travel_task: z.string().max(1000),
  unsupported_portion: z.string().max(1000),
  clarifying_question: z.string().max(300).default(""),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export type PolicyOutcome = "allow" | "decline" | "clarify" | "refuse_malformed";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  agents: AgentName[];
  reason: string;
  declinedPortion?: string;
}

export interface Citation {
  url: string;
  title: string;
  retrievedAt: string;
}

/** Recorded output of one tool call, used later as evidence. */
export interface EvidenceRecord {
  toolCallId: string;
  agent: AgentName;
  tool: string;
  source: "mcp" | "local";
  server?: string;
  dataSource: "live" | "demo_fixture" | "official_page";
  data: unknown;
  citation?: Citation;
}

export type SpecialistStatus = "ok" | "partial" | "failed";

export interface SpecialistResult {
  agent: AgentName;
  status: SpecialistStatus;
  summary: string;
  evidence: EvidenceRecord[];
  errors: string[];
}

export type FinalStatus = "answered" | "partial" | "declined" | "clarify" | "refused" | "failed";

export interface FinalAnswer {
  requestId: string;
  traceId: string;
  status: FinalStatus;
  /** Full text: body plus appended limitations and sources. */
  answer: string;
  /** The answer without the appended limitations and sources, for interfaces that render those separately. */
  body: string;
  agentsUsed: AgentName[];
  citations: Citation[];
  limitations: string[];
  review: { passed: boolean; findings: string[]; replaced: boolean };
}
