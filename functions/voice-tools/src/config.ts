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
  /** One area status KV read, behind the memory cache (T22: KV reads took 1,083 to 1,639 ms on 13 October — DEBUGLOG issue 17). */
  areaStatusMs: 2_000,
  /** mock-crm `POST /lines/<lineId>/test`, slow on purpose (its fake waits 0.8 to 1.5 s). */
  crmLineTestMs: 5_000,
  /** `SESSION.setVerified` and `SESSION.recordVerifyFailure` (T19). */
  sessionSetVerifiedMs: 1_000,
  sessionRecordVerifyFailureMs: 1_000,
  /** `CUSTOMER_ACCOUNT.verify` and `CUSTOMER_ACCOUNT.createTicket` (T19). */
  accountVerifyMs: 1_000,
  accountCreateTicketMs: 1_000,
  /** `AREA_INCIDENT.report`, which can queue behind other reporters and the actor's own alarm during an outage (T19). */
  areaReportMs: 3_000,
  /** The `flags/global` KV read, behind the memory cache, with the defaults on a timeout (T19). */
  flagsMs: 1_000,
  /** The anonymous callback write to `callback/<sid>` (T19; a KV write takes about 1.4 s — DEBUGLOG issue 11). */
  callbackWriteMs: 2_500,
  /**
   * mock-crm `GET /accounts/<number>` inside `verify_account`. T22: covers
   * two first uses in a row — this replica's `INTERNAL_KEY` read inside
   * `getAccount` (0.55 to over 1.0 s cold, no longer cut at
   * `SECRET_READ_TIMEOUT_MS`) and mock-crm's own 1,000 ms read window on a
   * cold replica (T20), about 1.7 s together (DEBUGLOG issue 17).
   */
  crmAccountMs: 2_500,
  /**
   * One KV read or write on the internal demo routes (T15): a KV write and
   * a read together took up to 3.3 s in the health checks after the T20
   * ship.
   */
  demoKvMs: 5_000,
  /** One simulated `AREA_INCIDENT.report` on the demo routes (T15); ten of them in a row stay well inside the platform's 30 s limit. */
  demoReportMs: 2_000,
  /** One reset actor call on the demo routes (T15); the thirteen run in parallel under the same limit. */
  demoResetMs: 2_000,
} as const;

/** The per-container memory-cache lifetime for area statuses (ADR-019). */
export const AREA_CACHE_TTL_MS = 10_000;

/** The per-container memory-cache lifetime for `flags/global` (ADR-019). */
export const FLAG_CACHE_TTL_MS = 10_000;

/** An anonymous callback request lives in KV for seven days (docs/ARCHITECTURE.md, KV keys). */
export const CALLBACK_TTL_SEC = 7 * 24 * 60 * 60;

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
