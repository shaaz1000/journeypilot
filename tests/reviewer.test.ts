import { describe, expect, it } from "vitest";
import { evidenceDigest, moneyAmounts, reviewAnswer } from "../src/review/evidence.js";
import type { Citation, EvidenceRecord, SpecialistResult } from "../src/schemas.js";

const flights: EvidenceRecord = {
  toolCallId: "tc_1", agent: "flight", tool: "search_flights", source: "mcp", server: "kiwi", dataSource: "live",
  data: { query: { maxPrice: 999 }, itineraries: [
    { price: 256, currency: "GBP", duration: "14h 15m", stops: 2, route: "LHR > AMS > SHJ", bookingUrl: "https://kiwi.com/u/aaa" },
    { price: 276, currency: "GBP", duration: "13h 35m", stops: 2, route: "LHR > WAW > SHJ", bookingUrl: "https://kiwi.com/u/bbb" },
  ] },
};
const hotels: EvidenceRecord = {
  toolCallId: "tc_2", agent: "hotel", tool: "search_hotels", source: "local", dataSource: "demo_fixture",
  data: { hotels: [{ name: "Bridgeview", nightlyRate: 142, totalStayCost: 426, currency: "GBP", nights: 3 }] },
};
const now = Date.now();
const page: EvidenceRecord = {
  toolCallId: "tc_3", agent: "benefits", tool: "fetch_official_page", source: "local", dataSource: "official_page",
  citation: { url: "https://www.prioritypass.com/en-GB/conditions-of-use", title: "Conditions", retrievedAt: new Date(now).toISOString() },
  data: { url: "https://www.prioritypass.com/en-GB/conditions-of-use", excerpts: ["Guests are charged GBP 24 per visit."] },
};
const result = (agent: SpecialistResult["agent"], evidence: EvidenceRecord[]): SpecialistResult => ({ agent, status: "ok", summary: "", evidence, errors: [] });
const cites = (rs: SpecialistResult[]): Citation[] => rs.flatMap((r) => r.evidence.flatMap((e) => (e.citation ? [e.citation] : [])));

describe("evidence reviewer", () => {
  it("parses money in several formats", () => {
    expect(moneyAmounts("£256, 276 GBP, USD 1,234.50 and $9")).toEqual([256, 276, 1234.5, 9]);
  });

  it("passes an answer whose prices and links come from tool results", () => {
    const rs = [result("flight", [flights])];
    expect(reviewAnswer("Cheapest is £256 (https://kiwi.com/u/aaa); £276 adds a cabin bag, a £20 premium.", rs, [], now)).toEqual({ passed: true, findings: [] });
  });

  it("flags an invented price", () => {
    const review = reviewAnswer("Fares start at £199.", [result("flight", [flights])], [], now);
    expect(review.findings).toEqual(["price 199 does not appear in any tool result"]);
  });

  it("does not let echoed query arguments ground a price", () => {
    expect(reviewAnswer("Budget fares under £999.", [result("flight", [flights])], [], now).passed).toBe(false);
  });

  it("does not accept differences across different tool results", () => {
    // 276 - 142 = 134 mixes a flight fare and a hotel rate.
    const rs = [result("flight", [flights]), result("hotel", [hotels])];
    expect(reviewAnswer("Demo hotel saves £134.", rs, [], now).passed).toBe(false);
  });

  it("flags links that were not returned exactly", () => {
    const review = reviewAnswer("Book at https://kiwi.com/u/aaa-fake", [result("flight", [flights])], [], now);
    expect(review.findings[0]).toMatch(/link .* does not appear/);
  });

  it("requires demo hotel data to be labelled in the body", () => {
    const rs = [result("hotel", [hotels])];
    expect(reviewAnswer("Bridgeview is £142 a night, £426 in total.", rs, [], now).findings).toContain("demo hotel data is not labelled as demo");
    expect(reviewAnswer("Bridgeview (demo data) is £142 a night, £426 in total.", rs, [], now).passed).toBe(true);
  });

  it("requires a fetched official page behind a benefits answer", () => {
    const registryOnly: EvidenceRecord = { ...page, tool: "find_official_sources", citation: undefined, data: { sources: [] } };
    expect(reviewAnswer("You can bring a guest.", [result("benefits", [registryOnly])], [], now).findings).toContain("benefit answer has no fetched official page behind it");
    const rs = [result("benefits", [page])];
    expect(reviewAnswer("Guests cost GBP 24 per visit.", rs, cites(rs), now).passed).toBe(true);
  });

  it("flags stale or undated sources", () => {
    const rs = [result("benefits", [page])];
    const stale: Citation[] = [{ ...page.citation!, retrievedAt: "yesterday-ish" }];
    expect(reviewAnswer("ok", rs, stale, now).passed).toBe(false);
    expect(reviewAnswer("ok", rs, cites(rs), now + 2 * 86_400_000).passed).toBe(false);
  });

  it("builds a digest using only tool output", () => {
    const digest = evidenceDigest([result("flight", [flights]), result("hotel", [hotels]), result("benefits", [page])]);
    expect(digest).toContain("256 GBP");
    expect(digest).toContain("demo data");
    expect(digest).toContain("GBP 24 per visit");
  });
});
