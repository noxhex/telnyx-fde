/**
 * CustomerAccount domain — the pure rules behind the per-account actor
 * (ADR-006): repeat-caller detection over a 24-hour window, verification
 * with a failure lockout (ADR-013), and idempotent ticket creation
 * (ADR-015).
 *
 * Everything here is pure: state and input in, new state and a result out.
 * No clock, no I/O, no randomness — callers inject `nowMs`. Time inputs
 * fail closed: a non-finite `nowMs` or `lockMs`, or a `maxFailures` that is
 * not a positive whole number, throws a RangeError instead of producing a
 * decision on a broken clock (AGENTS.md, Time inputs fail closed).
 */

export type TicketCategory = "repair_visit" | "callback" | "other";

export interface CustomerAccountState {
  v: 1;
  calls: { id: string; at: number }[];
  verify: { failures: number; lockedUntil: number | null };
  tickets: {
    id: string;
    dedupeKey: string;
    category: TicketCategory;
    summary: string;
    createdAt: number;
    window: string;
  }[];
}

export interface RecordCallInput {
  callId: string;
  nowMs: number;
}

export interface RecordCallResult {
  callCount24h: number;
  repeatCaller: boolean;
  lockedUntil: number | null;
}

export interface VerifyInput {
  mode: "full" | "postcode";
  submitted: { postcode: string; accountNumber?: string };
  expected: { postcode: string; accountNumber: string };
  nowMs: number;
  maxFailures?: number;
  lockMs?: number;
}

export type VerifyOutcome = "ok" | "wrong" | "locked";

export interface VerifyResult {
  outcome: VerifyOutcome;
  attemptsLeft: number;
  lockedUntil: number | null;
}

export interface CreateTicketInput {
  dedupeKey: string;
  ticketId: string;
  category: TicketCategory;
  summary: string;
  nowMs: number;
  window: string;
}

export interface CreateTicketResult {
  ticketId: string;
  created: boolean;
  window: string;
}

/** A call drops out of the sliding window once it is strictly older than 24 h, so a call exactly 24 h old still counts. */
export const CALL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The caller counts as a repeat caller from their third call in 24 h. */
export const REPEAT_CALLER_THRESHOLD = 3;
export const DEFAULT_MAX_FAILURES = 3;
export const DEFAULT_LOCK_MS = 15 * 60 * 1000;
export const SUMMARY_MAX_CHARS = 300;

export function initialState(): CustomerAccountState {
  return {
    v: 1,
    calls: [],
    verify: { failures: 0, lockedUntil: null },
    tickets: [],
  };
}

function requireFiniteMs(fn: string, field: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${fn}: ${field} must be a finite number, got ${String(value)}`);
  }
}

function requirePositiveInt(fn: string, field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${fn}: ${field} must be a positive whole number, got ${String(value)}`);
  }
}

