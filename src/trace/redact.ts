// Matched against the key lower-cased with "-" and "_" removed. Token counts (promptTokens) are not secrets.
const SENSITIVE_KEY = /^(auth|token)$|apikey|authorization|accesstoken|refreshtoken|bearer|secret|password|passwd|cookie|session|credential|privatekey/;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[-_]/g, ""));
}

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

/** Fields that hold identifiers this app generates itself; nothing else is exempt from masking. */
const GENERATED_ID_KEYS = new Set(["traceId", "requestId", "spanId", "parentSpanId", "conversationId", "toolCallId"]);
const HEX = new Set("0123456789abcdef");
const UUID_GROUPS = [8, 4, 4, 4, 12];

/** A canonical UUID (8-4-4-4-12 hex) with at least one letter, so a digits-only value is never exempt. */
function isUuid(value: string): boolean {
  const groups = value.toLowerCase().split("-");
  return (
    groups.length === UUID_GROUPS.length &&
    groups.every((g, i) => g.length === UUID_GROUPS[i] && [...g].every((c) => HEX.has(c))) &&
    [...value.toLowerCase()].some((c) => c >= "a" && c <= "f")
  );
}

/**
 * Generated UUIDs contain digit runs that look like card or phone numbers. They are kept intact so traces
 * stay linkable, but only under the app's own ID fields and only in strict UUID form.
 */
function isGeneratedId(key: string, value: string): boolean {
  return GENERATED_ID_KEYS.has(key) && isUuid(value);
}

/** Deep-redacts any JSON-like value. Values under sensitive keys are dropped entirely. */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  if (typeof value === "string") return redactString(value, options) as T;
  if (Array.isArray(value)) return value.map((item) => redact(item, options)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (isSensitiveKey(key)) out[key] = "[REDACTED]";
      else if (typeof inner === "string" && isGeneratedId(key, inner) && !(options.secrets ?? []).some((s) => s.length >= 6 && inner.includes(s))) out[key] = inner;
      else out[key] = redact(inner, options);
    }
    return out as T;
  }
  return value;
}
