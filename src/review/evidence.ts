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

function collectNumbers(value: unknown, into: Set<number>): Set<number> {
  if (typeof value === "number") into.add(Math.round(value * 100) / 100);
  else if (typeof value === "string") for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) into.add(Number(m[0]));
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, into));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, into));
  return into;
}

export function moneyAmounts(text: string): number[] {
  return [...text.matchAll(MONEY)].map((m) => {
    const whole = (m[1] ?? m[3] ?? "0").replace(/,/g, "");
    const cents = m[2] ?? m[4];
    return Number(cents ? `${whole}.${cents}` : whole);
  });
}

/**
 * Deterministic grounding check of the final answer against recorded tool output.
 * Every price and link must trace back to evidence; benefit answers need a fetched official page.
 */
export function reviewAnswer(answer: string, results: SpecialistResult[], citations: Citation[], now = Date.now()): ReviewResult {
  const findings: string[] = [];
  const evidence = results.flatMap((r) => r.evidence);
  const numbers = collectNumbers(evidence.map((e) => e.data), new Set());
  const evidenceText = JSON.stringify(evidence.map((e) => e.data)) + JSON.stringify(citations);

  for (const amount of moneyAmounts(answer)) {
    if (!numbers.has(amount)) findings.push(`price ${amount} does not appear in any tool result`);
  }
  for (const url of answer.match(URL) ?? []) {
    const clean = url.replace(/[.,;:]+$/, "");
    if (!evidenceText.includes(clean)) findings.push(`link ${clean} does not appear in any tool result`);
  }
  if (evidence.some((e) => e.dataSource === "demo_fixture") && !/demo/i.test(answer)) {
    findings.push("demo hotel data is not labelled as demo");
  }
  const benefits = results.find((r) => r.agent === "benefits");
  if (benefits && benefits.status !== "failed" && !evidence.some((e) => e.dataSource === "official_page")) {
    findings.push("benefit answer has no fetched official page behind it");
  }
  for (const c of citations) {
    if (now - Date.parse(c.retrievedAt) > MAX_SOURCE_AGE_MS) findings.push(`source ${c.url} is older than 24 hours`);
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
