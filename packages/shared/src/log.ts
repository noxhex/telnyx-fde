/**
 * Structured request logging. Every function writes one JSON object per line
 * with `ts` (ISO 8601), `level`, `svc`, `event`, then the fields. This is the
 * one observability signal we own (docs/ARCHITECTURE.md, Observability), so
 * the shape is fixed here once for all functions.
 *
 * Redaction: any field whose name contains `token`, `authorization`,
 * `signature`, `secret`, `password` or `key` (case-insensitive) is written as
 * `"[redacted]"`, at any depth, including inside arrays. The structural
 * fields (`ts`, `level`, `svc`, `event`) always come from the logger: a
 * field with one of those names can never overwrite them.
 *
 * `log()` never throws because of a field value. A `BigInt` is written as
 * its decimal string, a repeated object reference (self-references
 * included) is written as `"[circular]"`, and a value that still cannot be
 * serialised (a throwing getter or `toJSON`) degrades the line to the
 * structural fields plus a `fields_error` marker instead of crashing.
 */

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  log(level: Level, event: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";

const SENSITIVE_NAME = /token|authorization|signature|secret|password|key/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Walks field values for one log line, replacing sensitive fields with
// "[redacted]". Values that JSON.stringify cannot handle are made safe
// instead: a BigInt becomes its decimal string and any object seen before
// (self-references included) becomes "[circular]". Plain objects and arrays
// are rebuilt; everything else (Date, Map, class instances) passes through
// untouched so its own toJSON keeps working.
function redact(value: unknown, seen: Set<object>): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [name, fieldValue] of Object.entries(value)) {
    out[name] = SENSITIVE_NAME.test(name) ? REDACTED : redact(fieldValue, seen);
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
      const structural = { ts, level, svc, event };
      let text: string;
      try {
        const line: Record<string, unknown> = {
          ...structural,
          ...(redact({ ...base, ...fields }, new Set()) as Record<string, unknown>),
        };
        // Re-assigning (which keeps the original key order) makes sure a
        // field named ts, level, svc or event can never overwrite the
        // logger's own values.
        Object.assign(line, structural);
        text = JSON.stringify(line);
      } catch {
        // A pathological field value (a throwing getter or toJSON) must never
        // take the request down: log the structural fields and move on.
        text = JSON.stringify({ ...structural, fields_error: "unserialisable" });
      }
      sink(text);
    },
    child(fields: Fields): Logger {
      return make({ ...base, ...fields });
    },
  });
  return make({});
}
