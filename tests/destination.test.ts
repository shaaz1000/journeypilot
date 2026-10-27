import { describe, expect, it } from "vitest";
import { buildCatalog } from "../src/review/evidence.js";
import { createCityTransportTool, createCurrencyTool, createLocalTimeTool, createThingsToDoTool } from "../src/tools/destination.js";
import { ToolGateway } from "../src/tools/gateway.js";
import { Tracer } from "../src/trace/tracer.js";
import { destinationFetch } from "./helpers.js";

const gateway = new ToolGateway(
  [createCurrencyTool(destinationFetch), createLocalTimeTool(destinationFetch, () => new Date("2026-11-02T14:30:00Z")), createThingsToDoTool(destinationFetch), createCityTransportTool(destinationFetch)],
  { destination: ["convert_currency", "get_local_time", "find_things_to_do", "get_airport_to_city"] },
);
const call = async (tool: string, args: unknown) => {
  const result = await gateway.invoke("destination", tool, args, new Tracer());
  if (!result.ok) throw result.error;
  return result.evidence;
};

describe("destination tools", () => {
  it("converts at the ECB reference rate and names the source", async () => {
    const e = await call("convert_currency", { amount: 250, from: "gbp", to: "INR" });
    expect(e.data).toMatchObject({ amount: 250, from: "GBP", to: "INR", rate: 126.78, converted: 31695, source: "European Central Bank reference rate via Frankfurter" });
  });

  it("falls back to ExchangeRate-API for currencies the ECB does not publish", async () => {
    const e = await call("convert_currency", { amount: 100, from: "AED", to: "INR" });
    expect(e.data).toMatchObject({ converted: 2594, source: "Rates by ExchangeRate-API (exchangerate-api.com)" });
  });

  it("rejects malformed currency codes before any request", async () => {
    const result = await gateway.invoke("destination", "convert_currency", { amount: 10, from: "£", to: "INR" }, new Tracer());
    expect(!result.ok && result.error.kind).toBe("invalid_args");
  });

  it("gives the local time from the place's time zone", async () => {
    const e = await call("get_local_time", { place: "Doha" });
    expect(e.data).toMatchObject({ place: "Doha", timezone: "Asia/Qatar", utcOffset: "GMT+3", localTime: "17:30" });
  });

  it("reads Wikivoyage listings without map coordinates and cites the guide", async () => {
    const e = await call("find_things_to_do", { place: "Doha" });
    const item = (e.data as { sections: { items: { name: string; description: string }[] }[] }).sections[0]!.items[0]!;
    expect(item.name).toBe("Museum of Islamic Art");
    expect(item.description).not.toContain("25.29");
    expect(e.citation).toMatchObject({ url: "https://en.wikivoyage.org/wiki/Doha", title: "Doha travel guide (Wikivoyage)" });
  });

  it("finds airport-to-city transport in the Get in section", async () => {
    const e = await call("get_airport_to_city", { city: "Doha" });
    expect(JSON.stringify(e.data)).toContain("Red Line runs from Hamad International Airport");
  });

  it("renders conversions, times and places from the data, never from model text", async () => {
    const evidence = [await call("convert_currency", { amount: 250, from: "GBP", to: "INR" }), await call("get_local_time", { place: "Doha" }), await call("find_things_to_do", { place: "Doha" })];
    const catalog = buildCatalog([{ agent: "destination", status: "ok", summary: "", evidence, errors: [] }]);
    expect(catalog.map((c) => c.ref)).toEqual(["X1", "X2", "P1", "S1"]);
    expect(catalog[0]!.line).toContain("**250 GBP = 31,695 INR**");
    expect(catalog[1]!.line).toContain("**Local time in Doha, Qatar: 17:30**");
    expect(catalog[2]!.line).toBe("**Museum of Islamic Art**: Museum of Islamic Art, on the Corniche. One of the finest collections of Islamic art in the world.");
  });
});
