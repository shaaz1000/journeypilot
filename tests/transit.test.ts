import { describe, expect, it, vi } from "vitest";
import { decidePolicy } from "../src/orchestrator/policy.js";
import { buildCatalog } from "../src/review/evidence.js";
import { ToolGateway } from "../src/tools/gateway.js";
import { createFetchVisaPageTool, findVisaSourcesTool, planLayoverTool } from "../src/tools/transit.js";
import { Tracer } from "../src/trace/tracer.js";

const gateway = (fetchImpl: typeof fetch = fetch) =>
  new ToolGateway([planLayoverTool, findVisaSourcesTool, createFetchVisaPageTool(fetchImpl)], { transit: ["plan_layover", "find_visa_sources", "fetch_visa_page"] });

async function layover(args: unknown) {
  const result = await gateway().invoke("transit", "plan_layover", args, new Tracer());
  if (!result.ok) throw result.error;
  return result.evidence;
}

describe("layover planning", () => {
  it("leaves time for the city on a 10 hour layover with a 30 minute ride", async () => {
    const e = await layover({ layoverHours: 10, airportToCityMinutes: 30 });
    // 600 minutes, minus 60 to leave the airport, 180 to be back before departure, 2 x 30 travel.
    expect(e.data).toMatchObject({ usableHoursInCity: 5, travelTimeSource: "given", verdict: expect.stringContaining("Enough time") });
  });

  it("says to stay airside when the layover is too short", async () => {
    const e = await layover({ layoverHours: 5 });
    expect(e.data).toMatchObject({ usableHoursInCity: 0, travelTimeSource: "assumed default", verdict: expect.stringContaining("stay airside") });
  });

  it("renders the time budget and its assumptions from the data", async () => {
    const e = await layover({ layoverHours: 10, airportToCityMinutes: 30 });
    const [entry] = buildCatalog([{ agent: "transit", status: "ok", summary: "", evidence: [e], errors: [] }]);
    expect(entry).toMatchObject({ ref: "X1", kind: "fact" });
    expect(entry!.line).toContain("**About 5 hours usable in the city** out of a 10 hour layover");
    expect(entry!.line).toContain("30 minutes each way (given)");
  });
});

describe("visa sources", () => {
  it("finds the official page for the layover country", async () => {
    const result = await gateway().invoke("transit", "find_visa_sources", { place: "Doha" }, new Tracer());
    if (!result.ok) throw result.error;
    expect((result.evidence.data as { sources: { publisher: string }[] }).sources.map((s) => s.publisher)).toEqual(["Qatar Tourism"]);
  });

  it("matches whole place names only", async () => {
    const find = async (place: string) => {
      const result = await gateway().invoke("transit", "find_visa_sources", { place }, new Tracer());
      if (!result.ok) throw result.error;
      return (result.evidence.data as { sources: { publisher: string }[] }).sources.map((s) => s.publisher);
    };
    expect(await find("Mauritius")).toEqual([]);
    expect(await find("New York JFK")).toEqual(["U.S. Department of State"]);
  });

  it("says so when no official page covers the place", async () => {
    const result = await gateway().invoke("transit", "find_visa_sources", { place: "Dubai" }, new Tracer());
    if (!result.ok) throw result.error;
    expect(result.evidence.data).toMatchObject({ sources: [], note: expect.stringContaining("No official immigration page for Dubai") });
  });

  it("only fetches government immigration domains", async () => {
    const fetchImpl = vi.fn();
    const result = await gateway(fetchImpl as unknown as typeof fetch).invoke("transit", "fetch_visa_page", { url: "https://www.visa-blog.example/qatar", query: "transit" }, new Tracer());
    expect(!result.ok && result.error.kind).toBe("invalid_args");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for the passport before running a visa question", () => {
    const decision = decidePolicy({ conversation_use: "new_request", intents: ["transit_visa"], confidence: 0.9, travel_task: "10 hour layover in Doha", unsupported_portion: "", missing_details: ["nationality"] });
    expect(decision).toMatchObject({ outcome: "clarify", missingDetails: ["nationality"] });
  });
});
