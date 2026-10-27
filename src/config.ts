import { existsSync } from "node:fs";
import { z } from "zod";

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const ConfigSchema = z.object({
  NVIDIA_API_KEY: z.string().min(1, "NVIDIA_API_KEY is required (free key from https://build.nvidia.com)"),
  NVIDIA_BASE_URL: z.url().default("https://integrate.api.nvidia.com/v1"),
  NVIDIA_MODEL: z.string().min(1).default("nvidia/nemotron-3.5-lightning-30b-a3b"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  KIWI_MCP_URL: z.url().default("https://mcp.kiwi.com"),
  MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  LOG_DIR: z.string().min(1).default("logs"),
  LOG_RAW_PAYLOADS: booleanFlag,
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
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
