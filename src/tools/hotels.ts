import { z } from "zod";
import { defineTool } from "./types.js";

/**
 * Demo inventory. No keyless hotel provider was available (see PLAN.md), so these rows are
 * illustrative only and every result is marked `demo_fixture`. They must never be presented as live rates.
 */
const DEMO_HOTELS = [
  { id: "lon-1", city: "london", name: "Bridgeview Hotel Heathrow", area: "Heathrow T5", nightlyRate: 142, currency: "GBP", breakfastIncluded: true, cancellation: "Free cancellation until 48 hours before arrival" },
  { id: "lon-2", city: "london", name: "Southbank Quarter Rooms", area: "Waterloo", nightlyRate: 189, currency: "GBP", breakfastIncluded: false, cancellation: "Non-refundable" },
  { id: "lon-3", city: "london", name: "Kingsway Residence", area: "Holborn", nightlyRate: 236, currency: "GBP", breakfastIncluded: true, cancellation: "Free cancellation until 24 hours before arrival" },
  { id: "nyc-1", city: "new york", name: "Hudson Line Hotel", area: "Midtown West", nightlyRate: 249, currency: "USD", breakfastIncluded: false, cancellation: "Free cancellation until 72 hours before arrival" },
  { id: "nyc-2", city: "new york", name: "Jamaica Bay Airport Inn", area: "JFK Airport", nightlyRate: 168, currency: "USD", breakfastIncluded: true, cancellation: "Non-refundable" },
  { id: "sin-1", city: "singapore", name: "Marina Transit Suites", area: "Changi Airport", nightlyRate: 210, currency: "SGD", breakfastIncluded: true, cancellation: "Free cancellation until 48 hours before arrival" },
  { id: "dxb-1", city: "dubai", name: "Creekside Stopover Hotel", area: "Deira", nightlyRate: 520, currency: "AED", breakfastIncluded: true, cancellation: "Free cancellation until 24 hours before arrival" },
];

const isoDate = z.iso.date();

const SearchHotelsInput = z
  .object({
    city: z.string().min(2).max(60).describe("City name, e.g. London"),
    checkIn: isoDate.describe("Check-in date, YYYY-MM-DD"),
    checkOut: isoDate.describe("Check-out date, YYYY-MM-DD"),
    guests: z.number().int().min(1).max(8).default(1),
    maxNightlyRate: z.number().positive().optional().describe("Optional nightly budget in local currency"),
  })
  .refine((v) => v.checkOut > v.checkIn, { message: "checkOut must be after checkIn", path: ["checkOut"] });

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
}

export const searchHotelsTool = defineTool({
  name: "search_hotels",
  description: "Search DEMO hotel inventory for a city and dates. Returns nightly rate and total stay cost separately. Results are demo data, not live availability.",
  input: SearchHotelsInput,
  source: "local",
  async execute({ city, checkIn, checkOut, guests, maxNightlyRate }) {
    const nights = nightsBetween(checkIn, checkOut);
    const hotels = DEMO_HOTELS.filter((h) => h.city === city.trim().toLowerCase())
      .filter((h) => maxNightlyRate === undefined || h.nightlyRate <= maxNightlyRate)
      .map(({ city: _city, ...h }) => ({ ...h, nights, totalStayCost: h.nightlyRate * nights }));
    return {
      dataSource: "demo_fixture",
      data: {
        notice: "DEMO DATA: illustrative hotels and rates, not live availability or bookable prices.",
        query: { city, checkIn, checkOut, guests, nights },
        resultsCount: hotels.length,
        hotels,
      },
    };
  },
});

export const calculateStayCostTool = defineTool({
  name: "calculate_stay_cost",
  description: "Compute the total stay cost from a nightly rate, number of nights and optional tax percentage.",
  input: z.object({
    nightlyRate: z.number().positive(),
    nights: z.number().int().min(1).max(60),
    taxPercent: z.number().min(0).max(50).default(0),
  }),
  source: "local",
  async execute({ nightlyRate, nights, taxPercent }) {
    const subtotal = nightlyRate * nights;
    const total = Math.round(subtotal * (1 + taxPercent / 100) * 100) / 100;
    return { dataSource: "computed", data: { nightlyRate, nights, taxPercent, subtotal, total } };
  },
});
