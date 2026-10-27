import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { JsonlFileSink } from "../src/trace/tracer.js";
import { CASES } from "./cases.js";
import { grade, type Check } from "./graders.js";

interface CaseRun {
  id: string;
  run: number;
  passed: boolean;
  status: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  totalTokens: number;
  traceId: string;
  checks: Check[];
  answer: string;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const repeats = Number(argValue("--repeat") ?? 1);
  const only = argValue("--case");
  const cases = only ? CASES.filter((c) => c.id === only) : CASES;
  if (cases.length === 0) throw new Error(`no eval case named ${only}`);

  // Raw payloads are needed for the excerpt-support grader; they stay in the local eval log directory.
  const config = { ...loadConfig(), LOG_RAW_PAYLOADS: true };
  const app = await createApp(config, { sinks: [new JsonlFileSink(join(config.LOG_DIR, "eval"))] });
  console.log(`model ${config.NVIDIA_MODEL} | MCP ${app.mcp.server}: ${app.mcp.connected ? "connected" : app.mcp.error}\n`);

  const runs: CaseRun[] = [];
  try {
    for (let run = 1; run <= repeats; run++) {
      for (const testCase of cases) {
        const started = performance.now();
        const { result, tracer } = await app.orchestrator.handle(testCase.message);
        const checks = grade(testCase, result, tracer.events);
        const models = tracer.events.filter((e) => e.kind === "model");
        const entry: CaseRun = {
          id: testCase.id,
          run,
          passed: checks.every((c) => c.passed || c.soft),
          status: result.status,
          durationMs: Math.round(performance.now() - started),
          modelCalls: models.length,
          toolCalls: tracer.events.filter((e) => e.kind === "tool").length,
          totalTokens: models.reduce((sum, e) => sum + ((e.usage as { totalTokens?: number } | undefined)?.totalTokens ?? 0), 0),
          traceId: tracer.traceId,
          checks,
          answer: result.answer,
        };
        runs.push(entry);
        const failed = checks.filter((c) => !c.passed);
        console.log(`${entry.passed ? "PASS" : "FAIL"}  ${testCase.id.padEnd(20)} ${result.status.padEnd(9)} ${String(entry.durationMs).padStart(6)}ms  models=${entry.modelCalls} tools=${entry.toolCalls}`);
        for (const c of failed) console.log(`      ${c.soft ? "warn" : "fail"} ${c.name}: ${c.detail}`);
      }
    }
  } finally {
    await app.close();
  }

  const passed = runs.filter((r) => r.passed).length;
  const checkStats = new Map<string, { passed: number; total: number }>();
  for (const c of runs.flatMap((r) => r.checks)) {
    const key = c.name.startsWith("answer") ? "answer_text" : c.name.startsWith("tool:") ? "required_tools" : c.name;
    const s = checkStats.get(key) ?? { passed: 0, total: 0 };
    s.total++;
    if (c.passed) s.passed++;
    checkStats.set(key, s);
  }
  console.log(`\n${passed}/${runs.length} case runs passed`);
  for (const [name, s] of checkStats) console.log(`  ${name.padEnd(26)} ${s.passed}/${s.total}`);

  const outDir = join("evals", "results");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ model: config.NVIDIA_MODEL, mcp: app.mcp, repeats, passed, total: runs.length, checks: Object.fromEntries(checkStats), runs }, null, 2));
  console.log(`\nresults written to ${file}`);
  process.exit(passed === runs.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
