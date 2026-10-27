import { describe, expect, it, vi } from "vitest";
import { createFetchOfficialPageTool, findOfficialSourcesTool, isAllowedUrl, relevantExcerpts } from "../src/tools/benefits.js";
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

  it("selects passages that match the query", () => {
    const text = `${"filler ".repeat(200)} Guests are charged a fee per visit. ${"filler ".repeat(200)}`;
    expect(relevantExcerpts(text, "guest fee")[0]).toContain("Guests are charged a fee");
  });
});
