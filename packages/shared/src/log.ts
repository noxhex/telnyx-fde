/**
 * Structured request logging. Every function writes one JSON object per line
 * with `ts` (ISO 8601), `level`, `svc`, `event`, then the fields. This is the
 * one observability signal we own (docs/ARCHITECTURE.md, Observability), so
 * the shape is fixed here once for all functions.
 *
 * Redaction: any field whose name contains `token`, `authorization`,
 * `signature`, `secret`, `password` or `key` (case-insensitive) is written as
 * `"[redacted]"`, at any depth, including inside arrays. The structural
 * fields (`ts`, `level`, `svc`, `event`) are produced by the logger itself
 * and never pass through the redactor.
 */

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  log(level: Level, event: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

const REDACTED = "[redacted]";

const SENSITIVE_NAME = /token|authorization|signature|secret|password|key/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Walks JSON-shaped field values, replacing sensitive fields with
// "[redacted]". Non-plain objects (Date, Map, ...) pass through untouched so
// their own toJSON keeps working.
function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [name, fieldValue] of Object.entries(value)) {
    out[name] = SENSITIVE_NAME.test(name) ? REDACTED : redact(fieldValue);
  }
  return out;
}

/**
 * Creates a logger for one service. `sink` receives each finished line
 * (default: stdout); `now` is the clock behind `ts` (default: Date.now), so
 * tests get deterministic timestamps.
 */
export function createLogger(
  svc: string,
  sink: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
  now: () => number = () => Date.now(),
): Logger {
  const make = (base: Fields): Logger => ({
    log(level: Level, event: string, fields: Fields = {}): void {
      const ts = new Date(now()).toISOString();
      const line: Record<string, unknown> = {
        ts,
        level,
        svc,
        event,
        ...(redact({ ...base, ...fields }) as Record<string, unknown>),
      };
      // Re-assigning (which keeps the original key order) makes sure a field
      // named ts, level, svc or event can never overwrite the logger's own
      // values.
      Object.assign(line, { ts, level, svc, event });
      sink(JSON.stringify(line));
    },
    child(fields: Fields): Logger {
      return make({ ...base, ...fields });
    },
  });
  return make({});
}
