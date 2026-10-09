# T02. Logging, timing, KV keys and test fakes

**Phase** 1 · **Depends on** T01

## Goal

Build the shared plumbing every function uses, so the request log line, the per-hop latency and the KV key rules are identical everywhere. Add the fakes that later tests run against.

## Read first

- `AGENTS.md`, sections Conventions and Platform facts.
- `docs/ARCHITECTURE.md`, sections KV keys and Observability.
- The `KvNamespace` type in `node_modules/@telnyx/edge-runtime`, for the KV fake's shape, and the actor storage type in the same package.

## Files

- `packages/shared/src/log.ts`, `mask.ts`, `timing.ts`, `kv-keys.ts`, and exports from `src/index.ts`.
- `packages/shared/test/fakes/kv.ts`, `actor-storage.ts`, `clock.ts`.
- `packages/shared/test/log.test.ts`, `mask.test.ts`, `timing.test.ts`, `kv-keys.test.ts`, `fakes.test.ts`.
- `tsconfig.base.json` at the repo root, for `lib` and `types` only.

## Interface

```ts
// log.ts
export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;
export interface Logger {
  log(level: Level, event: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}
export function createLogger(
  svc: string,
  sink?: (line: string) => void,   // default writes to stdout
  now?: () => number,
): Logger;

// mask.ts
export function maskPhone(e164: string): string;    // "+32491244713" -> "+32…4713"
export function maskAccount(id: string): string;    // "DV-100231" -> "DV-…231"

// timing.ts
export type Hop = "kv" | "actor" | "crm" | "http";
export interface Timings {
  time<T>(hop: Hop, fn: () => Promise<T>): Promise<T>;
  snapshot(): { total: number } & Partial<Record<Hop, number>>;
}
export function startTimings(now?: () => number): Timings;

// kv-keys.ts
export const kvKeys: {
  crmPhone(e164: string): string;          // "crm/phone/32491244713"
  session(sid: string): string;            // "session/<sid>"
  areaStatus(postcode: string): string;    // "area/8630/status"
  callback(sid: string): string;           // "callback/<sid>"
  flags(): string;                         // "flags/global"
  canaryLast(): string;                    // "canary/last"
  canaryProbe(): string;                   // "canary/probe"
};
export function sessionIdFromCallControlId(callControlId: string): string;
export function assertValidKey(key: string): void;
```

## Behaviour

- **Log lines.** One JSON object per line with `ts` (ISO 8601), `level`, `svc`, `event`, then the fields. `child` merges its fields into every line it writes.
- **Redaction.** Any field whose name contains `token`, `authorization`, `signature`, `secret`, `password` or `key` (case-insensitive, at any depth) is written as `"[redacted]"`.
- **Masking.** `maskPhone` keeps the `+` and the first two digits, then `…`, then the last four. Input with fewer than six digits becomes `"…"`. `maskAccount` keeps the prefix up to and including the dash, then `…`, then the last three characters.
- **Timing.** `time` adds each call's duration to its hop, so parallel calls on the same hop add up. `total` is the wall time since `startTimings`. All values are whole milliseconds.
- **KV keys.** `crmPhone` keeps digits only. `session` and `callback` accept only 32 lowercase hex characters. `areaStatus` accepts only four digits. Invalid input throws.
- `sessionIdFromCallControlId` returns the first 32 hex characters of SHA-256 over the UTF-8 call control id, using `node:crypto`.
- `assertValidKey` throws if the key is empty, longer than 256 characters, or contains anything outside `a-z A-Z 0-9 - _ / = .`.
- **Fakes.** The KV fake supports `get` (text and JSON), `put` with `expirationTtl` in seconds, `delete` and `list` with a prefix, honours TTL against an injected clock, and records every call so tests can assert that a route did not touch KV. The actor storage fake supports `get`, `put`, `delete`, `list`, `deleteAll`, `setAlarm`, `getAlarm` and `deleteAlarm`. The clock fake has `now()` and `advance(ms)`.
- **Compiler settings.** `tsconfig.base.json` sets `lib` to `["ES2023"]` and `types` to `["node"]`, with no `DOM`, so no code type-checks against browser globals. `npm run check` must still pass with these settings. If the types of `@telnyx/edge-runtime` turn out to need `DOM`, keep `DOM` in `lib` and say so in your report.

## Acceptance

- [ ] `npm run check` passes.
- [ ] `tsconfig.base.json` sets `lib` to `["ES2023"]` and `types` to `["node"]`. `DOM` is only there if the report explains why the runtime's types need it.
- [ ] Tests cover nested redaction, every masking rule including short input, parallel timing on one hop, every key builder with valid and invalid input, keys containing `:` and `+` being rejected, a stable session id for a known input, and KV fake expiry.

## Out of scope

Shipping, real Telnyx calls, any function code.
