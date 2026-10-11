/**
 * voice-tools configuration: the timeouts from card T09's table (each
 * outbound call gets its own), the memory-cache lifetime for area statuses
 * (ADR-019), the secret handles and the session/token lifetime. No I/O here
 * — values and pure helpers only.
 *
 * Every dependency call goes through the injected `TimeoutRunner`, so tests
 * hold promises and fire timers by hand (AGENTS.md, Tests).
 */

/** A secret read is one HTTP hop to the sidecar (DEBUGLOG issue 9); a timeout counts as a failed read. */
export const SECRET_HANDLES = {
  mcpTokenKey: "MCP_TOKEN_KEY",
  internalKey: "INTERNAL_KEY",
} as const;

export const SECRET_READ_TIMEOUT_MS = 1_000;

export const TIMEOUTS = {
  /** `SESSION.get` on the MCP path, `SESSION.create` on /internal/sessions. */
  sessionGetMs: 1_000,
  sessionCreateMs: 1_000,
  /** One area status KV read, behind the memory cache (a KV read takes about 0.8 s — DEBUGLOG issue 11). */
  areaStatusMs: 1_500,
  /** mock-crm `POST /lines/<lineId>/test`, slow on purpose (its fake waits 0.8 to 1.5 s). */
  crmLineTestMs: 5_000,
} as const;

/** The per-container memory-cache lifetime for area statuses (ADR-019). */
export const AREA_CACHE_TTL_MS = 10_000;

/** Sessions live two hours; the token minted for a session expires with it (T04, T18). */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export const SERVICE_NAME = "voice-tools";

/** What a `TimeoutRunner` resolves with when its timer wins the race. */
export const TIMED_OUT: unique symbol = Symbol("timed_out");

/**
 * Races `fn()` against `ms` milliseconds of real time. Settlements of `fn`
 * after the timer won are still handled (the handlers stay attached), so a
 * late call can never surface as an unhandled rejection. Tests inject a
 * manual runner and fire every timer by hand.
 */
export type TimeoutRunner = <T>(fn: () => Promise<T>, ms: number) => Promise<T | typeof TIMED_OUT>;

export const realTimeoutRunner: TimeoutRunner = <T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> =>
  new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
