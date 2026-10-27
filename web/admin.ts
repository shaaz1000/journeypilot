import { el, formatDuration, richText, safeLink } from "./dom.js";

interface TraceSummary {
  traceId: string;
  requestId: string;
  conversationId?: string;
  startedAt: string;
  message: string;
  status: string;
  policy: string;
  agents: string[];
  toolCalls: number;
  toolErrors: number;
  reviewReplaced: boolean;
  durationMs: number | null;
}

interface TraceEvent {
  kind: string;
  spanId: string;
  parentSpanId?: string;
  timestamp: string;
  durationMs?: number;
  [field: string]: unknown;
}

const TOKEN_KEY = "journeypilot-admin-token";
const gate = document.querySelector<HTMLFormElement>("#gate")!;
const console_ = document.querySelector<HTMLElement>("#console")!;
const list = document.querySelector<HTMLElement>("#requests")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
const search = document.querySelector<HTMLInputElement>("#search")!;
const live = document.querySelector<HTMLInputElement>("#live")!;
const runtime = document.querySelector<HTMLElement>("#runtime")!;

let token = readToken();
let summaries: TraceSummary[] = [];
let selected: string | null = null;
let timer: number | undefined;

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) {
    showGate("That admin token wasn't accepted. Paste the token printed when the server started.");
    throw new Error("unauthorised");
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

function showGate(message = ""): void {
  console_.hidden = true;
  gate.hidden = false;
  gate.querySelector<HTMLElement>(".gate__error")!.textContent = message;
}

gate.addEventListener("submit", (event) => {
  event.preventDefault();
  token = gate.querySelector<HTMLInputElement>("#token")!.value.trim();
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* session storage unavailable: token lives for this page only */
  }
  void start();
});

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const chip = (status: string) => el("span", { class: `chip chip--${status}` }, status.replaceAll("_", " "));

function renderList(): void {
  const q = search.value.trim().toLowerCase();
  const rows = summaries.filter((s) => !q || s.message.toLowerCase().includes(q) || s.requestId.includes(q) || s.traceId.includes(q) || (s.conversationId ?? "").includes(q));
  list.replaceChildren(
    ...(rows.length
      ? rows.map((s) => {
          const row = el(
            "button",
            { class: `request${s.traceId === selected ? " request--active" : ""}`, type: "button" },
            el("span", { class: "request__top" }, chip(s.status), el("time", {}, time(s.startedAt)), el("span", { class: "muted" }, formatDuration(s.durationMs))),
            el("span", { class: "request__message" }, s.message || "(empty message)"),
            el(
              "span",
              { class: "request__facts" },
              s.agents.length ? s.agents.join(" + ") : s.policy || "no agents",
              s.toolCalls ? `, ${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}` : "",
              s.toolErrors ? el("span", { class: "warn" }, `, ${s.toolErrors} failed`) : "",
              s.reviewReplaced ? el("span", { class: "warn" }, ", answer replaced") : "",
              s.conversationId ? `. Conversation ${s.conversationId.slice(0, 8)}` : "",
            ),
          );
          row.addEventListener("click", () => void select(s.traceId));
          return row;
        })
      : [el("p", { class: "empty" }, q ? "No requests match that search." : "No requests logged yet. Ask something on the chat page and it will appear here.")]),
  );
}

async function refresh(): Promise<void> {
  summaries = await api<TraceSummary[]>("/api/admin/traces?limit=200");
  renderList();
}

interface Node_ {
  event: TraceEvent;
  start: number;
  end: number;
  children: Node_[];
}

/** Builds the span tree. Agent events are written when the agent finishes, so order by start time, not log order. */
function buildTree(events: TraceEvent[]): { roots: Node_[]; t0: number; t1: number } {
  const nodes = events.map((event) => {
    const end = Date.parse(event.timestamp);
    return { event, end, start: end - (typeof event.durationMs === "number" ? event.durationMs : 0), children: [] as Node_[] };
  });
  const bySpan = new Map(nodes.map((n) => [n.event.spanId, n]));
  const roots: Node_[] = [];
  for (const node of nodes) {
    const parent = node.event.parentSpanId ? bySpan.get(node.event.parentSpanId) : undefined;
    if (parent && parent !== node && parent.event.kind !== "request") parent.children.push(node);
    else if (node.event.kind !== "request") roots.push(node);
  }
  const sort = (list: Node_[]) => {
    list.sort((a, b) => a.start - b.start);
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  const t0 = Math.min(...nodes.map((n) => n.start));
  const t1 = Math.max(...nodes.map((n) => n.end));
  return { roots, t0, t1 };
}

function title(e: TraceEvent): string {
  switch (e.kind) {
    case "classification": {
      const use = e.conversationUse === "continue" ? ", continues the conversation" : Number(e.historyTurns) > 0 ? ", new request" : "";
      return `Classified as ${(e.intents as string[] | undefined)?.join(", ") || "no travel intent"}${use}`;
    }
    case "policy": return `Policy: ${e.outcome}`;
    case "delegation": return `Delegated to ${e.agent} agent`;
    case "agent": return e.status === "reminded" ? `${e.agent} agent reminded to use its tools` : `${e.agent} agent finished: ${e.status}`;
    case "model": {
      const calls = (e.toolCalls as { name: string }[] | undefined) ?? [];
      return `Model call for ${e.purpose}${calls.length ? `, chose ${calls.map((c) => c.name).join(", ")}` : ""}`;
    }
    case "tool": return `${e.tool} by ${e.agent} agent${e.server ? ` via MCP server ${e.server}` : ""}`;
    case "review": return e.replaced ? "Answer failed review and was replaced" : "Answer passed review";
    case "final": return `Finished: ${e.status}`;
    default: return e.kind;
  }
}

const HIDDEN_FIELDS = new Set(["kind", "traceId", "requestId", "spanId", "parentSpanId", "timestamp"]);

function fieldBlock(label: string, value: unknown): HTMLElement {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return el("div", { class: "field" }, el("h4", {}, label), el("pre", {}, text));
}

function eventDetail(e: TraceEvent): HTMLElement {
  const box = el("div", { class: "event__body" });
  if (e.kind === "model" && Array.isArray(e.prompt)) {
    box.append(el("h4", {}, "Prompt sent to the model"));
    for (const m of e.prompt as { role: string; content: unknown; tool_calls?: unknown }[]) {
      box.append(el("div", { class: `message message--${m.role}` }, el("span", { class: "message__role" }, m.role), el("pre", {}, typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? m.tool_calls, null, 2))));
    }
  }
  if (e.kind === "model" && e.reasoning) box.append(el("div", { class: "field field--thinking" }, el("h4", {}, "Model thinking"), el("pre", {}, String(e.reasoning))));
  for (const [key, value] of Object.entries(e)) {
    if (HIDDEN_FIELDS.has(key) || value === undefined || value === null) continue;
    if (e.kind === "model" && (key === "prompt" || key === "reasoning")) continue;
    box.append(fieldBlock(key, value));
  }
  return box;
}

