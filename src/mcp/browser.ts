import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolError } from "../tools/types.js";
import { McpConnection } from "./connection.js";

export interface RenderedPage {
  url: string;
  title: string;
  text: string;
}

export interface PageReader {
  /** Loads a page in a real browser and returns its visible text. Throws BlockedPageError when the site refuses automated access. */
  read(url: string, signal: AbortSignal): Promise<RenderedPage>;
  close(): Promise<void>;
}

/** The site served a block, challenge or error page instead of its content. */
export class BlockedPageError extends ToolError {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`${new URL(url).hostname} did not allow automated reading (${reason})`, "provider", false);
  }
}

const REQUIRED_TOOLS = ["browser_navigate", "browser_wait_for", "browser_evaluate"];

/** Fixed code run in the page: the final URL, title and visible text. The model never supplies code. */
const READ_PAGE = "() => ({ url: location.href, title: document.title, text: document.body ? document.body.innerText.slice(0, 60000) : '' })";

/** Phrases of block, challenge and error pages. Checked only against short pages, where they are the whole message. */
const BLOCK_SIGNS = [
  "access denied",
  "page you’re trying to access is restricted",
  "page you're trying to access is restricted",
  "you don't have permission to access",
  "this site can’t be reached",
  "this page isn’t working",
  "something went wrong",
  "experiencing high demand",
  "attention required",
  "are you a robot",
  "verify you are human",
  "page not found",
];
const MIN_CONTENT_CHARS = 1200;

export function blockReason(page: RenderedPage): string | null {
  if (page.url.startsWith("chrome-error://")) return "the page could not be reached";
  const head = `${page.title}\n${page.text.slice(0, 1500)}`.toLowerCase();
  if (page.text.length < MIN_CONTENT_CHARS) {
    const sign = BLOCK_SIGNS.find((s) => head.includes(s));
    return sign ? `the site showed "${sign}"` : "the page had almost no readable text";
  }
  return null;
}

/** Playwright's evaluate result arrives as Markdown sections; the value is the JSON under "### Result". */
export function parseEvaluateResult(text: string): unknown {
  const marker = "### Result";
  const start = text.indexOf(marker);
  if (start < 0) throw new ToolError("browser returned no result section", "malformed_output");
  const after = text.slice(start + marker.length);
  const end = after.indexOf("\n### ");
  const body = (end < 0 ? after : after.slice(0, end)).trim();
  try {
    return JSON.parse(body);
  } catch {
    throw new ToolError("browser result was not JSON", "malformed_output");
  }
}

/**
 * Reads pages through Microsoft's Playwright MCP server: a headless Chromium driven over stdio.
 * One browser, one page at a time; started on first use and restarted after a failed connect.
 */
export class PlaywrightPageReader implements PageReader {
  private connection: McpConnection | null = null;
  private connecting: Promise<McpConnection> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: { timeoutMs: number; open?: () => Promise<McpConnection> } = { timeoutMs: 45_000 },
  ) {}

  static defaultOpen(timeoutMs: number): () => Promise<McpConnection> {
    const cli = fileURLToPath(new URL("../../node_modules/@playwright/mcp/cli.js", import.meta.url));
    return () =>
      McpConnection.open(
        "playwright",
        () => new StdioClientTransport({ command: process.execPath, args: [cli, "--headless", "--isolated", "--browser", "chromium", "--snapshot-mode", "none"], stderr: "ignore" }),
        timeoutMs,
      );
  }

  private async connect(): Promise<McpConnection> {
    if (this.connection) return this.connection;
    this.connecting ??= (this.options.open ?? PlaywrightPageReader.defaultOpen(this.options.timeoutMs))()
      .then((opened) => {
        const missing = REQUIRED_TOOLS.filter((name) => !opened.tools.some((t) => t.name === name));
        if (missing.length) throw new ToolError(`browser server is missing tools: ${missing.join(", ")}`, "provider");
        this.connection = opened;
        return opened;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  read(url: string, signal: AbortSignal): Promise<RenderedPage> {
    // Serialised: the server drives a single browser tab.
    const run = this.queue.then(async () => {
      let browser: McpConnection;
      try {
        browser = await this.connect();
      } catch (error) {
        throw error instanceof ToolError ? error : new ToolError(`browser could not start: ${String(error)}`, "provider", true);
      }
      const t = this.options.timeoutMs;
      await browser.callText("browser_navigate", { url }, signal, t);
      await browser.callText("browser_wait_for", { time: 2 }, signal, t);
      const page = parseEvaluateResult(await browser.callText("browser_evaluate", { function: READ_PAGE }, signal, t)) as RenderedPage;
      const reason = blockReason(page);
      if (reason) throw new BlockedPageError(url, reason);
      return page;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = null;
  }
}
