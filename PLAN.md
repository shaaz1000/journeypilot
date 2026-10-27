# JourneyPilot: reviewed implementation plan

JourneyPilot is a bounded multi-agent assistant for travel and airport experiences. It helps travellers
compare flights and hotels and understand lounge access and travel-card benefits. Answers must rest on
evidence, and every agent step must be observable.

This file is the original JourneyPilot plan after a review against the Collinson take-home brief and
the implementation prompt. Section 1 lists the discrepancies found and how each was resolved. The
sections after it are the plan as it is being built.

## 1. Review: discrepancies and resolutions

| # | Discrepancy | Resolution |
|---|-------------|------------|
| 1 | The plan says to confirm the Nemotron model at setup without naming one. | Checked on 2026-10-27 against `integrate.api.nvidia.com/v1/models` with a free-tier key. `nvidia/nemotron-3.5-lightning-30b-a3b` is callable and supports function calling (about 2 s per call). `nvidia/nemotron-3-super-120b-a12b` and `nvidia/nemotron-nano-3-30b-a3b` are listed in the catalog but return 404 for this account. `nvidia/nemotron-3-ultra-550b-a55b` is callable but slower. The default is Lightning, configurable through `NVIDIA_MODEL`. Nothing falls back silently to another provider. |
| 2 | The plan asks for a classifier that returns a "validated structured result" but does not say how. | `response_format: json_schema` on this endpoint produced degenerate output (a field filled with repeated `?` until the token limit). Structured outputs therefore use a forced function call (`tool_choice` naming one function) and zod validation. Reasoning is turned off with `chat_template_kwargs.enable_thinking=false`, because thinking tokens used up the budget before the answer. |
| 3 | The plan lists an Evidence Reviewer as an LLM agent with tools. The brief cares about sub-agents that do domain work, and an LLM grading another LLM's grounding is weaker than a code check. | The Evidence Reviewer is a deterministic component of the orchestrator. It checks that every price and link in the final answer appears in a recorded tool result, that benefit answers cite fetched official pages, and that demo data is labelled. It is code, not a sub-agent. |
| 4 | "Journey planner" is listed as a user journey, but no agent owns it. | Itinerary planning is the orchestrator's synthesis step over specialist results. There is no fourth sub-agent. A planning request still delegates only to the specialists whose data it needs. |
| 5 | The `mixed` intent is used for two things: several travel domains, and travel plus unrelated content. | The classifier returns a set of travel intents plus a separate `unsupported_portion`. A request that spans several travel domains delegates to several agents. Unrelated content is declined in the answer, and no agent ever sees it. |
| 6 | Preferred MCP is a flight and hotel provider with real results. | The Kiwi.com public MCP server (`https://mcp.kiwi.com`, streamable HTTP, no key) returns live flight itineraries. No keyless, free hotel MCP was found: the Booking.com connector needs OAuth and partner access, and an Airbnb scraping server was excluded on terms grounds. Hotel search therefore uses a local demo fixture marked `dataSource: "demo_fixture"`, and the answer must say so. |
| 7 | The fallback was a web-search MCP for lounge and card advice. | The build environment did not allow running a downloaded stdio MCP server (`uvx mcp-server-fetch`), and keyless search APIs are unreliable. The Benefits agent instead has two in-process tools: a curated registry of official programme and issuer pages, and a fetch tool that code restricts to an allowlist of official domains. This enforces "prefer official sources" in code rather than in the prompt. |
| 8 | The prompt says to log user-submitted messages and tool arguments. The plan says to redact personal information. | Messages and arguments are logged after redaction: secrets, emails, phone numbers, card numbers and passport-like IDs are masked. Raw payload logging is off by default (`LOG_RAW_PAYLOADS`), and secrets are masked even when it is on. Trace files older than `LOG_RETENTION_DAYS` are pruned at startup. If a log write fails, a warning goes to stderr; the policy decision is unaffected. |
| 9 | The plan mixes automated tests and evaluations. | They are split. `npm test` runs offline vitest suites with a scripted LLM and an in-memory MCP server, so they are deterministic and suitable for CI. `npm run eval` runs live cases against Nemotron and Kiwi and grades each case from its trace (agents, tools, policy, grounding) as well as its final text. |
| 10 | The plan says to fail closed or ask a clarifying question, without saying when to do which. | A malformed classification fails closed (refusal, no agents). A travel classification with confidence below 0.6 returns a short clarifying question. A request with no travel intent is declined. |
| 11 | The brief asks how and when work is delegated. The plan's orchestrator has an "agent dispatcher" but no stated decision rule. | The orchestrator LLM produces the classification and a travel-only task description. Code then maps intents to agents (`flight_search` → Flight, `hotel_search` → Hotel, `lounge_benefits` → Benefits) and dispatches only those agents, in parallel. The model cannot dispatch an agent that the validated intents do not justify. |
| 12 | Agent framework is not stated. The brief mentions Mastra as optional. | No framework. A small tool loop over the OpenAI-compatible NVIDIA API keeps permission checks, validation, timeouts and telemetry in one gateway that tests can inspect directly. The README discusses moving to Mastra. |
| 13 | The brief asks for a short README. The plan's definition of done implies a long one. | The README stays short and links to this file for the full reasoning. |
| 14 | Prompt injection in a retrieved page cannot be staged on real official websites. | An offline test serves an injected page through the fetch tool and asserts that scope and output are unchanged. The live eval set also covers injection placed directly in the user's message. |

