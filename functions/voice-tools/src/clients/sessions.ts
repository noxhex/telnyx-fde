/**
 * The Session actor client for voice-tools' own binding (T18, ADR-019):
 * one instance per call named by the sid. The wire shapes are the shared
 * session types, with the RPC input types from the actor class itself.
 * T09's `get` serves the MCP auth path and `create` serves
 * `/internal/sessions`; T19 adds `setVerified` and `recordVerifyFailure`
 * for `verify_account`. The state-changing methods pass the session's
 * `traceId` through, so the actor's log lines join the call's trace
 * (docs/ARCHITECTURE.md, Observability).
 */

import type { ActorNamespace } from "@telnyx/edge-runtime";

import type {
  CreateSessionInput,
  CreateSessionResult,
  SessionDoc,
  SetVerifiedResult,
  VerifyFailureResult,
} from "@duinvezel/shared";

import type { RecordVerifyFailureInput, SetVerifiedInput } from "../actors/session.js";

export interface SessionsClient {
  create(sid: string, input: CreateSessionInput): Promise<CreateSessionResult>;
  /** The live session, or null when missing or expired; writes nothing. */
  get(sid: string, input: { nowMs: number }): Promise<SessionDoc | null>;
  /** Promote the session to `verified` after a successful `CUSTOMER_ACCOUNT.verify`. */
  setVerified(sid: string, input: SetVerifiedInput, traceId: string): Promise<SetVerifiedResult>;
  /** Count a verification failure for an account number that does not exist. */
  recordVerifyFailure(
    sid: string,
    input: RecordVerifyFailureInput,
    traceId: string,
  ): Promise<VerifyFailureResult>;
}

interface SessionRpc {
  create(input: CreateSessionInput): Promise<CreateSessionResult>;
  get(input: { nowMs: number }): Promise<SessionDoc | null>;
  setVerified(input: SetVerifiedInput, traceId?: string): Promise<SetVerifiedResult>;
  recordVerifyFailure(
    input: RecordVerifyFailureInput,
    traceId?: string,
  ): Promise<VerifyFailureResult>;
}

export function createSessionsClient(namespace: ActorNamespace): SessionsClient {
  const stubFor = (sid: string): SessionRpc => namespace.idFromName(sid) as unknown as SessionRpc;
  return {
    create(sid, input) {
      return stubFor(sid).create(input);
    },
    get(sid, input) {
      return stubFor(sid).get(input);
    },
    setVerified(sid, input, traceId) {
      return stubFor(sid).setVerified(input, traceId);
    },
    recordVerifyFailure(sid, input, traceId) {
      return stubFor(sid).recordVerifyFailure(input, traceId);
    },
  };
}
