/**
 * The types callers and the `Session` actor share (ADR-019, card T18).
 * `voice-context` (T08) and `voice-tools` (T09) call the actor through a
 * stub, so the shapes they send and get back live here, types only — the
 * rules themselves are in `functions/voice-tools/src/domain/session.ts`.
 *
 * One instance per call; the instance name is the sid (the first 32 hex
 * characters of the SHA-256 of the call control id, see kv-keys.ts). The
 * session expires two hours after creation (default TTL) and the actor's
 * alarm deletes the state at that point.
 */

export type IdentityLevel = "anonymous" | "number_match" | "attested" | "verified";

export interface SessionDoc {
  v: 1;
  sid: string;
  traceId: string;
  identity: IdentityLevel;
  accountNumber: string | null;
  postcode: string | null;
  lineId: string | null;
  callerPhone: string | null; // E.164, for callbacks
  createdAt: number;
  expiresAt: number;
  disclosedAt: number | null;
  verify: { failures: number; lockedUntil: number | null };
}

/** What a caller sends to create. The sid is the actor's instance name. */
export interface CreateSessionInput {
  traceId: string;
  identity: "anonymous" | "number_match" | "attested";
  accountNumber?: string;
  postcode?: string;
  lineId?: string;
  callerPhone?: string;
  nowMs: number;
  ttlMs?: number; // default two hours
}

export interface CreateSessionResult {
  created: boolean;
  session: SessionDoc;
}

export interface DisclosureResult {
  outcome: "logged" | "unchanged" | "missing";
  traceId: string | null;
}

export interface SetVerifiedResult {
  outcome: "verified" | "locked" | "missing";
  lockedUntil: number | null;
}

export interface VerifyFailureResult {
  outcome: "counted" | "locked" | "missing";
  attemptsLeft: number;
  lockedUntil: number | null;
}
