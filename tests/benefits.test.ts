import { describe, expect, it, vi } from "vitest";
import { createFetchOfficialPageTool, findOfficialSourcesTool, isAllowedUrl } from "../src/tools/benefits.js";
import { htmlToPassages, normaliseSpace, rankPassages } from "../src/tools/pageText.js";
import type { Embedder } from "../src/llm/embeddings.js";
import { ToolGateway } from "../src/tools/gateway.js";
import { Tracer } from "../src/trace/tracer.js";
import { AMEX_PAGE, pageResponse } from "./helpers.js";

describe("official source allowlist", () => {
  it.each([
    ["https://www.prioritypass.com/en-GB/conditions-of-use", true],
    ["https://americanexpress.com/uk/", true],
    ["http://www.prioritypass.com/", false],
    ["https://prioritypass.com.evil.example/", false],
    ["https://evilprioritypass.com/", false],
    ["https://user:pass@www.prioritypass.com/", false],
    ["https://www.prioritypass.com:8443/", false],
    ["https://169.254.169.254/latest/meta-data", false],
    ["not a url", false],
  ])("%s -> %s", (url, allowed) => {
    expect(isAllowedUrl(url)).toBe(allowed);
  });
});

function gatewayWith(fetchImpl: typeof fetch) {
  return new ToolGateway([findOfficialSourcesTool, createFetchOfficialPageTool(fetchImpl, 1000)], { flight: [], hotel: [], benefits: ["find_official_sources", "fetch_official_page"] });
}

describe("benefits tools", () => {
  it("ranks registry sources by the programme named in the question", async () => {
    const result = await gatewayWith(fetch).invoke("benefits", "find_official_sources", { query: "amex platinum lounge guest" }, new Tracer());
    if (!result.ok) throw result.error;
    expect((result.evidence.data as { sources: { url: string }[] }).sources[0]?.url).toContain("americanexpress.com");
  });

  it("refuses a non-allowlisted URL before any network request", async () => {
    const fetchImpl = vi.fn();
    const result = await gatewayWith(fetchImpl as unknown as typeof fetch).invoke("benefits", "fetch_official_page", { url: "https://example.com/", query: "lounge" }, new Tracer());
    expect(!result.ok && result.error.kind).toBe("invalid_args");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops at a redirect that leaves the allowlist", async () => {
    const fetchImpl = vi.fn(async () => pageResponse("", 302, { location: "https://attacker.example/page" }));
    const result = await gatewayWith(fetchImpl as unknown as typeof fetch).invoke("benefits", "fetch_official_page", { url: "https://www.prioritypass.com/x", query: "lounge" }, new Tracer());
    expect(!result.ok && result.error.message).toMatch(/redirect left the allowlist/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns cited, relevant excerpts with a retrieval time", async () => {
    const result = await gatewayWith(async () => pageResponse(AMEX_PAGE)).invoke("benefits", "fetch_official_page", { url: "https://www.americanexpress.com/en-gb/credit-cards/platinum-card/", query: "guest fee" }, new Tracer());
    if (!result.ok) throw result.error;
    expect(result.evidence.dataSource).toBe("official_page");
    expect(result.evidence.citation).toMatchObject({ title: "Platinum Card | AMEX UK", url: "https://www.americanexpress.com/en-gb/credit-cards/platinum-card/" });
    expect(Date.parse(result.evidence.citation!.retrievedAt)).not.toBeNaN();
    expect((result.evidence.data as { excerpts: string[] }).excerpts.join(" ")).toContain("GBP 24 per guest");
  });

  it("treats a 404 as a non-retryable provider error", async () => {
    const fetchImpl = vi.fn(async () => pageResponse("gone", 404));
    const result = await gatewayWith(fetchImpl as unknown as typeof fetch).invoke("benefits", "fetch_official_page", { url: "https://www.prioritypass.com/x", query: "lounge" }, new Tracer());
    expect(!result.ok && result.error.kind).toBe("provider");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

});

describe("page text", () => {
  const html = `<html><head><title>Lounge &amp; guest rules</title><style>.x{}</style></head><body>
    <nav><a>Home</a><a>Help</a></nav>
    <script>alert("ignored")</script>
    <h2>Guests</h2>
    <p>Cardmembers may bring one guest into participating lounges at no charge.</p>
    <ul><li>Additional guests are charged &pound;24 per person, per visit.</li><li>Children under two travel free in most lounges listed here.</li></ul>
    <p>Lounge opening hours vary by airport and may change at short notice.</p>
  </body></html>`;

  it("parses blocks into passages, skips scripts and styles, and decodes entities", () => {
    const { title, passages } = htmlToPassages(html);
    expect(title).toBe("Lounge & guest rules");
    expect(passages.join(" ")).not.toContain("alert");
    expect(passages).toContain("Additional guests are charged £24 per person, per visit.");
  });

  it("collapses whitespace without changing words", () => {
    expect(normaliseSpace("  a\n\t b   c ")).toBe("a b c");
  });

  it("ranks passages by embedding similarity", async () => {
    const { passages } = htmlToPassages(html);
    // A stand-in embedder: the query and the fee passage share a direction, everything else is orthogonal.
    const embedder: Embedder = {
      model: "fake",
      async embed(texts) {
        return texts.map((t) => (t.includes("cost") || t.includes("charged") ? [1, 0] : [0, 1]));
      },
    };
    const { excerpts, method } = await rankPassages(passages, "how much does an extra guest cost", embedder, 1);
    expect(method).toBe("embeddings");
    expect(excerpts).toEqual(["Additional guests are charged £24 per person, per visit."]);
  });

  it("falls back to shared words when embeddings fail", async () => {
    const failing: Embedder = { model: "down", embed: async () => { throw new Error("503"); } };
    const { excerpts, method } = await rankPassages(htmlToPassages(html).passages, "lounge opening hours", failing, 1);
    expect(method).toBe("word_overlap");
    expect(excerpts[0]).toContain("opening hours");
  });
});
