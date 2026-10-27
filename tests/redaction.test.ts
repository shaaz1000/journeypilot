import { mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { redact, redactString } from "../src/trace/redact.js";
import { JsonlFileSink, pruneOldLogs, Tracer } from "../src/trace/tracer.js";

describe("redaction", () => {
  it.each([
    ["API key", "key nvapi-abcDEF1234567890xyz here", "nvapi-abc"],
    ["bearer token", "Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["email", "mail me at jane.doe@example.com", "jane.doe@example.com"],
    ["card number", "card 4111 1111 1111 1111 please", "4111 1111 1111 1111"],
    ["phone number", "call +44 7700 900123", "7700 900123"],
    ["passport-like ID", "passport GB12345678", "GB12345678"],
  ])("masks %s", (_label, input, leaked) => {
    expect(redactString(input)).not.toContain(leaked);
  });

  it("masks configured secret values exactly", () => {
    expect(redactString("value=supersecretvalue", { secrets: ["supersecretvalue"] })).toBe("value=[REDACTED_SECRET]");
  });

  it("drops sensitive keys but keeps token counts and travel data", () => {
    const out = redact({ apiKey: "x", "x-api-key": "y", client_secret: "z", usage: { promptTokens: 12 }, flight: "VY7643", date: "2026-12-10", price: 364 });
    expect(out).toEqual({ apiKey: "[REDACTED]", "x-api-key": "[REDACTED]", client_secret: "[REDACTED]", usage: { promptTokens: 12 }, flight: "VY7643", date: "2026-12-10", price: 364 });
  });
});

describe("tracer", () => {
  it("redacts before truncating previews so a cut secret cannot leak", () => {
    const secret = "nvapi-0123456789abcdefghij";
    const tracer = new Tracer([], { secrets: [secret] });
    const value = "x".repeat(290) + secret;
    const preview = (tracer.payload(value) as { preview: string }).preview;
    expect(preview).not.toContain("nvapi-0123");
  });

  it("writes raw payloads only when enabled", () => {
    expect(new Tracer([], { rawPayloads: true }).payload({ a: 1 })).toEqual({ a: 1 });
    expect(new Tracer([]).payload({ a: 1 })).toEqual({ preview: '{"a":1}', chars: 7 });
  });

  it("correlates events and redacts them before they reach a sink", () => {
    const dir = mkdtempSync(join(tmpdir(), "jp-trace-"));
    const tracer = new Tracer([new JsonlFileSink(dir)], { secrets: ["topsecretvalue"] });
    const root = tracer.emit("request", { message: "my email is a@b.com and key topsecretvalue" });
    tracer.emit("final", { status: "answered" }, { parentSpanId: root });
    const file = readFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
    const lines = file.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.traceId)).size).toBe(1);
    expect(lines[1].parentSpanId).toBe(root);
    expect(file).not.toContain("a@b.com");
    expect(file).not.toContain("topsecretvalue");
  });

  it("does not throw when the log sink fails", () => {
    const sink = new JsonlFileSink(mkdtempSync(join(tmpdir(), "jp-trace-")));
    (sink as unknown as { dir: string }).dir = "/nonexistent/dir/for/test";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => new Tracer([sink]).emit("request", { message: "hi" })).not.toThrow();
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("prunes trace files older than the retention period", () => {
    const dir = mkdtempSync(join(tmpdir(), "jp-trace-"));
    writeFileSync(join(dir, "old.jsonl"), "{}\n");
    writeFileSync(join(dir, "new.jsonl"), "{}\n");
    const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(join(dir, "old.jsonl"), tenDaysAgo, tenDaysAgo);
    expect(pruneOldLogs(dir, 7)).toEqual(["old.jsonl"]);
    expect(existsSync(join(dir, "new.jsonl"))).toBe(true);
  });
});
