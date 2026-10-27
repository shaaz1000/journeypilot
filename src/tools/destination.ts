import { z } from "zod";
import { findAll } from "domutils";
import type { ChildNode, Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import { normaliseSpace, visibleText } from "./pageText.js";
import { defineTool, ToolError, type ToolDefinition } from "./types.js";

/** Wikimedia asks API clients to identify themselves. */
const USER_AGENT = "JourneyPilot/0.1 (travel assistant demo)";

const LETTERS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
const currencyCode = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase())
  .refine((s) => [...s].every((c) => LETTERS.has(c)), "use a 3-letter ISO currency code such as GBP or INR");

async function getJson(fetchImpl: typeof fetch, url: string, signal: AbortSignal, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  } catch (error) {
    throw new ToolError(`${what} could not be reached: ${String(error)}`, "provider", true);
  }
  // 429 (rate limited) and 5xx are worth another attempt after the gateway's backoff.
  if (!response.ok) throw new ToolError(`${what} returned HTTP ${response.status}`, "provider", response.status >= 500 || response.status === 429);
  try {
    return await response.json();
  } catch {
    throw new ToolError(`${what} returned non-JSON content`, "malformed_output");
  }
}

const EcbRates = z.object({ date: z.string(), rates: z.record(z.string(), z.number()) });
const OpenRates = z.object({ result: z.literal("success"), time_last_update_utc: z.string(), rates: z.record(z.string(), z.number()) });

/**
 * Live exchange rates: the European Central Bank reference rate (via the free Frankfurter API) when the ECB
 * publishes both currencies, otherwise ExchangeRate-API's open endpoint, which covers 160+ currencies such as AED.
 */
export function createCurrencyTool(fetchImpl: typeof fetch = fetch): ToolDefinition {
  return defineTool({
    name: "convert_currency",
    description: "Convert an amount between currencies at today's live rate (European Central Bank reference rate where available, otherwise ExchangeRate-API).",
    input: z.object({ amount: z.number().positive().max(1e9), from: currencyCode, to: currencyCode }),
    source: "local",
    timeoutMs: 15_000,
    retries: 1,
    async execute({ amount, from, to }, { signal }) {
      if (from === to) return { dataSource: "live", data: { amount, from, to, rate: 1, converted: amount, rateDate: new Date().toISOString().slice(0, 10), source: "same currency" } };
      const result = (rate: number, rateDate: string, source: string) => ({
        dataSource: "live" as const,
        data: { amount, from, to, rate, converted: Math.round(amount * rate * 100) / 100, rateDate, source },
      });
      try {
        const ecb = EcbRates.safeParse(await getJson(fetchImpl, `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`, signal, "the ECB rate service"));
        const rate = ecb.success ? ecb.data.rates[to] : undefined;
        if (ecb.success && rate !== undefined) return result(rate, ecb.data.date, "European Central Bank reference rate via Frankfurter");
      } catch (error) {
        // A 404 means the ECB does not publish this currency; anything else is a real outage worth retrying.
        if (!(error instanceof ToolError) || !error.message.endsWith("HTTP 404")) throw error;
      }
      const open = OpenRates.safeParse(await getJson(fetchImpl, `https://open.er-api.com/v6/latest/${from}`, signal, "the exchange-rate service"));
      const rate = open.success ? open.data.rates[to] : undefined;
      if (!open.success || rate === undefined) throw new ToolError(`no exchange rate is published for ${from} to ${to}`, "provider");
      return result(rate, new Date(open.data.time_last_update_utc).toISOString().slice(0, 10), "Rates by ExchangeRate-API (exchangerate-api.com)");
    },
  });
}

interface Place {
  name: string;
  country?: string;
  timezone: string;
  latitude: number;
  longitude: number;
}

async function geocode(fetchImpl: typeof fetch, place: string, signal: AbortSignal): Promise<Place> {
  const raw = (await getJson(fetchImpl, `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(place)}`, signal, "the place lookup service")) as {
    results?: Place[];
  };
  const first = raw.results?.[0];
  if (!first?.timezone) throw new ToolError(`no place called "${place}" was found`, "provider");
  return first;
}

/** Current local time anywhere, from the place's IANA time zone (Open-Meteo geocoding) and the platform clock. */
export function createLocalTimeTool(fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): ToolDefinition {
  return defineTool({
    name: "get_local_time",
    description: "Current local date and time, time zone and UTC offset for a city or airport.",
    input: z.object({ place: z.string().min(2).max(80).describe("City or airport name, e.g. Doha") }),
    source: "local",
    timeoutMs: 15_000,
    retries: 1,
    async execute({ place }, { signal }) {
      const found = await geocode(fetchImpl, place, signal);
      const at = now();
      const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: found.timezone, ...options }).format(at);
      const offset = new Intl.DateTimeFormat("en-GB", { timeZone: found.timezone, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
      return {
        dataSource: "live",
        data: {
          place: found.name,
          country: found.country,
          timezone: found.timezone,
          utcOffset: offset,
          localTime: format({ hour: "2-digit", minute: "2-digit", hour12: false }),
          localDate: format({ weekday: "short", day: "numeric", month: "short", year: "numeric" }),
          checkedAt: at.toISOString(),
        },
      };
    },
  });
}

export interface WikivoyageSection {
  title: string;
  items: { name: string; description: string }[];
}

