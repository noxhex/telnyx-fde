/**
 * The Session shared-actor client, same hand-rolled narrowing as
 * clients/accounts.ts: voice-context ships no class and reaches the one
 * voice-tools ships through the `SESSION` binding, one instance per call
 * named by the sid. The wire shapes are the shared session types (T18).
 */

import type { ActorNamespace } from "@telnyx/edge-runtime";

import type {
  CreateSessionInput,
  CreateSessionResult,
  DisclosureResult,
  SessionDoc,
} from "@duinvezel/shared";

export interface SessionsClient {
  create(sid: string, input: CreateSessionInput): Promise<CreateSessionResult>;
  markDisclosure(sid: string, input: { nowMs: number }): Promise<DisclosureResult>;
  /** The canary's deep health check: a get on a sid that finds nothing and writes nothing. */
  get(sid: string, input: { nowMs: number }): Promise<SessionDoc | null>;
}

interface SessionRpc {
  create(input: CreateSessionInput): Promise<CreateSessionResult>;
  markDisclosure(input: { nowMs: number }): Promise<DisclosureResult>;
  get(input: { nowMs: number }): Promise<SessionDoc | null>;
}

export function createSessionsClient(namespace: ActorNamespace): SessionsClient {
  const stubFor = (sid: string): SessionRpc =>
    namespace.idFromName(sid) as unknown as SessionRpc;
  return {
    create(sid, input) {
      return stubFor(sid).create(input);
    },
    markDisclosure(sid, input) {
      return stubFor(sid).markDisclosure(input);
    },
    get(sid, input) {
      return stubFor(sid).get(input);
    },
  };
}
