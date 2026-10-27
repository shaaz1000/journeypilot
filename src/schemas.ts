import { z } from "zod";

export const AGENT_NAMES = ["flight", "hotel", "benefits", "destination"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** How each agent's area is named to travellers. */
export const AGENT_LABELS: Record<AgentName, string> = {
  flight: "flight search",
  hotel: "hotel search",
  benefits: "lounge and card information",
  destination: "destination information",
};

export const TRAVEL_INTENTS = ["flight_search", "hotel_search", "lounge_benefits", "destination_info", "trip_planning"] as const;
export type TravelIntent = (typeof TRAVEL_INTENTS)[number];

/** One earlier turn of the conversation, sent by the chat client with each new message. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export const MAX_HISTORY_TURNS = 10;

/** Details a search cannot run without. Asked for before any agent runs. */
export const REQUIRED_DETAILS = ["origin", "destination", "departure_date", "hotel_city", "check_in_date"] as const;
export type RequiredDetail = (typeof REQUIRED_DETAILS)[number];

/** What the orchestrator's classification call must return. Anything else fails closed. */
export const CONVERSATION_USES = ["continue", "new_request"] as const;
export type ConversationUse = (typeof CONVERSATION_USES)[number];

export const ClassificationSchema = z.object({
  // Decided first: whether earlier turns feed into this request at all.
  conversation_use: z.enum(CONVERSATION_USES).default("new_request"),
  intents: z.array(z.enum(TRAVEL_INTENTS)).max(4),
  confidence: z.number().min(0).max(1),
  travel_task: z.string().max(1000),
  unsupported_portion: z.string().max(1000),
  missing_details: z.array(z.enum(REQUIRED_DETAILS)).max(5).default([]),
  clarifying_question: z.string().max(300).default(""),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export type PolicyOutcome = "allow" | "decline" | "clarify" | "refuse_malformed";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  agents: AgentName[];
  reason: string;
  declinedPortion?: string;
  missingDetails?: RequiredDetail[];
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

/** needs_input: the agent ran no tools and reported a missing detail instead of failing. */
export type SpecialistStatus = "ok" | "partial" | "failed" | "needs_input";

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
  /** Whether the classifier used the earlier conversation for this answer. */
  conversationUse: ConversationUse;
  /** Full text: body plus appended limitations and sources. */
  answer: string;
  /** The answer without the appended limitations and sources, for interfaces that render those separately. */
  body: string;
  agentsUsed: AgentName[];
  citations: Citation[];
  limitations: string[];
  review: { passed: boolean; findings: string[]; replaced: boolean };
}
