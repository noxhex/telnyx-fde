/**
 * Authentication for `POST /mcp` and `POST /internal/sessions` (ADR-008,
 * ADR-014; card T09): the token check runs before the SDK sees the request,
 * and authentication runs before any state access.
 *
 * `POST /mcp` needs `Authorization: Bearer <token>`. The token is verified
 * with `MCP_TOKEN_KEY` (read and parsed once per container, memoised in
 * index.ts), then the session behind its sid is loaded with `SESSION.get`.
 * A missing, invalid or expired token, or a missing or expired session,
 * answers HTTP 401 with a JSON-RPC error before any other state access. A
 * session read or a secret read that fails or times out answers HTTP 503,
 * because the call's tools cannot know who they are serving.
 *
 * Also home to the small helpers both routes share: bounded secret reads
 * and the constant-time internal-key compare.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { SessionDoc, Timings } from "@duinvezel/shared";
import { verifySessionToken } from "@duinvezel/shared";

import { SECRET_HANDLES, SECRET_READ_TIMEOUT_MS, TIMED_OUT, TIMEOUTS } from "./config.js";
import type { VoiceToolsDeps } from "./deps.js";

/** One bounded, timed secret read on the `http` hop; a timeout, a thrown error or an empty value count as a failed read. */
export async function readSecretTimed(
  deps: VoiceToolsDeps,
  timings: Timings,
  handle: string,
): Promise<string | null> {
  try {
    const raced = await timings.time("http", () =>
      deps.timeout(() => deps.secrets.get(handle), SECRET_READ_TIMEOUT_MS),
    );
    return raced === TIMED_OUT ? null : raced;
  } catch {
    return null;
  }
}

/** The same, for a secret that must parse as a base64url key (MCP_TOKEN_KEY). */
export async function readSecretKeyTimed(
  deps: VoiceToolsDeps,
  timings: Timings,
  handle: string,
): Promise<Uint8Array | null> {
  try {
    const raced = await timings.time("http", () =>
      deps.timeout(() => deps.secrets.getKey(handle), SECRET_READ_TIMEOUT_MS),
    );
    return raced === TIMED_OUT ? null : raced;
  } catch {
    return null;
  }
}

/** Constant-time compare over digests, so a length difference never throws. */
export function hasValidInternalKey(provided: string | null, expected: string | null): boolean {
  if (provided === null || expected === null) {
    return false;
  }
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export const UNAUTHORIZED_MESSAGE = "unauthorized";
export const UNAVAILABLE_MESSAGE = "service unavailable";

/** The JSON-RPC error body auth failures answer with, before the SDK or any state. */
export function jsonRpcErrorBody(message: string): {
  jsonrpc: "2.0";
  id: null;
  error: { code: number; message: string };
} {
  return { jsonrpc: "2.0", id: null, error: { code: -32000, message } };
}

export type AuthFailure =
  | {
      status: 401;
      reason:
        | "missing_token"
        | "malformed"
        | "bad_signature"
        | "expired"
        | "unsupported_version"
        | "session_missing";
    }
  | { status: 503; reason: "session_unavailable" | "secret_error" };

export type McpAuth =
  | { ok: true; session: SessionDoc }
  | ({ ok: false } & AuthFailure);

/**
 * Verifies the bearer token and loads the session behind it. The steps are
 * ordered so the answer depends on as little state as possible: the token
 * shape costs nothing, the key costs one memoised secret read, and only a
 * valid token pays for the actor round trip.
 */
export async function authenticateMcp(
  authorization: string | null,
  deps: VoiceToolsDeps,
  timings: Timings,
): Promise<McpAuth> {
  const match =
    authorization === null ? null : /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim());
  const token = match !== null ? match[1] : null;
  if (token === null) {
    return { ok: false, status: 401, reason: "missing_token" };
  }

  const tokenKey = await readSecretKeyTimed(deps, timings, SECRET_HANDLES.mcpTokenKey);
  if (tokenKey === null) {
    return { ok: false, status: 503, reason: "secret_error" };
  }

  const check = verifySessionToken(token, tokenKey, deps.now());
  if (!check.ok) {
    return { ok: false, status: 401, reason: check.reason };
  }

  let session: SessionDoc | null;
  try {
    const raced = await timings.time("actor", () =>
      deps.timeout(
        () => deps.sessions.get(check.claims.sid, { nowMs: deps.now() }),
        TIMEOUTS.sessionGetMs,
      ),
    );
    if (raced === TIMED_OUT) {
      return { ok: false, status: 503, reason: "session_unavailable" };
    }
    session = raced;
  } catch {
    return { ok: false, status: 503, reason: "session_unavailable" };
  }
  // The actor's get returns null for a session that is missing or expired.
  if (session === null) {
    return { ok: false, status: 401, reason: "session_missing" };
  }
  return { ok: true, session };
}
