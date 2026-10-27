import { existsSync } from "node:fs";
import { z } from "zod";

const booleanFlag = (fallback: "true" | "false") =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback)
    .transform((value) => value === "true" || value === "1");

const ConfigSchema = z.object({
  NVIDIA_API_KEY: z.string().min(1, "NVIDIA_API_KEY is required (free key from https://build.nvidia.com)"),
  NVIDIA_BASE_URL: z.url().default("https://integrate.api.nvidia.com/v1"),
  NVIDIA_MODEL: z.string().min(1).default("nvidia/nemotron-3.5-lightning-30b-a3b"),
  // Thinking is logged end to end. Turning it off makes replies roughly five times faster.
  NVIDIA_THINKING: booleanFlag("true"),
  NVIDIA_THINKING_TOKENS: z.coerce.number().int().positive().default(2048),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  KIWI_MCP_URL: z.url().default("https://mcp.kiwi.com"),
  MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LOG_DIR: z.string().min(1).default("logs"),
  // Full prompts, results and responses are logged by default (redacted). Set false for previews only.
  LOG_RAW_PAYLOADS: booleanFlag("true"),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  // Cloud tracing is on when both Langfuse keys are set.
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.url().default("https://cloud.langfuse.com"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env && existsSync(".env")) process.loadEnvFile(".env");
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}
