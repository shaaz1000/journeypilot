import { z } from "zod";
import type { DiscoveredTool, McpConnection } from "../mcp/connection.js";
import { defineTool, ToolError, type ToolDefinition } from "./types.js";

const REQUIRED_PROVIDER_FIELDS = ["flyFrom", "flyTo", "departureDate"];

/** Picks the flight search tool by its input schema rather than by an assumed name. */
export function findFlightSearchTool(tools: DiscoveredTool[]): DiscoveredTool | undefined {
  return tools.find((tool) => REQUIRED_PROVIDER_FIELDS.every((field) => field in (tool.inputSchema.properties ?? {})));
}

const isoDate = z.iso.date();
const CABIN = { economy: "M", premium_economy: "W", business: "C", first: "F" } as const;

export const SearchFlightsInput = z
  .object({
    origin: z.string().min(2).max(100).describe("IATA code or city, e.g. LHR or London"),
    destination: z.string().min(2).max(100).describe("IATA code or city, e.g. JFK or New York"),
    departureDate: isoDate.describe("YYYY-MM-DD"),
    returnDate: isoDate.optional().describe("YYYY-MM-DD for a return trip; omit for one-way"),
    adults: z.number().int().min(1).max(9).default(1),
    cabinClass: z.enum(["economy", "premium_economy", "business", "first"]).optional(),
    maxStops: z.number().int().min(0).max(3).optional().describe("Maximum stopovers per direction"),
    currency: z.string().regex(/^[A-Z]{3}$/).default("GBP"),
    sort: z.enum(["price", "duration", "quality"]).default("price"),
  })
  .refine((v) => !v.returnDate || v.returnDate >= v.departureDate, { message: "returnDate must not be before departureDate", path: ["returnDate"] })
  .refine((v) => v.departureDate >= new Date().toISOString().slice(0, 10), { message: "departureDate is in the past", path: ["departureDate"] });

const Leg = z.object({
  route: z.array(z.string()),
  stops: z.number(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  segments: z.array(z.object({ carrierName: z.string().optional(), flightNumber: z.string().optional() })).default([]),
});

const ProviderResponse = z.object({
  query: z.string().optional(),
  passengers: z.object({ adults: z.number(), children: z.number(), infants: z.number() }).partial().optional(),
  currency: z.string(),
  error: z.unknown().optional(),
  resultsCount: z.number().optional(),
  itineraries: z.array(
    z.object({
      price: z.number(),
      priceFormatted: z.string().optional(),
      totalDurationSeconds: z.number(),
      bookingUrl: z.string().url(),
      baggage: z.object({ personalItem: z.number(), cabinBag: z.number(), checkedBag: z.number() }).partial().optional(),
      outbound: Leg,
      // One-way results carry inbound: null.
      inbound: Leg.nullish(),
    }),
  ),
});

const toProviderDate = (iso: string) => iso.split("-").reverse().join("/");

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function summariseLeg(leg: z.infer<typeof Leg>) {
  return {
    route: leg.route.join(" > "),
    stops: leg.stops,
    departure: leg.departureTime,
    arrival: leg.arrivalTime,
    flights: leg.segments.map((s) => [s.carrierName, s.flightNumber].filter(Boolean).join(" ")),
  };
}

/** Condenses the provider payload to the fields the agent compares; nothing is added that the provider did not return. */
export function condenseFlights(raw: unknown, limit = 5) {
  const parsed = ProviderResponse.safeParse(raw);
  if (!parsed.success) throw new ToolError("flight provider returned an unexpected result shape", "malformed_output");
  const { currency, itineraries, error, query, passengers } = parsed.data;
  if (error) throw new ToolError(`flight provider reported an error: ${JSON.stringify(error).slice(0, 200)}`, "provider");
  return {
    provider: "Kiwi.com",
    // The provider's own record of what was searched, so answers about passengers and dates can be checked.
    search: query,
    passengers,
    currency,
    resultsCount: itineraries.length,
    itineraries: itineraries.slice(0, limit).map((it) => ({
      price: it.price,
      currency,
      duration: formatDuration(it.totalDurationSeconds),
      stops: it.outbound.stops,
      route: it.outbound.route.join(" > "),
      outbound: summariseLeg(it.outbound),
      inbound: it.inbound ? summariseLeg(it.inbound) : undefined,
      baggageIncluded: it.baggage ?? "not provided",
      bookingUrl: it.bookingUrl,
    })),
  };
}

export interface FlightToolOptions {
  /** Returns the live MCP session, opening one if there is none; throws when the server cannot be reached. */
  connect: () => Promise<McpConnection>;
  serverName: string;
  timeoutMs: number;
}

export function createFlightSearchTool({ connect, serverName, timeoutMs }: FlightToolOptions): ToolDefinition {
  return defineTool({
    name: "search_flights",
    description: "Search live flights (Kiwi.com via MCP). Returns up to 5 itineraries with price, duration, stops, route, baggage and booking link.",
    input: SearchFlightsInput,
    source: "mcp",
    server: serverName,
    timeoutMs,
    // Connection drops to the public endpoint are common enough that one retry was not always sufficient.
    retries: 2,
    async execute(args, { signal }) {
      let connection: McpConnection;
      try {
        connection = await connect();
      } catch (error) {
        // Retryable: the gateway's next attempt tries to connect again.
        throw new ToolError(`flight provider unavailable: could not connect: ${error instanceof Error ? error.message : String(error)}`, "provider", true);
      }
      const providerTool = findFlightSearchTool(connection.tools);
      if (!providerTool) throw new ToolError("flight provider unavailable: no flight search tool discovered on the MCP server", "provider");
      const providerArgs: Record<string, unknown> = {
        flyFrom: args.origin,
        flyTo: args.destination,
        departureDate: toProviderDate(args.departureDate),
        adults: args.adults,
        currency: args.currency,
        sort: args.sort,
      };
      if (args.returnDate) providerArgs.returnDate = toProviderDate(args.returnDate);
      if (args.cabinClass) providerArgs.cabinClass = CABIN[args.cabinClass];
      if (args.maxStops !== undefined) providerArgs.max_sector_stopovers = args.maxStops;
      const raw = await connection.callJson(providerTool.name, providerArgs, signal, timeoutMs);
      return { dataSource: "live", data: condenseFlights(raw) };
    },
  });
}
