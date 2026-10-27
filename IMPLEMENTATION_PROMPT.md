# Implementation prompt

Review the Collinson assignment and our JourneyPilot plan. Identify and fix discrepancies before implementation.

Build a TypeScript and Node.js multi-agent travel assistant using an NVIDIA Nemotron model through an available NVIDIA endpoint. Check current model availability and document configuration. Avoid paid services where possible.

Implement one orchestrator that classifies requests, plans work, delegates to specialist sub-agents, combines results, and produces the final answer. Create specialist agents for flights, hotels, and airport lounge and travel card benefits. Give each agent its own relevant tools and restrict access to only the tools it needs. Integrate at least one working external MCP server.

Restrict the assistant to travel and airport experience topics. Use semantic intent classification with structured validation, not regex-only routing. Reject unrelated requests before agent or tool execution.

Log user-submitted messages, orchestration decisions, delegation, tool calls and arguments, results, errors, timings, and guardrail decisions. Protect secrets and sensitive data.

Add automated tests and evaluations for correct delegation, tool permissions, MCP usage, domain restrictions, failures, and final answer quality. Write clear setup instructions, architecture, limitations, and evaluation details in the README. Keep the scope realistic for the two to three hour assignment.

Save this prompt as IMPLEMENTATION_PROMPT.md and the reviewed plan as PLAN.md. Implement and commit in small, meaningful stages. Do not add Co-authored-by trailers to commits. Do not use decorative symbols or triple equals signs in commit messages. Run the tests and report results, remaining limitations, and commit hashes.
