import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TOOL_PERMISSIONS } from "../src/agents/definitions.js";
import { ToolGateway } from "../src/tools/gateway.js";
import { searchHotelsTool } from "../src/tools/hotels.js";
import { defineTool, ToolError } from "../src/tools/types.js";
import { Tracer } from "../src/trace/tracer.js";
import { eventsOf } from "./helpers.js";

function probeTool(name: string, run: () => Promise<unknown>, opts: { timeoutMs?: number; retries?: number } = {}) {
  const execute = vi.fn(async () => ({ dataSource: "live" as const, data: await run() }));
  return { execute, tool: defineTool({ name, description: name, input: z.object({ q: z.string() }), source: "local", ...opts, execute }) };
}

describe("tool permissions", () => {
  it("gives each agent a disjoint set of tools", () => {
    const all = Object.values(TOOL_PERMISSIONS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("only exposes permitted tools to an agent's model", () => {
    const gateway = new ToolGateway([searchHotelsTool, probeTool("search_flights", async () => ({})).tool], { flight: ["search_flights"], hotel: ["search_hotels"], benefits: [] });
    expect(gateway.specsFor("flight").map((s) => s.name)).toEqual(["search_flights"]);
    expect(gateway.specsFor("benefits")).toEqual([]);
  });

  it("refuses a tool outside the agent's permissions without executing it", async () => {
    const { tool, execute } = probeTool("search_flights", async () => ({}));
    const gateway = new ToolGateway([tool, searchHotelsTool], { flight: ["search_flights"], hotel: ["search_hotels"], benefits: [] });
    const tracer = new Tracer();
    const result = await gateway.invoke("hotel", "search_flights", { q: "x" }, tracer);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("not_permitted");
    expect(execute).not.toHaveBeenCalled();
    expect(eventsOf(tracer.events, "tool")[0]).toMatchObject({ agent: "hotel", tool: "search_flights", status: "not_permitted" });
  });

  it("rejects unknown tools", async () => {
    const gateway = new ToolGateway([searchHotelsTool], { flight: [], hotel: ["search_hotels"], benefits: [] });
    const result = await gateway.invoke("hotel", "delete_everything", {}, new Tracer());
    expect(!result.ok && result.error.kind).toBe("unknown_tool");
  });

  it("fails at startup when a permission names an unregistered tool", () => {
    expect(() => new ToolGateway([], { flight: ["search_flights"], hotel: [], benefits: [] })).toThrow(/unregistered/);
  });
});

describe("argument validation", () => {
  const gateway = new ToolGateway([searchHotelsTool], { flight: [], hotel: ["search_hotels"], benefits: [] });

  it.each([
    ["non-ISO date", { city: "London", checkIn: "10/12/2026", checkOut: "2026-12-12" }],
    ["check-out before check-in", { city: "London", checkIn: "2026-12-12", checkOut: "2026-12-10" }],
    ["missing city", { checkIn: "2026-12-10", checkOut: "2026-12-12" }],
  ])("rejects %s before execution", async (_label, args) => {
    const tracer = new Tracer();
    const result = await gateway.invoke("hotel", "search_hotels", args, tracer);
    expect(!result.ok && result.error.kind).toBe("invalid_args");
    expect(eventsOf(tracer.events, "tool")[0]?.status).toBe("invalid_args");
  });

  it("separates nightly rate from total stay cost and labels demo data", async () => {
    const result = await gateway.invoke("hotel", "search_hotels", { city: "London", checkIn: "2026-12-10", checkOut: "2026-12-13" }, new Tracer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.dataSource).toBe("demo_fixture");
    const hotel = (result.evidence.data as { hotels: { nightlyRate: number; totalStayCost: number; nights: number }[] }).hotels[0]!;
    expect(hotel.nights).toBe(3);
    expect(hotel.totalStayCost).toBe(hotel.nightlyRate * 3);
  });
});

describe("timeouts and retries", () => {
  it("times out, retries once, and records attempts and duration", async () => {
    const { tool, execute } = probeTool("slow", () => new Promise((resolve) => setTimeout(resolve, 500)), { timeoutMs: 20, retries: 1 });
    const gateway = new ToolGateway([tool], { flight: ["slow"], hotel: [], benefits: [] });
    const tracer = new Tracer();
    const result = await gateway.invoke("flight", "slow", { q: "x" }, tracer);
    expect(!result.ok && result.error.kind).toBe("timeout");
    expect(execute).toHaveBeenCalledTimes(2);
    const event = eventsOf(tracer.events, "tool")[0]!;
    expect(event).toMatchObject({ status: "timeout", attempts: 2 });
    expect(event.durationMs).toBeGreaterThanOrEqual(40);
  });

  it("recovers when a retry succeeds", async () => {
    let calls = 0;
    const { tool } = probeTool("flaky", async () => {
      if (calls++ === 0) throw new ToolError("503", "provider", true);
      return { ok: true };
    }, { retries: 1 });
    const gateway = new ToolGateway([tool], { flight: ["flaky"], hotel: [], benefits: [] });
    const tracer = new Tracer();
    expect((await gateway.invoke("flight", "flaky", { q: "x" }, tracer)).ok).toBe(true);
    expect(eventsOf(tracer.events, "tool")[0]).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("does not retry non-retryable errors", async () => {
    const { tool, execute } = probeTool("bad", async () => { throw new ToolError("400", "provider", false); }, { retries: 2 });
    const gateway = new ToolGateway([tool], { flight: ["bad"], hotel: [], benefits: [] });
    await gateway.invoke("flight", "bad", { q: "x" }, new Tracer());
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
