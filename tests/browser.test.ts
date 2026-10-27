import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BlockedPageError, blockReason, parseEvaluateResult, PlaywrightPageReader, type RenderedPage } from "../src/mcp/browser.js";
import { McpConnection } from "../src/mcp/connection.js";
import { buildCatalog } from "../src/review/evidence.js";
import { createAirlineBaggageTool, findAirlinePage } from "../src/tools/baggage.js";
import { ToolGateway } from "../src/tools/gateway.js";
import { createPageFetchTool } from "../src/tools/officialPages.js";
import { Tracer } from "../src/trace/tracer.js";
import { FakeBrowser, pageResponse } from "./helpers.js";

const LONG_TEXT = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: Checked baggage allowance is 23 kg per bag on most fares, with one cabin bag of up to 7 kg.`).join("\n");

/** A real MCP server over an in-memory transport that mimics Playwright MCP's three browser tools. */
async function fakePlaywright(pages: Record<string, RenderedPage>, tools = ["browser_navigate", "browser_wait_for", "browser_evaluate"]) {
  const server = new McpServer({ name: "fake-playwright", version: "1.0.0" });
  let current = "";
  const navigated: string[] = [];
  if (tools.includes("browser_navigate")) server.registerTool("browser_navigate", { inputSchema: { url: z.string() } }, async ({ url }) => {
    current = url;
    navigated.push(url);
    return { content: [{ type: "text", text: `### Ran Playwright code\nawait page.goto('${url}');` }] };
  });
  if (tools.includes("browser_wait_for")) server.registerTool("browser_wait_for", { inputSchema: { time: z.number() } }, async () => ({ content: [{ type: "text", text: "### Result\nWaited" }] }));
  if (tools.includes("browser_evaluate")) server.registerTool("browser_evaluate", { inputSchema: { function: z.string() } }, async () => ({
    content: [{ type: "text", text: `### Result\n${JSON.stringify(pages[current] ?? { url: "chrome-error://chromewebdata/", title: "", text: "" })}\n### Ran Playwright code\nawait page.evaluate(...)` }],
  }));
  const open = async () => {
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    return McpConnection.open("playwright", () => client, 5000);
  };
  return { reader: new PlaywrightPageReader({ timeoutMs: 5000, open, checkHost: async () => undefined }), navigated };
}

describe("network guard", () => {
  it("recognises internal addresses", async () => {
    const { isInternalAddress } = await import("../src/mcp/netguard.js");
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(isInternalAddress(a)).toBe(true);
    for (const a of ["8.8.8.8", "151.101.3.42", "2a04:4e42::81"]) expect(isInternalAddress(a)).toBe(false);
  });

  it("refuses a public-looking name that resolves to an internal address, before the browser loads it", async () => {
    const { assertPublicHost } = await import("../src/mcp/netguard.js");
    const rebinding = (async () => [{ address: "169.254.169.254", family: 4 }]) as never;
    await expect(assertPublicHost("https://www.akasaair.com/baggage", rebinding)).rejects.toThrow(/internal address/);
    const { reader, navigated } = await fakePlaywright({});
    const guarded = new PlaywrightPageReader({ timeoutMs: 5000, open: (reader as unknown as { options: { open: () => Promise<McpConnection> } }).options.open, checkHost: (url) => assertPublicHost(url, rebinding) });
    await expect(guarded.read("https://www.akasaair.com/baggage", new AbortController().signal)).rejects.toBeInstanceOf(BlockedPageError);
    expect(navigated).toEqual([]);
  });
});

describe("Playwright page reader", () => {
  it("parses the JSON under the Result section", () => {
    expect(parseEvaluateResult('### Result\n{"url":"https://a.example/","title":"A","text":"hi"}\n### Ran Playwright code\nx')).toEqual({ url: "https://a.example/", title: "A", text: "hi" });
    expect(() => parseEvaluateResult("no result here")).toThrow(/no result section/);
  });

  it("recognises block, error and empty pages, but not long pages that mention restrictions", () => {
    expect(blockReason({ url: "https://x.example/", title: "Access Denied", text: "Access Denied. You don't have permission to access this server." })).toContain("access denied");
    expect(blockReason({ url: "chrome-error://chromewebdata/", title: "", text: "" })).toBe("the page could not be reached");
    expect(blockReason({ url: "https://x.example/", title: "Baggage", text: `Restricted items are listed below.\n${LONG_TEXT}` })).toBeNull();
  });

  it("navigates, waits and reads the page through the MCP server", async () => {
    const { reader, navigated } = await fakePlaywright({ "https://www.akasaair.com/baggage": { url: "https://www.akasaair.com/baggage", title: "Baggage", text: LONG_TEXT } });
    const page = await reader.read("https://www.akasaair.com/baggage", new AbortController().signal);
    expect(page.title).toBe("Baggage");
    expect(navigated).toEqual(["https://www.akasaair.com/baggage"]);
    await reader.close();
  });

  it("raises a block error when the site refuses automated access", async () => {
    const { reader } = await fakePlaywright({ "https://www.emirates.com/x": { url: "https://www.emirates.com/error/accessrestricted.html", title: "Emirates", text: "We're Sorry. The page you're trying to access is restricted." } });
    await expect(reader.read("https://www.emirates.com/x", new AbortController().signal)).rejects.toBeInstanceOf(BlockedPageError);
  });

  it("refuses to run when the server lacks the tools it needs", async () => {
    const { reader } = await fakePlaywright({}, ["browser_navigate"]);
    await expect(reader.read("https://www.akasaair.com/baggage", new AbortController().signal)).rejects.toThrow(/missing tools: browser_wait_for, browser_evaluate/);
  });
});

