import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolSpec } from "../llm/types.js";
import type { AgentName, EvidenceRecord } from "../schemas.js";
import type { Tracer } from "../trace/tracer.js";
import { ToolError, type ToolDefinition } from "./types.js";

export type ToolPermissions = Record<AgentName, readonly string[]>;

export type ToolInvocation =
  | { ok: true; toolCallId: string; evidence: EvidenceRecord }
  | { ok: false; toolCallId: string; error: ToolError };

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 750;

/**
 * The only path from an agent to a tool. Permissions, argument validation, timeouts,
 * bounded retries and telemetry live here so that no prompt can bypass them.
 */
export class ToolGateway {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    tools: ToolDefinition[],
    private readonly permissions: ToolPermissions,
  ) {
    for (const tool of tools) this.tools.set(tool.name, tool);
    for (const [agent, names] of Object.entries(permissions)) {
      for (const name of names) {
        if (!this.tools.has(name)) throw new Error(`permission for ${agent} references unregistered tool ${name}`);
      }
    }
  }

  allowedTools(agent: AgentName): string[] {
    return [...(this.permissions[agent] ?? [])];
  }

  /** Tool specs shown to an agent's model: only the tools it is permitted to call. */
  specsFor(agent: AgentName): ToolSpec[] {
    return this.allowedTools(agent).map((name) => {
      const tool = this.tools.get(name)!;
      const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
      return { name: tool.name, description: tool.description, parameters };
    });
  }

  async invoke(agent: AgentName, toolName: string, rawArgs: unknown, tracer: Tracer, parentSpanId?: string): Promise<ToolInvocation> {
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
    const tool = this.tools.get(toolName);
    const base = { toolCallId, agent, tool: toolName, source: tool?.source, server: tool?.server };
    const fail = (error: ToolError, extra: Record<string, unknown> = {}): ToolInvocation => {
      tracer.emit("tool", { ...base, status: error.kind, error: error.message, ...extra }, { parentSpanId });
      return { ok: false, toolCallId, error };
    };

    if (!tool) return fail(new ToolError(`unknown tool ${toolName}`, "unknown_tool"), { args: rawArgs });
    if (!this.permissions[agent]?.includes(toolName)) {
      return fail(new ToolError(`agent ${agent} is not permitted to call ${toolName}`, "not_permitted"), { args: rawArgs });
    }

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
      return fail(new ToolError(`invalid arguments: ${detail}`, "invalid_args"), { args: rawArgs });
    }

    const maxAttempts = 1 + (tool.retries ?? 0);
    const started = performance.now();
    let lastError = new ToolError("tool did not run", "provider");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const output = await withTimeout(tool.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) => tool.execute(parsed.data, { signal }));
        tracer.emit(
          "tool",
          {
            ...base,
            status: "ok",
            args: parsed.data,
            attempts: attempt,
            durationMs: Math.round(performance.now() - started),
            dataSource: output.dataSource,
            result: tracer.payload(output.data),
          },
          { parentSpanId },
        );
        return {
          ok: true,
          toolCallId,
          evidence: { toolCallId, agent, tool: toolName, source: tool.source, server: tool.server, ...output },
        };
      } catch (error) {
        lastError = error instanceof ToolError ? error : new ToolError(String(error), "provider", false);
        if (!lastError.retryable || attempt === maxAttempts) {
          return fail(lastError, { args: parsed.data, attempts: attempt, durationMs: Math.round(performance.now() - started) });
        }
        // Short, growing pause so a flaky connection has a moment to recover before the next attempt.
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * attempt));
      }
    }
    return fail(lastError);
  }
}

async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ToolError(`tool timed out after ${timeoutMs} ms`, "timeout", true));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
