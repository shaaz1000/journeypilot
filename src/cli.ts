import { createInterface } from "node:readline/promises";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { FinalAnswer } from "./schemas.js";
import type { Tracer } from "./trace/tracer.js";

function printTrace(tracer: Tracer): void {
  console.log("\n--- trace", tracer.traceId, "---");
  for (const e of tracer.events) {
    const detail =
      e.kind === "policy" ? `${e.outcome} agents=${JSON.stringify(e.agents)}`
      : e.kind === "classification" ? `intents=${JSON.stringify(e.intents)} confidence=${e.confidence}`
      : e.kind === "delegation" ? `-> ${e.agent}`
      : e.kind === "tool" ? `${e.agent} ${e.tool} [${e.source}${e.server ? `:${e.server}` : ""}] ${e.status} ${e.durationMs ?? ""}ms`
      : e.kind === "model" ? `${e.purpose} ${e.status} ${e.durationMs}ms`
      : e.kind === "agent" ? `${e.agent} ${e.status} ${e.durationMs ?? ""}ms`
      : e.kind === "review" ? `passed=${e.passed} replaced=${e.replaced} ${JSON.stringify(e.findings)}`
      : e.kind === "final" ? `${e.status} ${e.durationMs}ms`
      : "";
    console.log(`${e.kind.padEnd(14)} ${detail}`);
  }
}

function printAnswer(result: FinalAnswer): void {
  console.log(`\n[${result.status}] agents: ${result.agentsUsed.join(", ") || "none"}\n`);
  console.log(result.answer);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  const showTrace = process.argv.includes("--trace");
  const question = process.argv.slice(2).filter((a) => a !== "--trace").join(" ").trim();
  console.log(`model: ${config.NVIDIA_MODEL} | MCP ${app.mcp.server}: ${app.mcp.connected ? `connected, tools ${app.mcp.discoveredTools.join(", ")}` : app.mcp.error}`);

  try {
    if (question) {
      const { result, tracer } = await app.orchestrator.handle(question);
      printAnswer(result);
      if (showTrace) printTrace(tracer);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question("\nYou> ")).trim();
      if (!line || line === "exit") break;
      const { result, tracer } = await app.orchestrator.handle(line);
      printAnswer(result);
      if (showTrace) printTrace(tracer);
    }
    rl.close();
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
