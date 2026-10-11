/**
 * `POST /internal/sessions` — creates a session and returns a bearer token
 * for it, for MCP Inspector, the canary and the demo scripts (card T09).
 * It needs the internal key header, checked in constant time before any
 * actor call (ADR-014). The session is created through `SESSION.create` on
 * a fresh random sid (32 lowercase hex characters from the injected
 * randomness — the same shape `sessionIdFromCallControlId` produces for
 * real calls), with `traceId` `internal-<sid>` so its log lines join one
 * internal trace. The token is minted under `MCP_TOKEN_KEY` with the
 * session's two-hour expiry.
 *
 * A secret the container cannot read answers 503 before any state is
 * created; an actor call that fails or times out answers 503 too, because
 * a token to a session that does not exist is worth less than no token.
 * One `internal_sessions` log line per request, never holding the token;
 * every line written after the sid exists carries it as `trace_id`
 * `internal-<sid>`, so the create joins its own trace (ARCHITECTURE,
 * Observability).
 */

import { z } from "zod";

import { mintSessionToken, startTimings } from "@duinvezel/shared";

import {
  hasValidInternalKey,
  readSecretKeyTimed,
  readSecretTimed,
} from "../auth.js";
import { SECRET_HANDLES, SESSION_TTL_MS, TIMED_OUT, TIMEOUTS } from "../config.js";
import type { VoiceToolsDeps } from "../deps.js";

const INTERNAL_KEY_HEADER = "x-internal-key";

const bodySchema = z.object({
  identity: z.enum(["anonymous", "number_match", "attested"]),
  accountNumber: z.string().optional(),
  postcode: z.string().optional(),
  lineId: z.string().optional(),
  callerPhone: z.string().optional(),
});

type Outcome = "ok" | "bad_request" | "secret_error" | "session_unavailable" | "session_error";

export async function handleInternalSessions(
  req: Request,
  deps: VoiceToolsDeps,
): Promise<Response> {
  const timings = startTimings(deps.now);

  const internalKey = await readSecretTimed(deps, timings, SECRET_HANDLES.internalKey);
  if (!hasValidInternalKey(req.headers.get(INTERNAL_KEY_HEADER), internalKey)) {
    deps.log.log("warn", "auth_failed", {
      route: "internal_sessions",
      reason: internalKey === null ? "no_key" : "bad_key",
      user_agent: req.headers.get("user-agent"),
      status: 401,
      latency_ms: timings.snapshot(),
    });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  const finish = (
    outcome: Outcome,
    status: number,
    responseBody: unknown,
    traceId: string | null,
  ): Response => {
    deps.log.log(status >= 500 ? "error" : "info", "internal_sessions", {
      outcome,
      status,
      ...(traceId !== null ? { trace_id: traceId } : {}),
      latency_ms: timings.snapshot(),
    });
    return Response.json(responseBody, { status });
  };
  const unavailable = (): { error: "unavailable" } => ({ error: "unavailable" });

  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return finish("bad_request", 400, { error: "bad_request" }, null);
  }

  // The sid exists from here on, so every later log line joins its trace.
  // Its generation is local work, not a state access: the internal-key
  // check above still gates every actor call, and the token-key read below
  // still runs before `SESSION.create`.
  const sid = Buffer.from(deps.random(16)).toString("hex");
  const traceId = `internal-${sid}`;

  // The token key is read before the actor call: if it cannot be read, no
  // session is created for a token we cannot mint.
  const tokenKey = await readSecretKeyTimed(deps, timings, SECRET_HANDLES.mcpTokenKey);
  if (tokenKey === null) {
    return finish("secret_error", 503, unavailable(), traceId);
  }

  try {
    const raced = await timings.time("actor", () =>
      deps.timeout(
        () =>
          deps.sessions.create(sid, {
            traceId,
            identity: body.identity,
            ...(body.accountNumber !== undefined ? { accountNumber: body.accountNumber } : {}),
            ...(body.postcode !== undefined ? { postcode: body.postcode } : {}),
            ...(body.lineId !== undefined ? { lineId: body.lineId } : {}),
            ...(body.callerPhone !== undefined ? { callerPhone: body.callerPhone } : {}),
            nowMs: deps.now(),
          }),
        TIMEOUTS.sessionCreateMs,
      ),
    );
    if (raced === TIMED_OUT) {
      return finish("session_unavailable", 503, unavailable(), traceId);
    }
  } catch {
    return finish("session_error", 503, unavailable(), traceId);
  }

  const token = mintSessionToken({ sid, exp: deps.now() + SESSION_TTL_MS }, tokenKey);
  return finish("ok", 200, { token, sid }, traceId);
}
