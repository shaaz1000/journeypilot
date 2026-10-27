import { describe, expect, it } from "vitest";
import { decidePolicy, MIN_CONFIDENCE } from "../src/orchestrator/policy.js";

const valid = { intents: ["flight_search"], confidence: 0.9, travel_task: "Flights LHR to JFK on 2026-12-10", unsupported_portion: "" };

describe("policy gate", () => {
  it.each([
    ["null output", null],
    ["missing fields", { intents: ["flight_search"] }],
    ["unknown intent", { ...valid, intents: ["write_code"] }],
    ["confidence out of range", { ...valid, confidence: 1.4 }],
    ["wrong types", { ...valid, intents: "flight_search" }],
  ])("fails closed on %s", (_label, raw) => {
    const decision = decidePolicy(raw);
    expect(decision.outcome).toBe("refuse_malformed");
    expect(decision.agents).toEqual([]);
  });

  it("declines when no travel intent is present", () => {
    const decision = decidePolicy({ ...valid, intents: [], travel_task: "", unsupported_portion: "python code" });
    expect(decision).toMatchObject({ outcome: "decline", agents: [], declinedPortion: "python code" });
  });

  it("asks for clarification below the confidence threshold", () => {
    expect(decidePolicy({ ...valid, confidence: MIN_CONFIDENCE - 0.01 }).outcome).toBe("clarify");
  });

  it("asks for clarification when planning has no concrete domain", () => {
    expect(decidePolicy({ ...valid, intents: ["trip_planning"] }).outcome).toBe("clarify");
  });

  it("maps intents to the minimum set of agents, without duplicates", () => {
    const decision = decidePolicy({ ...valid, intents: ["flight_search", "lounge_benefits", "trip_planning", "flight_search"] });
    expect(decision.outcome).toBe("allow");
    expect(decision.agents).toEqual(["flight", "benefits"]);
  });

  it("keeps the unsupported portion of a mixed request for the answer", () => {
    const decision = decidePolicy({ ...valid, intents: ["lounge_benefits"], unsupported_portion: "write a poem" });
    expect(decision).toMatchObject({ outcome: "allow", agents: ["benefits"], declinedPortion: "write a poem" });
  });
});