describe("airline baggage tool", () => {
  const gateway = (browser = new FakeBrowser()) => new ToolGateway([createAirlineBaggageTool(browser)], { flight: ["fetch_airline_baggage_policy"] });

  it("matches airline names exactly, ignoring a generic suffix", () => {
    expect(findAirlinePage("IndiGo Airlines")?.airline).toBe("IndiGo");
    expect(findAirlinePage("Air India Limited")?.airline).toBe("Air India");
    expect(findAirlinePage("Akasa Air")?.airline).toBe("Akasa Air");
    expect(findAirlinePage("Air India Express")).toBeUndefined();
  });

  it("reads the airline's page live and cites it", async () => {
    const result = await gateway().invoke("flight", "fetch_airline_baggage_policy", { airline: "Akasa Air" }, new Tracer());
    if (!result.ok) throw result.error;
    expect(result.evidence).toMatchObject({ source: "mcp", server: "playwright", citation: { url: "https://www.akasaair.com/baggage", title: "Akasa Air baggage information" } });
    expect((result.evidence.data as { excerpts: string[] }).excerpts.join(" ")).toContain("15 kg");
  });

  it("reports a refusing airline with its official link instead of guessing", async () => {
    const result = await gateway().invoke("flight", "fetch_airline_baggage_policy", { airline: "Emirates" }, new Tracer());
    if (!result.ok) throw result.error;
    expect(result.evidence.data).toMatchObject({ status: "blocked", airline: "Emirates" });
    expect(result.evidence.citation).toBeUndefined();
    const [entry] = buildCatalog([{ agent: "flight", status: "ok", summary: "", evidence: [result.evidence], errors: [] }]);
    expect(entry).toMatchObject({ ref: "U1", kind: "unavailable" });
    expect(entry!.line).toContain("Emirates does not allow automated reading of its baggage page");
    expect(entry!.line).toContain("(https://www.emirates.com/uk/english/before-you-fly/baggage/checked-baggage/)");
  });

  it("says when an airline is not in the registry", async () => {
    const result = await gateway().invoke("flight", "fetch_airline_baggage_policy", { airline: "Air India Express" }, new Tracer());
    expect(!result.ok && result.error.message).toContain('no official baggage page for "Air India Express"');
  });
});

describe("official page browser fallback", () => {
  const tool = (fetchImpl: typeof fetch, browser: FakeBrowser) =>
    new ToolGateway([createPageFetchTool({ name: "fetch_page", description: "test", allowedDomains: ["vikaspedia.in", "state.gov"], fetchImpl, browser })], { rights: ["fetch_page"] });
  const page = (url: string): RenderedPage => ({ url, title: "Rendered", text: LONG_TEXT });

  it("renders a page whose text needs JavaScript", async () => {
    const url = "https://en.vikaspedia.in/viewcontent/air";
    const browser = new FakeBrowser({ [url]: page(url) }, []);
    const result = await tool(async () => pageResponse("<html><body><div id=root></div><script>render()</script></body></html>"), browser).invoke("rights", "fetch_page", { url, query: "baggage" }, new Tracer());
    if (!result.ok) throw result.error;
    expect(result.evidence.data).toMatchObject({ fetchedWith: "browser", title: "Rendered" });
  });

  it("uses the browser when a plain request is refused, and reports a refusal by both", async () => {
    const url = "https://travel.state.gov/transit";
    const ok = await tool(async () => pageResponse("forbidden", 403), new FakeBrowser({ [url]: page(url) }, [])).invoke("rights", "fetch_page", { url, query: "transit" }, new Tracer());
    expect(ok.ok && ok.evidence.data).toMatchObject({ fetchedWith: "browser" });
    const refused = await tool(async () => pageResponse("forbidden", 403), new FakeBrowser({}, [url])).invoke("rights", "fetch_page", { url, query: "transit" }, new Tracer());
    expect(!refused.ok && refused.error.message).toContain("did not allow automated reading");
  });

  it("does not start the browser for an ordinary readable page", async () => {
    const browser = new FakeBrowser({}, []);
    const html = `<html><body>${Array.from({ length: 5 }, (_, i) => `<p>Passengers delayed by more than three hours are entitled to compensation, section ${i}.</p>`).join("")}</body></html>`;
    const result = await tool(async () => pageResponse(html), browser).invoke("rights", "fetch_page", { url: "https://en.vikaspedia.in/a", query: "delay" }, new Tracer());
    expect(result.ok && result.evidence.data).toMatchObject({ fetchedWith: "http" });
    expect(browser.visited).toEqual([]);
  });
});
