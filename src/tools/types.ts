import type { z } from "zod";
import type { Citation, EvidenceRecord } from "../schemas.js";

export interface ToolOutput {
  data: unknown;
  dataSource: EvidenceRecord["dataSource"];
  citation?: Citation;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  source: "mcp" | "local";
  /** MCP server identifier, recorded in traces for MCP-backed tools. */
  server?: string;
  timeoutMs?: number;
  /** Extra attempts for retryable failures (timeouts, transient provider errors). */
  retries?: number;
  execute(args: z.infer<S>, context: { signal: AbortSignal }): Promise<ToolOutput>;
}

export type ToolErrorKind = "unknown_tool" | "not_permitted" | "invalid_args" | "timeout" | "provider" | "malformed_output";

export class ToolError extends Error {
  constructor(
    message: string,
    readonly kind: ToolErrorKind,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function defineTool<S extends z.ZodType>(tool: ToolDefinition<S>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}