function renderNode(node: Node_, depth: number, t0: number, span: number): HTMLElement[] {
  const e = node.event;
  const failed = typeof e.status === "string" && !["ok", "reminded", "answered", "declined", "clarify"].includes(e.status) && e.kind !== "final";
  const left = ((node.start - t0) / span) * 100;
  const width = Math.max(((node.end - node.start) / span) * 100, 0.6);
  // Geometry is set through the CSSOM: the page's CSP does not allow inline style attributes.
  const fill = el("span", { class: `bar__fill bar__fill--${e.kind}` });
  fill.style.marginLeft = `${left}%`;
  fill.style.width = `${width}%`;
  const body = eventDetail(e);
  body.hidden = true;
  const head = el(
    "button",
    { class: "event__head", type: "button", "aria-expanded": "false" },
    el("span", { class: `kind kind--${e.kind}` }, e.kind),
    el("span", { class: "event__title" }, title(e)),
    el("span", { class: "event__time" }, formatDuration(e.durationMs)),
    el("span", { class: "bar" }, fill),
  );
  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    head.setAttribute("aria-expanded", String(!body.hidden));
  });
  const row = el("li", { class: `event${failed ? " event--failed" : ""}` }, head, body);
  row.style.setProperty("--depth", String(depth));
  return [row, ...node.children.flatMap((child) => renderNode(child, depth + 1, t0, span))];
}

async function select(traceId: string): Promise<void> {
  selected = traceId;
  renderList();
  detail.replaceChildren(el("p", { class: "muted" }, "Loading trace"));
  const events = await api<TraceEvent[]>(`/api/admin/traces/${traceId}`);
  const request = events.find((e) => e.kind === "request");
  const final = events.find((e) => e.kind === "final");
  const { roots, t0, t1 } = buildTree(events);
  const span = Math.max(t1 - t0, 1);

  detail.replaceChildren(
    el(
      "header",
      { class: "detail__head" },
      el("p", { class: "detail__message" }, String(request?.message ?? "")),
      el(
        "dl",
        { class: "facts" },
        el("div", {}, el("dt", {}, "Status"), el("dd", {}, chip(String(final?.status ?? "in_progress")))),
        el("div", {}, el("dt", {}, "Total time"), el("dd", {}, formatDuration(final?.durationMs))),
        el("div", {}, el("dt", {}, "Request"), el("dd", {}, events[0]?.requestId as string)),
        el("div", {}, el("dt", {}, "Trace"), el("dd", {}, traceId)),
        request?.conversationId ? el("div", {}, el("dt", {}, "Conversation"), el("dd", {}, String(request.conversationId))) : "",
      ),
    ),
    Array.isArray(request?.history) && request.history.length
      ? el("section", { class: "final" }, el("h3", {}, "Conversation context sent with this message"), ...(request.history as { role: string; text: string }[]).map((t) => el("p", { class: "muted" }, `${t.role === "user" ? "Traveller" : "JourneyPilot"}: ${t.text.slice(0, 300)}`)))
      : "",
    final?.answer ? el("section", { class: "final" }, el("h3", {}, "Response sent to the traveller"), richText(String(final.answer))) : "",
    el("h3", { class: "flow__title" }, "End-to-end flow"),
    el("p", { class: "muted flow__hint" }, "Select a step to see its prompt, arguments, results and errors."),
    el("ol", { class: "flow" }, ...roots.flatMap((n) => renderNode(n, 0, t0, span))),
  );
}

function schedule(): void {
  window.clearInterval(timer);
  if (live.checked) timer = window.setInterval(() => void refresh().catch(() => undefined), 4000);
}

async function start(): Promise<void> {
  if (!token) return showGate();
  try {
    const status = await api<{ model: string; mcp: { server: string; connected: boolean; error?: string }; cloud: { enabled: boolean; url: string } }>("/api/admin/status");
    runtime.replaceChildren(
      `${status.model}. MCP ${status.mcp.server} ${status.mcp.connected ? "connected" : `unavailable: ${status.mcp.error ?? ""}`}. `,
      status.cloud.enabled ? safeLink(status.cloud.url, "Open cloud traces in Langfuse") : "Cloud tracing is off.",
    );
    gate.hidden = true;
    console_.hidden = false;
    await refresh();
    if (!selected && summaries[0]) await select(summaries[0].traceId);
    schedule();
  } catch {
    /* gate already shown on 401 */
  }
}

search.addEventListener("input", renderList);
live.addEventListener("change", schedule);
void start();