## 2. Product scope

| Journey | What it does | Evidence and limits |
|---------|--------------|---------------------|
| Flight finder | Searches and compares routes, fares, duration, stops, baggage and booking links. | Live data from the Kiwi.com MCP. Only fields the provider returns are shown. Prices are in the provider's currency. |
| Hotel finder | Compares hotels, nightly rate and total stay cost, breakfast and cancellation terms. | Demo fixture, always labelled as demo. Nightly rate and total stay cost are kept separate. |
| Lounge and travel-card advisor | Explains Priority Pass, lounge access, card-linked benefits, visit limits, guest fees and eligibility. | Only official programme and issuer pages, fetched live, cited with URL and retrieval time. |
| Journey planner | Combines specialist results into one recommendation. | Done by the orchestrator. Confirmed facts are kept apart from assumptions. |

## 3. Architecture

| Component | Responsibility | Tool access (enforced in code) |
|-----------|----------------|--------------------------------|
| Orchestrator | Classifies and plans with one structured LLM call, applies the policy gate, dispatches specialists, runs the evidence review, writes the final answer. | `classify_request` (structured output only). No specialist tools. |
| Flight Agent | Flight search and comparison. | `search_flights`, backed by the Kiwi MCP tool discovered at startup. |
| Hotel Agent | Hotel comparison and stay cost. | `search_hotels` (demo fixture; returns nightly rate and total stay cost). |
| Benefits Agent | Lounge access, Priority Pass, card benefits. | `find_official_sources`, `fetch_official_page` (domain allowlist). |
| Evidence Reviewer | Grounding, citation, demo labelling and freshness checks. | None. Deterministic code. |

Every tool call goes through `ToolGateway.invoke(agent, tool, args)`. It refuses tools the agent is not
permitted to use, validates arguments with zod before execution, applies a timeout and a bounded retry
for transient errors, and records a trace event.

## 4. Request workflow

1. Receive the request. Create request and trace IDs. Log the redacted message.
2. Classify. One forced function call returns intents, confidence, the travel-only task and any unsupported portion. The result is validated with zod.
3. Policy gate (deterministic). A malformed result is refused; low confidence gets a clarifying question; a request with no travel intent is declined. In each case no agent or tool runs.
4. Delegate. Code maps intents to agents. The selected specialists run in parallel, each receiving only the travel task.
5. Tools. Each agent runs a bounded tool loop (at most 4 steps) through the gateway.
6. Review and combine. The orchestrator writes the answer from the specialists' structured results. The Evidence Reviewer checks it against recorded tool output. If the check fails, a deterministic answer built from the evidence replaces it.
7. Finish. A final trace event records status, sources, guardrail actions and review findings.

