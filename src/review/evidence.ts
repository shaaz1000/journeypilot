import type { Citation, SpecialistResult } from "../schemas.js";

export interface ReviewResult {
  passed: boolean;
  findings: string[];
}

const CURRENCY = String.raw`(?:GBP|USD|EUR|SGD|AED|INR|JPY|CHF|AUD|CAD)`;
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;
const MONEY = new RegExp(String.raw`(?:[£$€]|\b${CURRENCY}\b)\s?${AMOUNT}|${AMOUNT}\s?(?:[£$€]|\b${CURRENCY}\b)`, "g");
const URL = /https?:\/\/[^\s)\]>"']+/g;
const MAX_SOURCE_AGE_MS = 24 * 3_600_000;

/** Provider fields that may ground a price. Echoed query arguments are deliberately not among them. */
const PRICE_FIELDS = new Set(["price", "nightlyRate", "totalStayCost"]);
const URL_FIELDS = new Set(["bookingUrl", "url"]);

const round = (n: number) => Math.round(n * 100) / 100;

function walk(value: unknown, visit: (key: string, inner: unknown) => void): void {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      visit(key, inner);
      walk(inner, visit);
    }
  }
}

/** Prices and links the tools themselves returned, excluding anything the model supplied as input. */
export function groundedFacts(results: SpecialistResult[], citations: Citation[]): { prices: Set<number>; urls: Set<string> } {
  const prices = new Set<number>();
  const urls = new Set(citations.map((c) => c.url));
  const evidence = results.flatMap((r) => r.evidence);
  for (const e of evidence) {
    if (e.dataSource === "computed") continue;
    if (e.dataSource === "official_page") {
      // Official page text is provider content; amounts quoted in it (guest fees, visit charges) are grounded.
      const excerpts = (e.data as { excerpts?: unknown }).excerpts;
      for (const text of Array.isArray(excerpts) ? excerpts : []) if (typeof text === "string") moneyAmounts(text).forEach((n) => prices.add(n));
      continue;
    }
    walk(e.data, (key, inner) => {
      if (PRICE_FIELDS.has(key) && typeof inner === "number") prices.add(round(inner));
      if (URL_FIELDS.has(key) && typeof inner === "string") urls.add(inner);
    });
  }
  // A computed total is grounded only when the rate it was computed from is itself grounded.
  for (const e of evidence) {
    const d = e.data as { nightlyRate?: number; subtotal?: number; total?: number };
    if (e.dataSource === "computed" && d.nightlyRate !== undefined && prices.has(round(d.nightlyRate))) {
      if (d.subtotal !== undefined) prices.add(round(d.subtotal));
      if (d.total !== undefined) prices.add(round(d.total));
    }
  }
  return { prices, urls };
}

export function moneyAmounts(text: string): number[] {
  return [...text.matchAll(MONEY)].map((m) => {
    const whole = (m[1] ?? m[3] ?? "0").replace(/,/g, "");
    const cents = m[2] ?? m[4];
    return Number(cents ? `${whole}.${cents}` : whole);
  });
}

/**
 * Deterministic grounding check of the model-written answer body against recorded tool output.
 * Run it before sources and limitations are appended, so code-added text cannot mask a failure.
 */
export function reviewAnswer(body: string, results: SpecialistResult[], citations: Citation[], now = Date.now()): ReviewResult {
  const findings: string[] = [];
  const evidence = results.flatMap((r) => r.evidence);
  const { prices, urls } = groundedFacts(results, citations);

  for (const amount of moneyAmounts(body)) {
    if (!prices.has(amount)) findings.push(`price ${amount} does not appear in any tool result`);
  }
  for (const url of body.match(URL) ?? []) {
    const clean = url.replace(/[.,;:]+$/, "");
    if (!urls.has(clean)) findings.push(`link ${clean} does not appear in any tool result`);
  }
  if (evidence.some((e) => e.dataSource === "demo_fixture") && !/demo/i.test(body)) {
    findings.push("demo hotel data is not labelled as demo");
  }
  const benefits = results.find((r) => r.agent === "benefits");
  if (benefits && benefits.status !== "failed" && !evidence.some((e) => e.dataSource === "official_page")) {
    findings.push("benefit answer has no fetched official page behind it");
  }
  for (const c of citations) {
    const retrieved = Date.parse(c.retrievedAt);
    if (Number.isNaN(retrieved) || now - retrieved > MAX_SOURCE_AGE_MS) findings.push(`source ${c.url} is stale or has no valid retrieval time`);
  }
  return { passed: findings.length === 0, findings };
}

/** Plain digest built only from tool output; used when the model-written answer fails review. */
export function evidenceDigest(results: SpecialistResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    for (const e of r.evidence) {
      const data = e.data as Record<string, unknown>;
      if (Array.isArray(data.itineraries)) {
        lines.push(`Flights (${e.server ?? e.tool}, live):`);
        for (const it of data.itineraries.slice(0, 3) as Record<string, unknown>[]) {
          lines.push(`- ${it.price} ${it.currency ?? ""}, ${it.duration ?? "duration not provided"}, ${it.stops ?? "?"} stop(s), ${it.route ?? ""} ${it.bookingUrl ?? ""}`.trim());
        }
      } else if (Array.isArray(data.hotels)) {
        lines.push("Hotels (demo data, not live rates):");
        for (const h of data.hotels.slice(0, 3) as Record<string, unknown>[]) {
          lines.push(`- ${h.name}: ${h.nightlyRate} ${h.currency} per night, ${h.totalStayCost} ${h.currency} total for ${h.nights} nights`);
        }
      } else if (e.citation) {
        lines.push(`Official source consulted: ${e.citation.title} (${e.citation.url})`);
      }
    }
  }
  return lines.length ? lines.join("\n") : "No verified results were returned.";
}
