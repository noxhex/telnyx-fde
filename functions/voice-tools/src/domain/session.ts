/**
 * Session domain — the pure rules behind the per-call actor (ADR-019,
 * card T18). One session per sid: call setup creates it once, every MCP
 * call reads it, the Route call tool marks the disclosure, `verify_account`
 * sets the verified identity, and verification guesses against account
 * numbers that do not exist are counted and locked here (they have no
 * account to live on).
 *
 * Everything here is pure: state and input in, new state and a result out.
 * No clock, no I/O — callers inject `nowMs`. Time inputs fail closed: a
 * `nowMs`, `ttlMs` or `lockMs` that is not a finite number, a `ttlMs` or
 * `lockMs` that is not above zero, or a `maxFailures` that is not a
 * positive whole number throws a RangeError instead of producing a decision
 * on a broken clock (AGENTS.md, Time inputs fail closed). A `sid` that is
 * not 32 lowercase hex characters throws a RangeError too, so an instance
 * with any other name can never hold a session.
 *
 * Live or gone: a session is live while `nowMs` is before `expiresAt` and
 * expired from that instant on, the same rule as the token's `exp` (T04).
 * Every function treats an expired session exactly like a missing one.
 * Unchanged means the same object: a function that changes nothing returns
 * the very object it was given as `state`, and no function mutates its
 * input, so the actor can skip the write on an unchanged result.
 */

import type {
  CreateSessionInput,
  CreateSessionResult,
  DisclosureResult,
  SessionDoc,
  SetVerifiedResult,
  VerifyFailureResult,
} from "@duinvezel/shared";

/** Sessions die two hours after creation unless the caller sets `ttlMs`. */
export const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_FAILURES = 3;
export const DEFAULT_LOCK_MS = 15 * 60 * 1000;

const SID_PATTERN = /^[0-9a-f]{32}$/;

/** The one lifecycle rule, shared by every function here and the alarm. */
export function isLive(s: SessionDoc | null, nowMs: number): s is SessionDoc {
  return s !== null && nowMs < s.expiresAt;
}

function requireFiniteMs(fn: string, field: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${fn}: ${field} must be a finite number, got ${String(value)}`);
  }
}

function requirePositiveMs(fn: string, field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `${fn}: ${field} must be a finite number above zero, got ${String(value)}`,
    );
  }
}

function requirePositiveInt(fn: string, field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${fn}: ${field} must be a positive whole number, got ${String(value)}`);
  }
}

function requireSid(sid: string): void {
  if (!SID_PATTERN.test(sid)) {
    throw new RangeError(
      `create: sid must be 32 lowercase hex characters, got ${JSON.stringify(sid)}`,
    );
  }
}

/**
 * Start a session when there is none or the stored one has expired.
 * `createdAt` is `nowMs`, `expiresAt` is `nowMs + ttlMs`, missing optional
 * fields become `null`, and there is no disclosure and no failures. For a
 * live session nothing changes — the stored session comes back with
 * `created: false` whatever the input says, so a retried webhook never
 * resets the identity, the disclosure or the failures (ADR-015).
 */
export function create(
  s: SessionDoc | null,
  i: CreateSessionInput & { sid: string },
): { state: SessionDoc; result: CreateSessionResult } {
  requireFiniteMs("create", "nowMs", i.nowMs);
  const ttlMs = i.ttlMs ?? DEFAULT_TTL_MS;
  requirePositiveMs("create", "ttlMs", ttlMs);
  requireSid(i.sid);

  if (isLive(s, i.nowMs)) {
    return { state: s, result: { created: false, session: s } };
  }

  const session: SessionDoc = {
    v: 1,
    sid: i.sid,
    traceId: i.traceId,
    identity: i.identity,
    accountNumber: i.accountNumber ?? null,
    postcode: i.postcode ?? null,
    lineId: i.lineId ?? null,
    callerPhone: i.callerPhone ?? null,
    createdAt: i.nowMs,
    expiresAt: i.nowMs + ttlMs,
    disclosedAt: null,
    verify: { failures: 0, lockedUntil: null },
  };
  return { state: session, result: { created: true, session } };
}

/** The live session, or `null` when there is none or it has expired. */
export function get(s: SessionDoc | null, nowMs: number): SessionDoc | null {
  requireFiniteMs("get", "nowMs", nowMs);
  return isLive(s, nowMs) ? s : null;
}

