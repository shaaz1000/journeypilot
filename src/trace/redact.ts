const SENSITIVE_KEY = /^(api[-_]?key|authorization|token|access[-_]?token|secret|password|cookie)$/i;

const PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  [/\b(nvapi|sk|gsk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  // Card-like numbers: 13 to 19 digits, optionally grouped by spaces or dashes.
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[REDACTED_CARD]"],
  [/\+?\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b/g, "[REDACTED_PHONE]"],
  // Passport-like identifiers: one or two letters followed by 7 to 9 digits.
  [/\b[A-Z]{1,2}\d{7,9}\b/g, "[REDACTED_ID]"],
];

export interface RedactOptions {
  /** Exact secret values (e.g. the configured API key) that must never appear in logs. */
  secrets?: string[];
}

export function redactString(input: string, options: RedactOptions = {}): string {
  let output = input;
  for (const secret of options.secrets ?? []) {
    if (secret.length >= 6) output = output.split(secret).join("[REDACTED_SECRET]");
  }
  for (const [pattern, replacement] of PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

/** Deep-redacts any JSON-like value. Values under sensitive keys are dropped entirely. */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  if (typeof value === "string") return redactString(value, options) as T;
  if (Array.isArray(value)) return value.map((item) => redact(item, options)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(inner, options);
    }
    return out as T;
  }
  return value;
}
