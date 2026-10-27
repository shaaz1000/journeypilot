import { afterEach, describe, expect, it } from "vitest";
import { condenseFlights, createFlightSearchTool, findFlightSearchTool } from "../src/tools/flights.js";
import { ToolGateway } from "../src/tools/gateway.js";
import { Tracer } from "../src/trace/tracer.js";
import { eventsOf, fakeKiwi, recordedKiwi } from "./helpers.js";

const permissions = { flight: ["search_flights"], hotel: [], benefits: [] };
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

async function setup(behaviour: Parameters<typeof fakeKiwi>[0] = "ok") {
  const kiwi = await fakeKiwi(behaviour);
  cleanup = kiwi.close;
  const gateway = new ToolGateway([createFlightSearchTool({ connection: kiwi.connection, timeoutMs: 2000 })], permissions);
  return { kiwi, gateway };
}

const args = { origin: "LHR", destination: "JFK", departureDate: "2026-12-10", cabinClass: "business", maxStops: 1 };

describe("Kiwi MCP integration", () => {
  it("discovers the flight search tool by schema, not by name", async () => {
    const { kiwi } = await setup();
    expect(kiwi.connection.tools.map((t) => t.name)).toEqual(["find-trips"]);
    expect(findFlightSearchTool(kiwi.connection.tools)?.name).toBe("find-trips");
  });

  it("maps validated arguments to the provider format and records an MCP tool event", async () => {
    const { kiwi, gateway } = await setup();
    const tracer = new Tracer();
    const result = await gateway.invoke("flight", "search_flights", args, tracer);
    expect(result.ok).toBe(true);
    expect(kiwi.received[0]).toMatchObject({ flyFrom: "LHR", flyTo: "JFK", departureDate: "10/12/2026", cabinClass: "C", max_sector_stopovers: 1, currency: "GBP" });
    expect(eventsOf(tracer.events, "tool")[0]).toMatchObject({ source: "mcp", server: "kiwi", status: "ok", dataSource: "live" });
  });

  it("returns only fields the provider supplied", async () => {
    const { gateway } = await setup();
    const result = await gateway.invoke("flight", "search_flights", args, new Tracer());
    if (!result.ok) throw result.error;
    const data = result.evidence.data as ReturnType<typeof condenseFlights>;
    const first = recordedKiwi.itineraries[0];
    expect(data.itineraries[0]).toMatchObject({ price: first.price, bookingUrl: first.bookingUrl, stops: first.outbound.stops });
    expect(data.itineraries[0]?.inbound).toBeUndefined();
  });

  it("reports provider error results as tool errors", async () => {
    const { gateway } = await setup("error");
    const result = await gateway.invoke("flight", "search_flights", args, new Tracer());
    expect(!result.ok && result.error.kind).toBe("provider");
  });

  it("reports non-JSON provider content as malformed output", async () => {
    const { gateway } = await setup("non_json");
    const result = await gateway.invoke("flight", "search_flights", args, new Tracer());
    expect(!result.ok && result.error.kind).toBe("malformed_output");
  });

  it("opens a fresh session after the old one expires, so the retry succeeds", async () => {
    const { kiwi, gateway } = await setup();
    await kiwi.expireSession();
    const tracer = new Tracer();
    const result = await gateway.invoke("flight", "search_flights", args, tracer);
    expect(result.ok).toBe(true);
    expect(eventsOf(tracer.events, "tool")[0]).toMatchObject({ status: "ok", attempts: 2 });
    expect(kiwi.connection.reconnects).toBe(1);
  });

  it("rejects an unexpected result shape", () => {
    expect(() => condenseFlights({ currency: "GBP", itineraries: [{ price: "cheap" }] })).toThrow(/unexpected result shape/);
  });

  it("rejects past departure dates before calling the server", async () => {
    const { kiwi, gateway } = await setup();
    const result = await gateway.invoke("flight", "search_flights", { ...args, departureDate: "2020-01-01" }, new Tracer());
    expect(!result.ok && result.error.kind).toBe("invalid_args");
    expect(kiwi.received).toHaveLength(0);
  });

  it("reports the provider as unavailable when there is no connection", async () => {
    const gateway = new ToolGateway([createFlightSearchTool({ connection: null, timeoutMs: 100, unavailableReason: "could not connect" })], permissions);
    const result = await gateway.invoke("flight", "search_flights", args, new Tracer());
    expect(!result.ok && result.error.message).toMatch(/unavailable: could not connect/);
  });
});
