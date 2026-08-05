const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|api[-_]?key|credential|database_url)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_PASSWORD = /(\w+:\/\/[^:\s/]+:)[^@\s/]+(@)/g;

export function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(BEARER, "Bearer [REDACTED]").replace(URL_PASSWORD, "$1[REDACTED]$2");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    if (value instanceof Error) return { name: value.name, message: redact(value.message), stack: redact(value.stack) };
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

function write(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify(redact({ timestamp: new Date().toISOString(), level, event, ...data }));
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

export const logger: Logger = {
  info: (event, data) => write("info", event, data),
  warn: (event, data) => write("warn", event, data),
  error: (event, data) => write("error", event, data),
};
