/**
 * `POST /tools/disclosure` — the webhook behind the Route call tool node
 * (ADR-010). It records that the disclosure played; the workflow routes on
 * the call setup variables, never on this response, so a failure here must
 * never block a call: every outcome returns 200, and only a genuine log of
 * the disclosure turns `logged` true.
 *
 * Also exports the Telnyx signature check shared with `/dv`: raw body text
 * verified against `TELNYX_PUBLIC_KEY` before any parsing or state access
 * (ADR-014). A key that cannot be read fails the check with `no_key`, so
 * the route fails closed 403. Auth failures log `auth_failed` with the
 * reason and the user agent and touch neither KV nor an actor.
 */

import { z } from "zod";

import { startTimings, verifyTelnyxSignature } from "@duinvezel/shared";
import type { Timings } from "@duinvezel/shared";

import { SECRET_HANDLES, SECRET_READ_TIMEOUT_MS, TIMED_OUT, TIMEOUTS } from "../config.js";
import type { VoiceContextDeps } from "../deps.js";

const SID_PATTERN = /^[0-9a-f]{32}$/;

const bodySchema = z.object({ session_id: z.string() });

/**
 * One bounded, timed secret read: a sidecar HTTP call (DEBUGLOG issue 9) on
 * the `http` hop with a 2,000 ms timeout (T24). A timeout, a thrown error or
 * an empty value all count as a failed read (null) — the callers' memoised
 * stores keep successes only, so the next request tries again.
 */
export async function readSecretTimed(
  deps: VoiceContextDeps,
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

/**
 * The same, for a secret that must parse as a base64url key. `maxMs` lets
 * `/dv` cut the read to what remains of its soft budget (T24); every other
 * caller gets the full `SECRET_READ_TIMEOUT_MS`.
 */
export async function readSecretKeyTimed(
  deps: VoiceContextDeps,
  timings: Timings,
  handle: string,
  maxMs: number = SECRET_READ_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  try {
    const raced = await timings.time("http", () =>
      deps.timeout(() => deps.secrets.getKey(handle), maxMs),
    );
    return raced === TIMED_OUT ? null : raced;
  } catch {
    return null;
  }
}

export type SignatureOutcome = { ok: true } | { ok: false; reason: string };

/** Verifies the Telnyx signature over the raw body; `no_key` when the public key cannot be read. */
export async function verifySignedRequest(
  req: Request,
  rawBody: string,
  deps: VoiceContextDeps,
  timings: Timings,
): Promise<SignatureOutcome> {
  const publicKey = await readSecretTimed(deps, timings, SECRET_HANDLES.telnyxPublicKey);
  if (publicKey === null) {
    return { ok: false, reason: "no_key" };
  }
  const check = verifyTelnyxSignature({
    rawBody,
    signature: req.headers.get("telnyx-signature-ed25519"),
    timestamp: req.headers.get("telnyx-timestamp"),
    publicKey,
    nowMs: deps.now(),
  });
  return check.ok ? { ok: true } : { ok: false, reason: check.reason };
}

/** The one auth-failure line, written before any state access. */
export function logAuthFailed(
  deps: VoiceContextDeps,
  route: string,
  reason: string,
  req: Request,
): void {
  deps.log.log("warn", "auth_failed", {
    route,
    reason,
    user_agent: req.headers.get("user-agent"),
    status: 403,
  });
}

export const FORBIDDEN_BODY = { error: "forbidden" } as const;
export const BAD_REQUEST_BODY = { error: "bad_request" } as const;

export function forbidden(): Response {
  return Response.json(FORBIDDEN_BODY, { status: 403 });
}

export function badRequest(): Response {
  return Response.json(BAD_REQUEST_BODY, { status: 400 });
}

export async function handleDisclosure(req: Request, deps: VoiceContextDeps): Promise<Response> {
  const timings = startTimings(deps.now);

  const rawBody = await req.text();
  const signature = await verifySignedRequest(req, rawBody, deps, timings);
  if (!signature.ok) {
    logAuthFailed(deps, "disclosure", signature.reason, req);
    return forbidden();
  }

  // The tool node routes on variables, not on this response, so anything
  // that is not a valid sid answers 200 { logged: false } without an actor
  // call, logged with why (bad_request, invalid_sid, timeout, error).
  let sid: string | null = null;
  let outcome: string | null = null;
  try {
    const parsed = bodySchema.safeParse(JSON.parse(rawBody));
    if (parsed.success) {
      sid = parsed.data.session_id;
    } else {
      outcome = "bad_request";
    }
  } catch {
    outcome = "bad_request";
  }

  let logged = false;
  let traceId: string | null = null;
  if (outcome === null) {
    if (sid !== null && SID_PATTERN.test(sid)) {
      try {
        const raced = await timings.time("actor", () =>
          deps.timeout(() => deps.sessions.markDisclosure(sid, { nowMs: deps.now() }), TIMEOUTS.sessionDisclosureMs),
        );
        if (raced === TIMED_OUT) {
          outcome = "timeout";
        } else {
          outcome = raced.outcome;
          traceId = raced.traceId;
          logged = raced.outcome === "logged" || raced.outcome === "unchanged";
        }
      } catch {
        outcome = "error";
      }
    } else {
      outcome = "invalid_sid";
    }
  }

  deps.log.log("info", "disclosure", {
    node: "route_call",
    outcome,
    logged,
    trace_id: traceId,
    status: 200,
    latency_ms: timings.snapshot(),
  });
  return Response.json({ logged }, { status: 200 });
}
