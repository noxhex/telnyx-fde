/**
 * A value read once from a slow store and kept for the life of a container,
 * refreshed in the background once its lifetime has passed (card T20,
 * DEBUGLOG issue 15: a KV read now takes longer than the 1,000 ms a request
 * can wait, so the old read-through caches timed out on every refresh and
 * the flags never applied). One container holds one instance per kind of
 * value — the `flags/global` document of mock-crm, voice-context and
 * voice-tools; production creates it at module scope next to the other
 * caches, each test creates a fresh one.
 *
 * Semantics, per the card:
 *
 * - **The last good value.** A read that resolves is a successful read; its
 *   value becomes the last good value, stamped with the time it settled. A
 *   read that rejects changes nothing. The fallback is never stored.
 * - **`get(waitMs)`.** With a last good value `get` returns it at once and
 *   never waits; if the value's age has reached `lifetimeMs` and no read is
 *   in flight, it first starts one in the background. Without a last good
 *   value `get` starts a read when none is in flight, then waits for the
 *   read in flight for at most `waitMs` — through the injected timeout
 *   runner, so tests fire the timer by hand — and returns that read's value
 *   when it succeeds in time, else the fallback.
 * - **One read at a time.** At most one read is in flight and every caller
 *   shares it. A read still unsettled `lifetimeMs` after it started no
 *   longer counts as in flight, so the next `get` or `start()` may begin
 *   another; the abandoned read still reports to `onSettled` when it lands.
 * - **A late success counts.** A read that succeeds after its waiter gave
 *   up still becomes the last good value. A value never replaces one from a
 *   read that started later (a per-read sequence number guards an abandoned
 *   read against overwriting a newer read's value).
 * - **`onSettled`** runs once for every read that settles, with `outcome`
 *   `"ok"` or `"error"` and the read's duration in whole milliseconds.
 *
 * Time inputs fail closed (AGENTS.md), as in the memory cache: construction
 * rejects a non-finite or non-positive `lifetimeMs`, and while `now()` is
 * not finite `get` behaves as if there were no last good value and a read
 * that settles then is not stored — a broken clock degrades the value to
 * always-read instead of pinning a value fresh or stale forever.
 */

/** What a `TimeoutRunner` resolves with when its timer wins the race. */
export const TIMED_OUT: unique symbol = Symbol("timed_out");

/** Races `fn()` against `ms` milliseconds, exactly the shape every function's own runner has. */
export type TimeoutRunner = <T>(
  fn: () => Promise<T>,
  ms: number,
) => Promise<T | typeof TIMED_OUT>;

export type RefreshOutcome = "ok" | "error";

/** Runs once per settled read, with the outcome and the read's duration in ms. */
export type RefreshSettledListener = (outcome: RefreshOutcome, durationMs: number) => void;

export interface RefreshingValueOptions<T> {
  /** The store read: resolves with the parsed value (a successful read) or rejects (a failed one). */
  read: () => Promise<T>;
  /** How long a last good value serves before a `get` refreshes it in the background, in ms. */
  lifetimeMs: number;
  /** What `get` answers while no successful read has ever settled and the wait runs out. */
  fallback: T;
  now: () => number;
  /** Bounds the wait inside `get`; the read itself is never cut off. */
  timeout: TimeoutRunner;
  onSettled?: RefreshSettledListener;
}

export interface RefreshingValue<T> {
  get(waitMs: number): Promise<T>;
  /** Starts a read when there is no last good value and none in flight; returns at once. */
  start(): void;
}

interface LastGood<T> {
  value: T;
  /** The clock reading when the read that produced this value settled. */
  at: number;
  /** The sequence number of the read that produced this value. */
  seq: number;
}

type Settled<T> = { ok: true; value: T } | { ok: false };

interface InFlight<T> {
  seq: number;
  startedAt: number;
  /** The read's outcome for its waiters; never rejects. */
  promise: Promise<Settled<T>>;
}

export function createRefreshingValue<T>(options: RefreshingValueOptions<T>): RefreshingValue<T> {
  const { read, lifetimeMs, fallback, now, timeout, onSettled } = options;
  if (typeof lifetimeMs !== "number" || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    throw new RangeError(
      `createRefreshingValue: lifetimeMs must be a finite number greater than zero, got ${String(lifetimeMs)}`,
    );
  }
  if (typeof read !== "function") {
    throw new TypeError("createRefreshingValue: read must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("createRefreshingValue: now must be a function");
  }
  if (typeof timeout !== "function") {
    throw new TypeError("createRefreshingValue: timeout must be a function");
  }

  let lastGood: LastGood<T> | undefined;
  let inFlight: InFlight<T> | undefined;
  let nextSeq = 0;

  /** The read that counts as in flight, or undefined when none runs or the current one is stale. */
  const current = (t: number): InFlight<T> | undefined => {
    if (inFlight === undefined) {
      return undefined;
    }
    // `NaN < lifetimeMs` is false: a broken clock never pins a read as
    // current, so the next get starts another, the way the memory cache
    // re-reads on every call.
    return t - inFlight.startedAt < lifetimeMs ? inFlight : undefined;
  };

  const beginRead = (): InFlight<T> => {
    const seq = nextSeq + 1;
    nextSeq = seq;
    const startedAt = now();
    const task: InFlight<T> = {
      seq,
      startedAt,
      promise: (async (): Promise<Settled<T>> => {
        let settled: Settled<T>;
        let outcome: RefreshOutcome;
        try {
          const value = await read();
          settled = { ok: true, value };
          outcome = "ok";
        } catch {
          settled = { ok: false };
          outcome = "error";
        }
        if (settled.ok) {
          const at = now();
          // Fail closed on a broken clock, and never let an older read
          // overwrite the value of a read that started after it.
          if (Number.isFinite(at) && (lastGood === undefined || seq > lastGood.seq)) {
            lastGood = { value: settled.value, at, seq };
          }
        }
        if (inFlight?.seq === seq) {
          inFlight = undefined;
        }
        if (onSettled !== undefined) {
          // A listener must never break the read or its waiters.
          try {
            onSettled(outcome, Math.round(now() - startedAt));
          } catch {
            // Logging is best-effort; the value stands.
          }
        }
        return settled;
      })(),
    };
    inFlight = task;
    return task;
  };

  return {
    async get(waitMs: number): Promise<T> {
      const t = now();
      if (lastGood !== undefined && Number.isFinite(t)) {
        if (t - lastGood.at >= lifetimeMs && current(t) === undefined) {
          // Stale value: keep serving it while a read refreshes it.
          beginRead();
        }
        return lastGood.value;
      }
      const task = current(t) ?? beginRead();
      const raced = await timeout(() => task.promise, waitMs);
      if (raced === TIMED_OUT || !raced.ok) {
        return fallback;
      }
      return raced.value;
    },
    start(): void {
      if (lastGood !== undefined) {
        return;
      }
      if (current(now()) !== undefined) {
        return;
      }
      beginRead();
    },
  };
}