/**
 * Record that the disclosure played. The first call sets `disclosedAt` to
 * `nowMs` (`logged`); later calls keep that first time (`unchanged`). The
 * result carries the session's trace id so the caller can log it — the
 * webhook behind the Route call tool knows only the sid. A missing or
 * expired session answers `missing` and changes nothing.
 */
export function markDisclosure(
  s: SessionDoc | null,
  i: { nowMs: number },
): { state: SessionDoc | null; result: DisclosureResult } {
  requireFiniteMs("markDisclosure", "nowMs", i.nowMs);
  if (!isLive(s, i.nowMs)) {
    return { state: s, result: { outcome: "missing", traceId: null } };
  }
  if (s.disclosedAt !== null) {
    return { state: s, result: { outcome: "unchanged", traceId: s.traceId } };
  }
  return {
    state: { ...s, disclosedAt: i.nowMs },
    result: { outcome: "logged", traceId: s.traceId },
  };
}

/**
 * Promote the session to `verified` with the account number, postcode and
 * line id the caller proved, replacing whatever account it had. While the
 * verify lock is active nothing changes and the answer is `locked` with
 * `lockedUntil`. A missing or expired session answers `missing` and changes
 * nothing.
 */
export function setVerified(
  s: SessionDoc | null,
  i: { accountNumber: string; postcode: string; lineId: string; nowMs: number },
): { state: SessionDoc | null; result: SetVerifiedResult } {
  requireFiniteMs("setVerified", "nowMs", i.nowMs);
  if (!isLive(s, i.nowMs)) {
    return { state: s, result: { outcome: "missing", lockedUntil: null } };
  }
  if (s.verify.lockedUntil !== null && s.verify.lockedUntil > i.nowMs) {
    return { state: s, result: { outcome: "locked", lockedUntil: s.verify.lockedUntil } };
  }
  return {
    state: {
      ...s,
      identity: "verified",
      accountNumber: i.accountNumber,
      postcode: i.postcode,
      lineId: i.lineId,
    },
    result: { outcome: "verified", lockedUntil: null },
  };
}

/**
 * Count one failed verification for an account number that does not exist
 * (T09): the guess has no CustomerAccount actor, so the session carries
 * it. While the lock is active nothing changes and the answer is `locked`.
 * Otherwise the failure is added; reaching `maxFailures` sets `lockedUntil`
 * to `nowMs + lockMs`, restarts the counter at zero and answers `locked`,
 * and below that the answer is `counted`. `attemptsLeft` is what remains
 * before a lock, and 0 while locked. The lock is active while `nowMs` is
 * before `lockedUntil`; from that instant on it counts as no lock and
 * failures count from zero again. A missing or expired session answers
 * `missing` and changes nothing.
 */
export function recordVerifyFailure(
  s: SessionDoc | null,
  i: { nowMs: number; maxFailures?: number; lockMs?: number },
): { state: SessionDoc | null; result: VerifyFailureResult } {
  requireFiniteMs("recordVerifyFailure", "nowMs", i.nowMs);
  const maxFailures = i.maxFailures ?? DEFAULT_MAX_FAILURES;
  const lockMs = i.lockMs ?? DEFAULT_LOCK_MS;
  requirePositiveInt("recordVerifyFailure", "maxFailures", maxFailures);
  requirePositiveMs("recordVerifyFailure", "lockMs", lockMs);

  if (!isLive(s, i.nowMs)) {
    return { state: s, result: { outcome: "missing", attemptsLeft: 0, lockedUntil: null } };
  }
  if (s.verify.lockedUntil !== null && s.verify.lockedUntil > i.nowMs) {
    return {
      state: s,
      result: { outcome: "locked", attemptsLeft: 0, lockedUntil: s.verify.lockedUntil },
    };
  }

  const failures = s.verify.failures + 1;
  if (failures >= maxFailures) {
    const lockedUntil = i.nowMs + lockMs;
    return {
      state: { ...s, verify: { failures: 0, lockedUntil } },
      result: { outcome: "locked", attemptsLeft: 0, lockedUntil },
    };
  }
  return {
    state: { ...s, verify: { failures, lockedUntil: null } },
    result: { outcome: "counted", attemptsLeft: maxFailures - failures, lockedUntil: null },
  };
}
