# JourneyPilot

A small multi-agent assistant for travel and airport experiences, written in TypeScript on Node.js. An
orchestrator classifies each request, applies a scope policy, and delegates to specialist agents for
flights, hotels, and lounge and travel-card benefits. Every agent step is traced, and the final answer is
checked against what the tools actually returned.

The model is NVIDIA Nemotron on NVIDIA's free hosted endpoint. Flight data is live, from the Kiwi.com
public MCP server.

Full reasoning, including the review of the brief against the original plan, is in [PLAN.md](PLAN.md).

## Run it

Requires Node.js 21.7 or later (the code uses `process.loadEnvFile`).

```bash
npm install
cp .env.example .env          # then set NVIDIA_API_KEY
npm start                     # chat at http://127.0.0.1:3000, admin console at /admin
npm run ask -- --trace "Compare flights from London to New York on 2026-12-10"
npm run ask                   # interactive mode
npm test                      # offline tests, no network or key needed
npm run eval                  # live evaluation suite (needs the key and network)
npm run eval -- --case lounge-eligibility --repeat 3
```

### Model configuration

1. Create a free account at [build.nvidia.com](https://build.nvidia.com) and generate an API key (it starts with `nvapi-`).
2. Put it in `.env` as `NVIDIA_API_KEY`.
3. Optional: set `NVIDIA_MODEL`. The default is `nvidia/nemotron-3.5-lightning-30b-a3b`.

Which models your key can call varies by account. On 2026-10-27, with a free-tier key:

| Model | Result |
|-------|--------|
| `nvidia/nemotron-3.5-lightning-30b-a3b` | Works with function calling, about 1 to 3 s per call. Default. |
| `nvidia/nemotron-3-ultra-550b-a55b` | Works, but slower. |
| `nvidia/nemotron-3-super-120b-a12b`, `nvidia/nemotron-nano-3-30b-a3b` | Listed in the catalog, but return 404 for this account. |

To check your own key: `curl -s https://integrate.api.nvidia.com/v1/models -H "Authorization: Bearer $NVIDIA_API_KEY"`.

Two settings matter with this endpoint:
- Reasoning (`NVIDIA_THINKING`) is on by default, so the model's thinking is captured and logged. Each call gets an extra 2,048-token budget, because without it the thinking used up the budget before the model made its tool call. With thinking on, a live eval pass had the same routing and grounding results, but median latency rose from 9.8 s to 55 s. Set `NVIDIA_THINKING=false` for faster answers.
- Structured output uses a forced function call validated with zod, because `response_format: json_schema` produced degenerate output.

There is no silent fallback to another provider.

### Web UI

`npm start` serves two pages on 127.0.0.1 only:

- **Chat** (`/`) is the traveller's view. It shows the answer, its sources, anything to be aware of, and a request reference. Tool calls and traces never reach this page or its API.
- **Admin** (`/admin`) asks for the admin token printed at startup (or set `ADMIN_TOKEN`). It lists every logged request, including CLI runs. For each one it shows the response sent and the end-to-end flow as a timeline with duration bars. Select a step to see:
  - for a model call: the full prompt, the tools offered and chosen, and the model's thinking;
  - for a tool call: its arguments, results and errors;
  - for the policy and review steps: the decision and its reason.

The browser code is TypeScript, bundled with esbuild when the server starts.

### Cloud tracing for the team (Langfuse)

Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` from a [Langfuse Cloud](https://cloud.langfuse.com) project (the free Hobby plan is enough). The same redacted events are then also sent to Langfuse:

| JourneyPilot step | In Langfuse |
|-------------------|-------------|
| One request | One trace, with the traveller's message as input and the final answer as output |
| Each model call | A generation: full prompt, thinking, output, tool calls, token usage |
| Each agent and each tool call | Nested spans; failures are marked at ERROR level |
| Classification, policy, delegation, review | Events |

Anyone you invite to the Langfuse project, as admin, member or viewer, can see every trace. Export runs in the background and never blocks or fails a request.

## Architecture

```
user message
   |
   v
Orchestrator --classify (forced function call, zod-validated)--> Nemotron
   |
   v
Policy gate (code): malformed -> refuse | no travel intent -> decline | low confidence -> clarify
   |  allow: intents mapped to agents in code, travel part of the request only
   v
+-------------+  +-------------+  +------------------+
| Flight      |  | Hotel       |  | Benefits         |   run in parallel, each with a
| agent       |  | agent       |  | agent            |   bounded tool loop (3 to 4 steps)
+------+------+  +------+------+  +--------+---------+
       |                |                  |
       v                v                  v
            ToolGateway (code): permissions, zod args, timeout, retry, trace
       |                |                  |
 search_flights    search_hotels    find_official_sources, fetch_official_page
 (Kiwi MCP, live)  (demo fixture)   (registry + allowlisted fetch)
   |
   v
Orchestrator: compose (LLM, structured) -> render results from data (code) -> grounding judge (LLM) -> answer
```

### How responsibilities are divided

| Component | Responsibility | Tools |
|-----------|----------------|-------|
| Orchestrator | Classify, plan, delegate, combine, write the final answer | `classify_request` only. It cannot call specialist tools. |
| Flight agent | Search and compare flights | `search_flights` |
| Hotel agent | Compare hotels; nightly rate vs total stay cost | `search_hotels` |
| Benefits agent | Lounge access, Priority Pass, card benefits | `find_official_sources`, `fetch_official_page` |
| Answer composer | Picks results by reference and writes the prose; code renders each picked result from tool data | `compose_answer` (structured output only) |
| Grounding judge | Checks every sentence the model wrote against the evidence; unsupported sentences are removed | `record_verdicts` (structured output only) |

### Key decisions

- **Delegation is decided by code, not left to the model.** The model classifies the request. Code maps the validated intents to agents (`flight_search` to Flight, and so on) and runs only those agents. A model therefore cannot route a request to an agent its intents do not justify, and delegation is easy to test.
- **Tool permissions are enforced in `ToolGateway`.** Each agent's model only sees its own tools. If it names another agent's tool anyway, the call is refused and logged as `not_permitted`. Arguments are validated with zod before anything runs, so bad dates, past departures or URLs off the allowlist never reach a provider.
- **Scope is decided once, before any agent runs.** Agents receive only the travel part of the request. Retrieved pages and tool output are wrapped as untrusted data, with `<` and `>` escaped so they cannot close the wrapper, and so cannot widen scope.
- **Prices and links cannot be invented.** The model never writes the result lines. It returns a structured answer that refers to results by ID (F1 for a flight, H1 for a hotel, S1 for an official page). Code renders each referenced result's price, route, times, airline, baggage and booking link from the tool output, and labels demo hotels.
- **Every sentence the model writes is judged.** A second structured call checks each summary, comment and note against the results and the provider's record of the search. Anything without an explicit "supported" verdict is removed before the traveller sees it; if the judge is unavailable, all prose is removed and only the rendered results remain. Code also checks structurally that referenced IDs exist, benefit answers cite a fetched page, and sources are fresh.
- **No regex for understanding content.** Routing is a model classification validated by zod. Official pages are parsed with htmlparser2, and the passages most relevant to the question are ranked with Nemotron embeddings. Answers are checked by the judge, and Markdown is rendered by markdown-it. Regex remains only in log redaction, where it matches fixed secret and personal-data formats.
- **Missing details become questions.** The classifier reports missing essentials (origin, destination, travel date, hotel city, check-in date). The policy gate then asks for them in plain language before any agent runs. The chat page sends the earlier message with the reply, so "2nd November, 2 people" completes "a Bombay to Delhi ticket".
- **No agent framework.** A small loop over the OpenAI-compatible API keeps permissions, validation and tracing in one place that tests can inspect directly. Mastra would be a reasonable next step (see below); the gateway and policy gate would carry over as tool wrappers.

### MCP integration

The Kiwi.com public MCP server (`https://mcp.kiwi.com`, streamable HTTP, no key) is connected at startup. The flight tool is found by its input schema (`flyFrom`, `flyTo`, `departureDate`), not by a hard-coded name. Results are condensed to the fields the provider returned.

Failures that are handled:
- Connection failure (retried once at startup; flight search then reports itself unavailable).
- Timeouts (retried once per call).
- Error results from the server.
- Non-JSON content, or an unexpected result shape.

In live runs the endpoint occasionally drops a TCP connection or takes over 30 s, which is why these paths exist.

What each journey actually uses:

| Journey | Data | Status |
|---------|------|--------|
| Flights | Kiwi.com via MCP | Live |
| Hotels | Local fixture | Demo only, labelled in every answer. No free, keyless hotel provider was available. |
| Lounges and cards | Official issuer and programme pages fetched live (Priority Pass, Amex UK, Capital One, LoungeKey, DragonPass) | Live, cited with URL and retrieval time |
| Trip planning | Orchestrator combines specialist results | Uses the above |

## Observability

Each request writes JSONL events to `logs/<date>.jsonl`. Events share a `traceId` and `requestId` and are linked by `spanId` and `parentSpanId`.

| Event | What it records |
|-------|-----------------|
| `request` | The submitted message (redacted) |
| `classification` | Intents, confidence, travel task, unsupported portion |
| `policy` | Outcome, reason, selected agents |
| `delegation` | Agent and reason |
| `model` | Purpose, model ID, latency, token usage, finish reason |
| `tool` | Agent, tool, MCP server, validated arguments, status, attempts, duration, result preview |
| `agent` | Status, tools used, errors, reminders |
| `review` | Findings, whether the answer was replaced, the rejected text |
| `final` | Status, sources, limitations, total duration |

Run `npm run ask -- --trace "..."` to print the trace.

With the defaults, the trace holds:
- every prompt sent to the model, with the tools offered and the tool chosen;
- the model's thinking (`NVIDIA_THINKING=true`);
- tool arguments and full results;
- the final answer.

Before any event is written, the following are redacted:
- the configured API key and other key patterns
- bearer tokens and fields with sensitive names
- emails, phone numbers, card numbers and passport-like IDs

Set `LOG_RAW_PAYLOADS=false` to keep only 300-character previews of prompts and results; secrets are redacted either way. Files older than `LOG_RETENTION_DAYS` (default 7) are deleted at startup. If a log write fails, a warning goes to stderr and the request continues; policy decisions are made before logging and do not depend on it.

## Testing

`npm test` runs 110 offline tests in about 5 seconds, with a scripted model and a real MCP server over an in-memory transport:

| File | Covers |
|------|--------|
| `tests/policy.test.ts` | Fail-closed classification, decline, clarify, intent-to-agent mapping |
| `tests/gateway.test.ts` | Permission denial without execution, invalid arguments, timeout and retry, least privilege |
| `tests/mcp-flights.test.ts` | Schema-based tool discovery, argument mapping, provider errors, malformed output, replay of a recorded Kiwi response |
| `tests/benefits.test.ts` | Domain allowlist (lookalike domains, credentials in URLs, metadata IPs), redirect checks, excerpts |
| `tests/reviewer.test.ts` | Result rendering from tool data, demo labels, fetched-page citations, unknown references, stale sources, judge verdicts failing closed |
| `tests/redaction.test.ts` | Secret and personal-data masking, redaction before truncation, sink failure, retention |
| `tests/langfuse.test.ts` | Mapping to Langfuse traces, generations and spans; redaction of what is sent; flush on completion; cloud outages |
| `tests/server.test.ts` | Chat API returns no trace data, admin token required, cross-origin and DNS-rebinding refusal, bundled pages |
| `tests/orchestrator.test.ts` | Refusal before any agent runs, mixed requests, multi-agent trips, tool failure, injected page content, reminder path, trace correlation |

## Evaluation

The question the evals answer is: did the right path produce this answer? A fluent answer reached by the wrong path should still fail. `npm run eval` sends eight live requests through the real model, MCP server and websites and grades each one, mostly from its trace:

- **Policy:** the expected outcome (allow, decline, refuse).
- **Delegation:** exactly the expected set of agents ran, no more and no fewer.
- **Blocked before execution:** for declined requests, zero delegations and zero tool calls.
- **Tool permissions:** no `not_permitted` calls, and every call is inside its agent's allowlist.
- **Required tools and MCP usage:** the expected tools succeeded, including at least one call through the MCP server where flights are involved.
- **Grounding review:** the structural checks passed (referenced results exist, benefit answers cite a fetched page, sources are fresh).
- **Answer text:** required phrases (currency, demo label, citation domain, decline notice, "which date") are present and forbidden ones absent, checked as plain phrase lists.
- **Soft signals,** reported but not failing a case:
  - whether the model's answer was kept in full;
  - how many sentences the grounding judge removed.

Cases: flight comparison, hotel stay, lounge eligibility, an unrelated coding request, unrelated finance advice, a mixed request, direct prompt injection, and a multi-domain trip. Dates are relative to today, so the suite does not go stale.

**Catching regressions.** Every run writes `evals/results/<timestamp>.json` with per-check pass rates, latency, model calls, tool calls and tokens. The runner exits non-zero on any hard failure, so it can gate CI. `--repeat N` measures flakiness, which matters with a nondeterministic model.

**What the evals found while building this:**
- Specialists answered without calling tools: for "3 nights from <date>" with no check-out date, and for "Heathrow" not being matched as a city.
- Arithmetic errors in prose ("£39 cheaper" when the gap was £29). The pattern-based checker caught these, but also misread "1 560 AED" and links wrapped in backticks. Both problems led to the move to structured answers checked by a judge.

Each was fixed in its own commit.

**Latest results:** 16/16 case runs passed over two live passes; details in [Latest evaluation results](#latest-evaluation-results).

## Assumptions and limitations

- Hotel data is a demo fixture. A real provider would replace `search_hotels` behind the same gateway.
- Lounge and card answers are only as good as the official pages in the registry (six pages).
- The grounding judge is itself a model. It fails closed (no verdict means the sentence is removed), but it can still wrongly support or reject a sentence. Its verdicts and reasons are in every trace for review.
- With thinking on, a request makes about five model calls and typically takes 1 to 2 minutes; the judge is the slowest step. `NVIDIA_THINKING=false` brings this to roughly 15 to 25 seconds.
- Kiwi prices are in the requested currency, GBP by default. Results from a city search can include nearby airports (for example Sharjah for Dubai).
- The model is nondeterministic. The reminder step and the evals reduce, but do not remove, cases where an agent answers without searching.
- Classification is a single model call. If the model is unavailable, the request fails closed and nothing runs.
- There is no conversation memory; each message is handled on its own.

## What I would change for production

- Move the agents onto Mastra (or similar) for workflows, memory and deployment, keeping the gateway and policy gate as the enforcement layer.
- Build Langfuse dashboards and alerts for policy outcomes, tool error rates, review replacements and latency per agent. Add single sign-on, and an admin login for the web console in place of the shared token.
- Use a stronger model, or a second classifier, for the policy decision, and calibrate the confidence threshold against labelled traffic.
- Add a model-based judge for claim-level support in benefit answers, calibrated against human labels, alongside the deterministic checks.
- Real hotel inventory and authenticated provider access, with response caching and rate limiting per provider.
- A larger, versioned eval set built from anonymised production traces, run in CI on every prompt or model change, with thresholds per check.
- Secrets in a manager rather than `.env`; centralised log retention and access control.

## Latest evaluation results

`npm run eval -- --repeat 2` on 2026-10-27 with `nvidia/nemotron-3.5-lightning-30b-a3b` and the live Kiwi MCP server: **16/16 case runs passed.**

| Check | Pass rate |
|-------|-----------|
| policy, delegation, tool_permissions | 16/16 each |
| blocked_before_execution | 6/6 |
| required_tools | 12/12 |
| mcp_used | 4/4 |
| grounding_review | 10/10 |
| answer text, citations, status | 18/18, 4/4, 12/12 |
| synthesis_kept (soft) | 8/10 |

Median case latency was 9.8 s; the slowest was 46 s, a flight search where the Kiwi call was slow. The run used about 76k tokens in total.

These results predate the structured answer and grounding judge (`32388f0`); `excerpt_support` was replaced by the judge's verdicts. Both `synthesis_kept` misses were real arithmetic errors by the model, caught by the earlier checker. The fares were £312 and £341. In one run the model wrote "£39 cheaper", and in the other "saves £31"; the correct difference is £29. In both cases the traveller received the tool-verified figures instead. An earlier single run had failed `multi-domain-trip` because the Hotel agent answered without searching; the reminder step in `32e5fc4` fixed it.