## 5. Domain restrictions and prompt injection

In scope: flights, hotels, itineraries, travel budgets, airport facilities, lounges, Priority Pass, and
card benefits related to travel or lounge access. Everything else is declined. Fetched pages and tool
results are wrapped as untrusted data, and the agent prompts tell the model never to follow
instructions found inside them. Scope is decided once, before any agent runs, so retrieved content
cannot widen it.

## 6. Observability

Traces are JSONL in `logs/<date>.jsonl`. Each event has `traceId`, `requestId`, `spanId`, `parentSpanId`
and timing. Event kinds: `request`, `classification`, `policy`, `delegation`, `agent`, `tool`, `model`,
`review`, `final`. Model events carry the provider, model ID, latency and token counts when the provider
returns them.

## 7. Tests and evaluation

Offline tests (`npm test`): policy gate, redaction, gateway permissions and argument validation, timeout
and retry, Kiwi discovery and mapping against an in-memory MCP server, classifier failure modes,
orchestrator delegation, refusal before any agent runs, mixed requests, tool failure, page injection,
and the evidence reviewer.

Live evals (`npm run eval`): flight comparison, hotel request, lounge eligibility, unrelated request,
mixed request, direct injection, and a multi-domain trip. Each case is graded from the trace (expected
and forbidden agents, permitted and required tools, policy decision, MCP usage, grounding) and from the
final text. Results are written to `evals/results/`.

## 8. Build sequence

1. Skeleton, configuration, schemas, policy gate, this plan.
2. NVIDIA client, tracer, redaction.
3. Tool gateway, specialist agents, orchestrator.
4. Kiwi MCP integration.
5. Benefits tools and the evidence reviewer.
6. Offline tests.
7. Live evals.
8. README.

## 9. Delivery rules

Commit at each coherent stage. Commit messages are plain and factual, with no Co-authored-by trailers,
no decorative symbols and no triple equals signs. Run the tests before finishing and report the
results, known limitations and commit hashes.

## 10. Changes after the reviewed plan

The plan above was the starting point. These changes came from testing the running system, and each is in
its own commit.

| Change | Why |
|--------|-----|
| Structured answers and a grounding judge replaced the pattern-based evidence reviewer | The pattern checker misread "1 560 AED" and links in backticks. Now the model refers to results by ID, code renders prices and links from tool data, and a second model call must explicitly support every sentence, or it is removed. |
| Missing details become questions before any agent runs | "find me a bombay delhi ticket" reached the Flight agent and came back as a failure. Intent-specific slots (route and date, hotel city and check-in, passport and layover city) are now asked for in plain language. |
| Conversation memory, with the model deciding `continue` or `new_request` | Follow-ups such as "in INR, business class" lost their context. |
| Destination, Passenger Rights and Transit agents | Requested after the first version: currency conversion, local time, things to see, delay and cancellation law, and layover visas. Each has its own tools and its own source allowlist. |
| Second MCP integration: Playwright headless browser | Most airline baggage pages refuse plain requests or need JavaScript. The browser identifies itself honestly; airlines that refuse automated access are reported with their official link. |
| Web chat page, token-protected admin trace console, Langfuse Cloud export over OpenTelemetry | Requested for testing and for team access to end-to-end traces. Langfuse's legacy ingestion API rejected events, so the export uses its OTLP endpoint. |
| Model thinking enabled and logged | Requested; it costs latency (median about 55 s with thinking, against 10 s without). |
| No regex for interpreting content | Requested. Routing was already model-based. Page parsing (htmlparser2), passage ranking (Nemotron embeddings), answer checking (the judge) and Markdown rendering (markdown-it) replaced the remaining patterns. Only log redaction keeps patterns, for fixed secret and personal-data formats. |
