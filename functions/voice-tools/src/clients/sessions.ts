/**
 * The Session actor client for voice-tools' own binding (T18, ADR-019):
 * one instance per call named by the sid. The wire shapes are the shared
 * session types. Only what T09 needs for now — `get` for the MCP auth path
 * and `create` for `/internal/sessions`; T19 extends this client.
 */

import type { ActorNamespace } from "@telnyx/edge-runtime";

import type { CreateSessionInput, CreateSessionResult, SessionDoc } from "@duinvezel/shared";

export interface SessionsClient {
  create(sid: string, input: CreateSessionInput): Promise<CreateSessionResult>;
  /** The live session, or null when missing or expired; writes nothing. */
  get(sid: string, input: { nowMs: number }): Promise<SessionDoc | null>;
}

interface SessionRpc {
  create(input: CreateSessionInput): Promise<CreateSessionResult>;
  get(input: { nowMs: number }): Promise<SessionDoc | null>;
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
  };
}
