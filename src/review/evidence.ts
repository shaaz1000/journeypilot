import type { Citation, SpecialistResult } from "../schemas.js";

/**
 * One result the answer can show, identified by a short reference (F1, H1, S1). Its display line is
 * rendered by code from the tool output, so prices, times and links in the answer always match the data.
 */
export interface CatalogEntry {
  ref: string;
  kind: "flight" | "hotel" | "source";
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

/** Builds the numbered catalog of everything the tools returned that an answer may show. */
export function buildCatalog(results: SpecialistResult[]): CatalogEntry[] {
  const catalog: CatalogEntry[] = [];
  let f = 0;
  let h = 0;
  let s = 0;
  for (const e of results.flatMap((r) => r.evidence)) {
    const data = e.data as { itineraries?: Itinerary[]; hotels?: Hotel[]; excerpts?: string[] };
    if (e.tool === "search_flights" && Array.isArray(data.itineraries)) {
      for (const it of data.itineraries) catalog.push({ ref: `F${++f}`, kind: "flight", line: flightLine(it), facts: it });
    } else if (e.tool === "search_hotels" && Array.isArray(data.hotels)) {
      for (const hotel of data.hotels) catalog.push({ ref: `H${++h}`, kind: "hotel", line: hotelLine(hotel), facts: hotel });
    } else if (e.tool === "fetch_official_page" && e.citation) {
      catalog.push({
        ref: `S${++s}`,
        kind: "source",
        line: link(e.citation.title, e.citation.url),
        facts: { title: e.citation.title, url: e.citation.url, excerpts: data.excerpts ?? [] },
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

/** Checks that do not depend on wording: chosen references exist, sources are fresh, benefit answers have a page. */
export function structuralFindings(results: SpecialistResult[], catalog: CatalogEntry[], unknownRefs: string[], now = Date.now()): string[] {
  const findings = unknownRefs.map((ref) => `answer referred to ${ref}, which no tool returned`);
  const benefits = results.find((r) => r.agent === "benefits");
  if (benefits && benefits.status !== "failed" && benefits.status !== "needs_input" && !catalog.some((c) => c.kind === "source")) {
    findings.push("benefit answer has no fetched official page behind it");
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
