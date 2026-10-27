import type { Citation, SpecialistResult } from "../schemas.js";

/**
 * One result the answer can show, identified by a short reference (F1, H1, S1). Its display line is
 * rendered by code from the tool output, so prices, times and links in the answer always match the data.
 */
export interface CatalogEntry {
  ref: string;
  kind: "flight" | "hotel" | "place" | "fact" | "source" | "unavailable";
  line: string;
  facts: unknown;
  citation?: Citation;
}

interface Leg {
  route?: string;
  departure?: string;
  arrival?: string;
  flights?: string[];
}

interface Itinerary {
  price: number;
  currency: string;
  duration: string;
  stops: number;
  outbound?: Leg;
  inbound?: Leg;
  baggageIncluded?: { checkedBag?: number; cabinBag?: number } | string;
  bookingUrl: string;
}

interface Hotel {
  name: string;
  area: string;
  nightlyRate: number;
  totalStayCost: number;
  currency: string;
  nights: number;
  breakfastIncluded: boolean;
  cancellation: string;
}

const when = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Local airport times arrive without a zone; formatting them as UTC keeps the digits exactly as given. */
function formatLocal(iso: string | undefined): string {
  if (!iso) return "time not provided";
  const date = new Date(`${iso}Z`);
  return Number.isNaN(date.getTime()) ? iso : when.format(date).replace(",", "");
}

/**
 * Text that must never become a link or markup: square brackets (Markdown links) and angle brackets
 * (autolinks) are swapped for look-alike characters. Used for provider text and for everything the model writes.
 */
export const plainText = (s: string) => s.replaceAll("[", "(").replaceAll("]", ")").replaceAll("<", "‹").replaceAll(">", "›");
const markdownText = plainText;

/** A link target safe inside Markdown: http(s) only, with characters that could end the link percent-encoded. */
export function markdownUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.toString().replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("[", "%5B").replaceAll("]", "%5D").replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll(" ", "%20");
}

const link = (label: string, raw: string) => {
  const url = markdownUrl(raw);
  return url ? `[${markdownText(label)}](${url})` : markdownText(label);
};

function flightLine(it: Itinerary): string {
  const stops = it.stops === 0 ? "direct" : `${it.stops} stop${it.stops === 1 ? "" : "s"}`;
  const route = (it.outbound?.route ?? "").replaceAll(" > ", " to ");
  const bags = typeof it.baggageIncluded === "object" ? (it.baggageIncluded.checkedBag ? "checked bag included" : "no checked bag") : "baggage not provided";
  // Segment labels are "<airline> <flight number>"; dropping the last word leaves the airline.
  const airlines = [...new Set((it.outbound?.flights ?? []).map((f) => f.split(" ").slice(0, -1).join(" ")).filter(Boolean))].join(", ");
  return `**${it.price} ${it.currency}**: ${route}, ${stops}, ${it.duration}, departs ${formatLocal(it.outbound?.departure)}${airlines ? `, ${markdownText(airlines)}` : ""}, ${bags}. ${link("Book on Kiwi.com", it.bookingUrl)}`;
}

function hotelLine(h: Hotel): string {
  return `**${markdownText(h.name)}** (${markdownText(h.area)}, demo data): ${h.nightlyRate} ${h.currency} per night, ${h.totalStayCost} ${h.currency} in total for ${h.nights} night${h.nights === 1 ? "" : "s"}, breakfast ${h.breakfastIncluded ? "included" : "not included"}. ${markdownText(h.cancellation)}.`;
}

interface Conversion {
  amount: number;
  from: string;
  to: string;
  rate: number;
  converted: number;
  rateDate: string;
  source: string;
}

interface LocalTime {
  place: string;
  country?: string;
  timezone: string;
  utcOffset: string;
  localTime: string;
  localDate: string;
}

interface GuideSection {
  title: string;
  items: { name: string; description: string }[];
}

const number = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/** Facts are rendered by code from the tool output, so their figures cannot drift from the data. */
function factLine(tool: string, data: unknown): string | null {
  if (tool === "convert_currency") {
    const c = data as Conversion;
    return `**${number.format(c.amount)} ${c.from} = ${number.format(c.converted)} ${c.to}** at ${c.rate} (${markdownText(c.source)}, ${c.rateDate}).`;
  }
  if (tool === "plan_layover") {
    const p = data as { layoverHours: number; usableHoursInCity: number; oneWayTravelMinutes: number; travelTimeSource: string; verdict: string; assumptions: { arrivalProcessingMinutes: number; returnBeforeDepartureMinutes: number } };
    return `**About ${p.usableHoursInCity} hours usable in the city** out of a ${p.layoverHours} hour layover: ${markdownText(p.verdict)} Allows ${p.assumptions.arrivalProcessingMinutes} minutes to leave the airport, ${p.oneWayTravelMinutes} minutes each way (${p.travelTimeSource}), and being back ${p.assumptions.returnBeforeDepartureMinutes / 60} hours before departure.`;
  }
  if (tool === "get_local_time") {
    const t = data as LocalTime;
    return `**Local time in ${markdownText(t.place)}${t.country ? `, ${markdownText(t.country)}` : ""}: ${t.localTime}** on ${t.localDate} (${t.timezone}, ${t.utcOffset}).`;
  }
  return null;
}

