import { describe, expect, it, vi } from "vitest";
import { ToolGateway } from "../src/tools/gateway.js";
import { createFetchRightsPageTool, findRightsSourcesTool } from "../src/tools/rights.js";
import { Tracer } from "../src/trace/tracer.js";
import { CAA_PAGE, pageResponse } from "./helpers.js";

function gatewayWith(fetchImpl: typeof fetch) {
  return new ToolGateway([findRightsSourcesTool, createFetchRightsPageTool(fetchImpl)], { rights: ["find_rights_sources", "fetch_rights_page"] });
}

describe("passenger rights tools", () => {
  it("finds every set of rules a route can fall under", async () => {
    const result = await gatewayWith(fetch).invoke("rights", "find_rights_sources", { query: "flight from London to Delhi delayed 4 hours" }, new Tracer());
    if (!result.ok) throw result.error;
    const sources = (result.evidence.data as { sources: { publisher: string; note: string }[] }).sources;
    expect(sources.map((s) => s.publisher)).toEqual(expect.arrayContaining(["UK Civil Aviation Authority", expect.stringContaining("Government of India")]));
    expect(sources.every((s) => s.note.length > 0)).toBe(true);
  });

  it("only fetches regulator and government pages", async () => {
    const fetchImpl = vi.fn();
    const result = await gatewayWith(fetchImpl as unknown as typeof fetch).invoke("rights", "fetch_rights_page", { url: "https://www.airhelp.com/en/delays", query: "compensation" }, new Tracer());
    expect(!result.ok && result.error.kind).toBe("invalid_args");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns cited passages from the regulator's page", async () => {
    const result = await gatewayWith(async () => pageResponse(CAA_PAGE)).invoke(
      "rights",
      "fetch_rights_page",
      { url: "https://www.caa.co.uk/air-passengers/travel-problems-and-rights/flight-delays-and-cancellations/delays/", query: "compensation for a long delay" },
      new Tracer(),
    );
    if (!result.ok) throw result.error;
    expect(result.evidence.citation?.title).toBe("Flight delays | UK Civil Aviation Authority");
    expect((result.evidence.data as { excerpts: string[] }).excerpts.join(" ")).toContain("more than three hours");
  });
});
