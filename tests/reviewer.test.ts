import { describe, expect, it } from "vitest";
import { buildCatalog, structuralFindings, supportedIds } from "../src/review/evidence.js";
import type { EvidenceRecord, SpecialistResult } from "../src/schemas.js";

const flights: EvidenceRecord = {
  toolCallId: "tc_1", agent: "flight", tool: "search_flights", source: "mcp", server: "kiwi", dataSource: "live",
  data: { itineraries: [
    { price: 109, currency: "GBP", duration: "2h 20m", stops: 0, outbound: { route: "BOM > DEL", departure: "2026-11-02T06:05:00", flights: ["IndiGo 6E2001"] }, baggageIncluded: { checkedBag: 0 }, bookingUrl: "https://kiwi.com/u/aaa" },
    { price: 276, currency: "GBP", duration: "13h 35m", stops: 2, outbound: { route: "LHR > WAW > SHJ" }, baggageIncluded: { checkedBag: 1 }, bookingUrl: "https://kiwi.com/u/bbb" },
  ] },
};
const hotels: EvidenceRecord = {
  toolCallId: "tc_2", agent: "hotel", tool: "search_hotels", source: "local", dataSource: "demo_fixture",
  data: { hotels: [{ name: "Bridgeview [Heathrow]", area: "Heathrow T5", nightlyRate: 142, totalStayCost: 426, currency: "GBP", nights: 3, breakfastIncluded: true, cancellation: "Free cancellation" }] },
};
const now = Date.now();
const page: EvidenceRecord = {
  toolCallId: "tc_3", agent: "benefits", tool: "fetch_official_page", source: "local", dataSource: "official_page",
  citation: { url: "https://www.prioritypass.com/en-GB/conditions-of-use", title: "Conditions of Use", retrievedAt: new Date(now).toISOString() },
  data: { excerpts: ["Guests are charged GBP 24 per visit."] },
};
const registryOnly: EvidenceRecord = { ...page, tool: "find_official_sources", citation: undefined, data: { sources: [] } };
const result = (agent: SpecialistResult["agent"], evidence: EvidenceRecord[], status: SpecialistResult["status"] = "ok"): SpecialistResult => ({ agent, status, summary: "", evidence, errors: [] });

describe("evidence catalog", () => {
  it("numbers every returned result and renders its line from the data", () => {
    const catalog = buildCatalog([result("flight", [flights]), result("hotel", [hotels]), result("benefits", [page])]);
    expect(catalog.map((c) => c.ref)).toEqual(["F1", "F2", "H1", "S1"]);
    expect(catalog[0]!.line).toBe("**109 GBP**: BOM to DEL, direct, 2h 20m, departs 2 Nov 06:05, IndiGo, no checked bag. [Book on Kiwi.com](https://kiwi.com/u/aaa)");
    expect(catalog[1]!.line).toContain("2 stops");
    expect(catalog[1]!.line).toContain("checked bag included");
  });

  it("always labels hotel rows as demo data and keeps nightly and total cost apart", () => {
    const [hotel] = buildCatalog([result("hotel", [hotels])]);
    expect(hotel!.line).toContain("demo data");
    expect(hotel!.line).toContain("142 GBP per night, 426 GBP in total for 3 nights");
    expect(hotel!.line).not.toContain("[Heathrow]"); // provider text cannot create Markdown links
  });

  it("cites only pages that were actually fetched", () => {
    const catalog = buildCatalog([result("benefits", [registryOnly, page])]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ ref: "S1", line: "[Conditions of Use](https://www.prioritypass.com/en-GB/conditions-of-use)" });
  });
});

describe("link safety", () => {
  it("percent-encodes characters that could break out of a Markdown link and rejects other schemes", async () => {
    const { markdownUrl } = await import("../src/review/evidence.js");
    expect(markdownUrl("https://kiwi.com/u/a)(b[c]")).toBe("https://kiwi.com/u/a%29%28b%5Bc%5D");
    expect(markdownUrl("javascript:alert(1)")).toBeNull();
    expect(markdownUrl("not a url")).toBeNull();
  });
});

describe("structural checks", () => {
  it("flags references to results no tool returned", () => {
    const rs = [result("flight", [flights])];
    expect(structuralFindings(rs, buildCatalog(rs), ["F9"], now)).toEqual(["answer referred to F9, which no tool returned"]);
  });

  it("requires a fetched official page behind a benefits answer", () => {
    const rs = [result("benefits", [registryOnly])];
    expect(structuralFindings(rs, buildCatalog(rs), [], now)).toContain("benefit answer has no fetched official page behind it");
  });

  it("flags stale sources", () => {
    const rs = [result("benefits", [page])];
    expect(structuralFindings(rs, buildCatalog(rs), [], now + 2 * 86_400_000)[0]).toMatch(/stale/);
  });
});

describe("judge verdicts", () => {
  const statements = [{ id: "summary", text: "Fares start at 109 GBP." }, { id: "note:0", text: "Save 30 GBP by flying early." }];

  it("keeps only statements the judge explicitly supports", () => {
    const { kept, findings } = supportedIds(statements, [{ id: "summary", supported: true, reason: "" }, { id: "note:0", supported: false, reason: "no such saving in the evidence" }]);
    expect([...kept]).toEqual(["summary"]);
    expect(findings).toEqual(['removed note:0 ("Save 30 GBP by flying early."): no such saving in the evidence']);
  });

  it("fails closed when a verdict is missing or the judge is unavailable", () => {
    expect([...supportedIds(statements, [{ id: "summary", supported: true, reason: "" }]).kept]).toEqual(["summary"]);
    expect(supportedIds(statements, [{ id: "summary", supported: true, reason: "" }]).findings[0]).toContain("no verdict returned");
    expect(supportedIds(statements, null).kept.size).toBe(0);
  });
});