const hasClass = (el: Element, name: string) => (el.attribs.class ?? "").split(" ").includes(name);

/** Reads listings (name plus description) from the nodes of one Wikivoyage section. */
export function listingsFromNodes(nodes: ChildNode[], max: number): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const li of findAll((el) => el.name === "li", nodes)) {
    const nameEl = findAll((el) => hasClass(el, "listing-name") || el.name === "b", li.children)[0];
    const name = nameEl ? normaliseSpace(visibleText(nameEl)) : "";
    const description = normaliseSpace(visibleText(li));
    if (!name || description.length < 20) continue;
    out.push({ name, description: description.slice(0, 280) });
    if (out.length >= max) break;
  }
  return out;
}

/** Splits a rendered Wikivoyage page into its top-level sections by walking the level-2 headings in document order. */
export function sectionsFromPage(html: string): Map<string, ChildNode[]> {
  const document = parseDocument(html);
  const root = findAll((el) => hasClass(el, "mw-parser-output"), document.children)[0] ?? document;
  const sections = new Map<string, ChildNode[]>();
  let current: ChildNode[] | null = null;
  for (const node of root.children) {
    const el = node as Element;
    const heading = el.name === "h2" ? el : "children" in el ? findAll((c) => c.name === "h2", el.children ?? [])[0] : undefined;
    if (heading && (el.name === "h2" || hasClass(el, "mw-heading2") || hasClass(el, "mw-heading"))) {
      current = [];
      sections.set(normaliseSpace(visibleText(heading)), current);
      continue;
    }
    current?.push(node);
  }
  return sections;
}

async function wikivoyageSections(fetchImpl: typeof fetch, place: string, wanted: string[], signal: AbortSignal, max: number) {
  // One request per lookup: the whole rendered guide, split locally. Wikimedia rate-limits bursts of calls.
  const api = "https://en.wikivoyage.org/w/api.php?format=json&formatversion=2&redirects=1&action=parse&prop=text&disableeditsection=1";
  const page = (await getJson(fetchImpl, `${api}&page=${encodeURIComponent(place)}`, signal, "Wikivoyage")) as { parse?: { title: string; text: string } };
  if (!page.parse?.text) throw new ToolError(`Wikivoyage has no guide for "${place}"`, "provider");
  const title = page.parse.title;
  const all = sectionsFromPage(page.parse.text);
  const sections: WikivoyageSection[] = [];
  for (const name of wanted) {
    const nodes = all.get(name);
    if (!nodes) continue;
    // Listings first; narrative paragraphs fill the rest (in "Get in" they carry the airport-to-city detail).
    const items = listingsFromNodes(nodes, max);
    const paragraphs = nodes
      .flatMap((n) => findAll((el) => el.name === "p", [n]))
      .map((p) => normaliseSpace(visibleText(p)))
      .filter((t) => t.length > 40)
      .map((p) => ({ name, description: p.slice(0, 400) }));
    const combined = [...items, ...paragraphs].slice(0, max);
    if (combined.length) sections.push({ title: name, items: combined });
  }
  const url = `https://en.wikivoyage.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
  return { title, url, sections };
}

/** Sights and activities from the Wikivoyage travel guide for a city or country. */
export function createThingsToDoTool(fetchImpl: typeof fetch = fetch): ToolDefinition {
  return defineTool({
    name: "find_things_to_do",
    description: "Sights and things to do in a city or country, from the Wikivoyage travel guide's See and Do sections.",
    input: z.object({ place: z.string().min(2).max(80).describe("City or country, e.g. Tokyo") }),
    source: "local",
    timeoutMs: 20_000,
    retries: 1,
    async execute({ place }, { signal }) {
      const guide = await wikivoyageSections(fetchImpl, place, ["See", "Do"], signal, 6);
      if (guide.sections.length === 0) throw new ToolError(`the Wikivoyage guide for ${guide.title} has no See or Do listings`, "provider");
      const retrievedAt = new Date().toISOString();
      return {
        dataSource: "live",
        citation: { url: guide.url, title: `${guide.title} travel guide (Wikivoyage)`, retrievedAt },
        data: { place: guide.title, guide: "Wikivoyage", url: guide.url, retrievedAt, sections: guide.sections },
      };
    },
  });
}

/** How to get from the airport into the city, from the Wikivoyage guide's Get in and Get around sections. */
export function createCityTransportTool(fetchImpl: typeof fetch = fetch): ToolDefinition {
  return defineTool({
    name: "get_airport_to_city",
    description: "How to get between the airport and the city centre (train, metro, taxi, typical journey times), from the Wikivoyage guide.",
    input: z.object({ city: z.string().min(2).max(80).describe("City, e.g. Doha") }),
    source: "local",
    timeoutMs: 20_000,
    retries: 1,
    async execute({ city }, { signal }) {
      const guide = await wikivoyageSections(fetchImpl, city, ["Get in", "Get around"], signal, 4);
      if (guide.sections.length === 0) throw new ToolError(`the Wikivoyage guide for ${guide.title} has no Get in section`, "provider");
      const retrievedAt = new Date().toISOString();
      return {
        dataSource: "live",
        citation: { url: guide.url, title: `${guide.title} travel guide (Wikivoyage)`, retrievedAt },
        data: { city: guide.title, guide: "Wikivoyage", url: guide.url, retrievedAt, sections: guide.sections },
      };
    },
  });
}