/** Builds the numbered catalog of everything the tools returned that an answer may show. */
export function buildCatalog(results: SpecialistResult[]): CatalogEntry[] {
  const catalog: CatalogEntry[] = [];
  const counters: Record<string, number> = {};
  const next = (prefix: string) => `${prefix}${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`;
  for (const e of results.flatMap((r) => r.evidence)) {
    const data = e.data as { itineraries?: Itinerary[]; hotels?: Hotel[]; excerpts?: string[]; sections?: GuideSection[]; place?: string };
    if (e.tool === "search_flights" && Array.isArray(data.itineraries)) {
      for (const it of data.itineraries) catalog.push({ ref: next("F"), kind: "flight", line: flightLine(it), facts: it });
    } else if (e.tool === "search_hotels" && Array.isArray(data.hotels)) {
      for (const hotel of data.hotels) catalog.push({ ref: next("H"), kind: "hotel", line: hotelLine(hotel), facts: hotel });
    } else if (e.tool === "find_things_to_do" && Array.isArray(data.sections)) {
      for (const section of data.sections) {
        for (const item of section.items) {
          catalog.push({ ref: next("P"), kind: "place", line: `**${markdownText(item.name)}**: ${markdownText(item.description)}`, facts: { place: data.place, section: section.title, ...item } });
        }
      }
    } else {
      const line = factLine(e.tool, e.data);
      if (line) catalog.push({ ref: next("X"), kind: "fact", line, facts: e.data });
    }
    // Every cited page or guide is a source the answer can point to.
    if (e.citation) {
      catalog.push({
        ref: next("S"),
        kind: "source",
        line: link(e.citation.title, e.citation.url),
        facts: { title: e.citation.title, url: e.citation.url, excerpts: data.excerpts, sections: e.tool === "find_things_to_do" ? undefined : data.sections },
        citation: e.citation,
      });
    }
  }
  return catalog;
}

export interface Statement {
  id: string;
  text: string;
}

export interface Verdict {
  id: string;
  supported: boolean;
  reason: string;
}

const MAX_SOURCE_AGE_MS = 24 * 3_600_000;
const SOURCE_BACKED = new Set<string>(["benefits", "rights", "transit"]);

/** Checks that do not depend on wording: chosen references exist, sources are fresh, benefit answers have a page. */
export function structuralFindings(results: SpecialistResult[], catalog: CatalogEntry[], unknownRefs: string[], now = Date.now()): string[] {
  const findings = unknownRefs.map((ref) => `answer referred to ${ref}, which no tool returned`);
  // Agents whose answers are only as good as an official page must have fetched at least one.
  for (const r of results) {
    if (!SOURCE_BACKED.has(r.agent) || r.status === "failed" || r.status === "needs_input") continue;
    if (!r.evidence.some((e) => e.citation)) findings.push(`${r.agent} answer has no fetched official page behind it`);
  }
  for (const c of catalog) {
    if (!c.citation) continue;
    const retrieved = Date.parse(c.citation.retrievedAt);
    if (Number.isNaN(retrieved) || now - retrieved > MAX_SOURCE_AGE_MS) findings.push(`source ${c.citation.url} is stale or has no valid retrieval time`);
  }
  return findings;
}

/** Statements the judge did not explicitly support are treated as unsupported (fail closed). */
export function supportedIds(statements: Statement[], verdicts: Verdict[] | null): { kept: Set<string>; findings: string[] } {
  // An id with more than one verdict is ambiguous and counts as unsupported.
  const byId = new Map<string, Verdict>();
  for (const v of verdicts ?? []) byId.set(v.id, byId.has(v.id) ? { id: v.id, supported: false, reason: "conflicting verdicts for one statement" } : v);
  const kept = new Set<string>();
  const findings: string[] = [];
  for (const s of statements) {
    const verdict = byId.get(s.id);
    if (verdict?.supported) kept.add(s.id);
    else findings.push(`removed ${s.id} ("${s.text.slice(0, 120)}"): ${verdict ? verdict.reason : verdicts ? "no verdict returned" : "grounding check unavailable"}`);
  }
  return { kept, findings };
}
