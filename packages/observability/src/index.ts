/**
 * Small structured JSON logger with secret redaction.
 * Kept dependency-free so it runs in Next.js route handlers, the worker and tests.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|access[-_]?key|refresh|private[-_]?key|signature)/i;

// Bearer tokens, sk-... style keys, and long opaque strings that look like credentials.
const SECRET_VALUE_PATTERNS = [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") {
    let out = value;
    for (const p of SECRET_VALUE_PATTERNS) out = out.replace(p, "[REDACTED]");
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), stack: value.stack };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  base: Record<string, unknown> = {},
  level: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info",
  sink: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): Logger {
  const min = order[level] ?? order.info;
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (order[lvl] < min) return;
    const entry = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...(fields ?? {}) };
    sink(JSON.stringify(redact(entry)));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, level, sink),
  };
}

export const logger = createLogger({ service: process.env.SERVICE_NAME ?? "dfos" });

export function newTraceId() {
  return crypto.randomUUID();
}