/** Trim, uppercase and remove all whitespace: `" 8 6 3 0 "` → `"8630"`, `"dv-100001"` → `"DV-100001"`. */
function normalise(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * Record one call in the 24-hour window. Calls strictly older than the
 * window drop out; a call exactly 24 hours old still counts. A call id
 * that is already in the window is ignored, so Telnyx webhook retries
 * never count twice. `repeatCaller` fires from the third call in the
 * window, this one included.
 */
export function recordCall(
  s: CustomerAccountState,
  i: RecordCallInput,
): { state: CustomerAccountState; result: RecordCallResult } {
  requireFiniteMs("recordCall", "nowMs", i.nowMs);
  const fresh = s.calls.filter((c) => i.nowMs - c.at <= CALL_WINDOW_MS);
  const seen = fresh.some((c) => c.id === i.callId);
  const calls = seen ? fresh : [...fresh, { id: i.callId, at: i.nowMs }];
  const callCount24h = calls.length;
  return {
    state: { ...s, calls },
    result: {
      callCount24h,
      repeatCaller: callCount24h >= REPEAT_CALLER_THRESHOLD,
      lockedUntil: s.verify.lockedUntil,
    },
  };
}

/**
 * Check submitted details against the CRM's expected values. While a lock
 * is in the future the answer is `locked` and nothing is compared or
 * changed — not even correct details get through. Otherwise values are
 * compared normalised, postcode-only in `postcode` mode. Success resets the
 * failure counter; a failure increments it, and reaching `maxFailures`
 * locks the account for `lockMs` and restarts the counter at zero, so the
 * caller gets a fresh set of attempts when the lock lifts.
 */
export function verify(
  s: CustomerAccountState,
  i: VerifyInput,
): { state: CustomerAccountState; result: VerifyResult } {
  requireFiniteMs("verify", "nowMs", i.nowMs);
  const maxFailures = i.maxFailures ?? DEFAULT_MAX_FAILURES;
  const lockMs = i.lockMs ?? DEFAULT_LOCK_MS;
  requirePositiveInt("verify", "maxFailures", maxFailures);
  requireFiniteMs("verify", "lockMs", lockMs);

  if (s.verify.lockedUntil !== null && s.verify.lockedUntil > i.nowMs) {
    return {
      state: s,
      result: { outcome: "locked", attemptsLeft: 0, lockedUntil: s.verify.lockedUntil },
    };
  }

  const postcodeOk = normalise(i.submitted.postcode) === normalise(i.expected.postcode);
  const accountOk =
    i.mode === "postcode" ||
    normalise(i.submitted.accountNumber ?? "") === normalise(i.expected.accountNumber);

  if (postcodeOk && accountOk) {
    return {
      state: { ...s, verify: { failures: 0, lockedUntil: null } },
      result: { outcome: "ok", attemptsLeft: maxFailures, lockedUntil: null },
    };
  }

  const failures = s.verify.failures + 1;
  if (failures >= maxFailures) {
    const lockedUntil = i.nowMs + lockMs;
    return {
      state: { ...s, verify: { failures: 0, lockedUntil } },
      result: { outcome: "wrong", attemptsLeft: 0, lockedUntil },
    };
  }
  return {
    state: { ...s, verify: { failures, lockedUntil: null } },
    result: { outcome: "wrong", attemptsLeft: maxFailures - failures, lockedUntil: null },
  };
}

/**
 * Lift a lock whose time has come or passed. Only the lock is cleared: the
 * failure count is left alone. An unlocked account comes back untouched, so
 * running it twice is safe.
 */
export function clearExpiredLock(s: CustomerAccountState, nowMs: number): CustomerAccountState {
  requireFiniteMs("clearExpiredLock", "nowMs", nowMs);
  if (s.verify.lockedUntil === null || s.verify.lockedUntil > nowMs) {
    return s;
  }
  return { ...s, verify: { ...s.verify, lockedUntil: null } };
}

/**
 * Create a ticket, idempotently per dedupe key (ADR-015). The key is
 * opaque to the domain and is stored and matched exactly as passed; by
 * convention callers build it as `sessionId|category`, so a repair visit
 * and a callback for the same call are separate tickets while a retry of
 * either dedupes to the ticket it created. A duplicate returns the
 * existing ticket with `created: false` and appends nothing. The summary
 * is truncated at 300 characters.
 */
export function createTicket(
  s: CustomerAccountState,
  i: CreateTicketInput,
): { state: CustomerAccountState; result: CreateTicketResult } {
  requireFiniteMs("createTicket", "nowMs", i.nowMs);
  const existing = s.tickets.find((t) => t.dedupeKey === i.dedupeKey);
  if (existing !== undefined) {
    return {
      state: s,
      result: { ticketId: existing.id, created: false, window: existing.window },
    };
  }
  const ticket = {
    id: i.ticketId,
    dedupeKey: i.dedupeKey,
    category: i.category,
    summary: i.summary.slice(0, SUMMARY_MAX_CHARS),
    createdAt: i.nowMs,
    window: i.window,
  };
  return {
    state: { ...s, tickets: [...s.tickets, ticket] },
    result: { ticketId: ticket.id, created: true, window: ticket.window },
  };
}
