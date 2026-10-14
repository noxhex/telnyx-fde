/**
 * `POST /dv` — the dynamic variables webhook on the call setup path, the
 * first link in every call's trace (`trace_id` is the call control id).
 * The steps follow card T08 and the budget in docs/ARCHITECTURE.md:
 *
 *   1. signature over the raw body against TELNYX_PUBLIC_KEY (the read
 *      waits up to 2,000 ms, T24; 403 `no_key` fails closed, before any KV
 *      or actor access);
 *   2. zod parse, `assistant.initialization` only (400 otherwise);
 *   3. sid = sessionIdFromCallControlId(call_control_id);
 *   4. both token keys, the flags, the CRM lookup and the five area
 *      statuses start together — the token keys cut to what remains of the
 *      soft budget like every other awaited wait here (T24), the flags
 *      from the container's refreshing value (T20), so only a container's
 *      first requests can wait for KV, the rest each inside its own
 *      timeout behind the memory caches. A caller with fewer than eight
 *      digits is anonymous without any lookup, like a caller with no phone
 *      at all (T22, DEBUGLOG issue 17), and so is a withheld number, which
 *      arrives as a missing or null end user target (T24);
 *   5. flags first — `dv_force_error` answers 500 before any state change;
 *   6/7. once the CRM lookup has answered: recordCall and SESSION.create
 *      run in parallel, awaited. The KV cache write (mock-crm answers
 *      only) starts here too, but the answer never waits for it (T24): it
 *      keeps its own 2,500 ms bound, uncut, and writes its own
 *      `crm_cache_write` log line when it settles, while the `dv` line's
 *      `cache_write` field just reads `started`;
 *   8. the whole request shares the 3,000 ms soft budget from the moment
 *      handleDv starts, before the body read and the signature check
 *      (T24) — every awaited timeout is cut to what remains, and whatever
 *      is still pending when it runs out is answered as its failure
 *      reason instead of awaited;
 *   9. token minted under MCP_TOKEN_KEY, encrypted under MCP_ENC_KEY;
 *  10. one response, values nested under `dynamic_variables`;
 *  11. one `dv` log line.
 */

import { z } from "zod";

import type { Timings } from "@duinvezel/shared";
import {
  AREAS,
  areaNameForPostcode,
  encryptForTelnyx,
  kvKeys,
  maskAccount,
  maskPhone,
  mintSessionToken,
  sessionIdFromCallControlId,
  startTimings,
} from "@duinvezel/shared";

import {
  CRM_KV_TTL_SEC,
  encodeCrmCacheValue,
  parseAreaStatus,
  parseCrmCacheValue,
  SECRET_HANDLES,
  SECRET_READ_TIMEOUT_MS,
  SESSION_TTL_MS,
  SOFT_BUDGET_MS,
  TIMED_OUT,
  TIMEOUTS,
} from "../config.js";
import type { AreaStatusDoc, CrmAnswer, DvFlags } from "../config.js";
import type { VoiceContextDeps } from "../deps.js";
import {
  badRequest,
  forbidden,
  logAuthFailed,
  readSecretKeyTimed,
  verifySignedRequest,
} from "./disclosure.js";

const dvBodySchema = z.object({
  data: z.object({
    event_type: z.literal("assistant.initialization"),
    payload: z.object({
      // T24: a withheld number arrives as a missing or null target; the
      // verified flag may be missing or null (counts as false).
      telnyx_end_user_target: z.string().nullish(),
      telnyx_agent_target: z.string(),
      call_control_id: z.string(),
      telnyx_conversation_channel: z.string(),
      telnyx_end_user_target_verified: z.boolean().nullish(),
    }),
  }),
});

/** The CRM lookup's end state: an answer plus where it came from, or why not. */
export type LookupOutcome =
  | { answer: CrmAnswer; source: "memory" | "kv" | "crm" }
  | { answer: null; reason: "timeout" | "error" | "no_phone" };

/** What one area read yields: the status, null when never published, undefined when unknown. */
export type AreaRead = AreaStatusDoc | null | undefined;

/** Cuts a call's own timeout to what remains of the soft budget (never negative). */
function cut(ownMs: number, budget: { startMs: number; deps: VoiceContextDeps }): number {
  const remaining = SOFT_BUDGET_MS - (budget.deps.now() - budget.startMs);
  return Math.max(0, Math.min(ownMs, remaining));
}

/**
 * The flags from the container's refreshing value (T20): a last good parse
 * answers at once and the request waits for nothing; while no read has ever
 * succeeded, the request waits for the read in flight, cut to what remains
 * of the soft budget (and never more than `TIMEOUTS.flagsMs`). The `kv` hop
 * here times only what the request itself waited — a late success still
 * becomes the last good value and applies to the next call.
 */
async function readFlags(
  deps: VoiceContextDeps,
  timings: Timings,
  budget: { startMs: number; deps: VoiceContextDeps },
): Promise<DvFlags> {
  return timings.time("kv", () => deps.flagsValue.get(cut(TIMEOUTS.flagsMs, budget)));
}

/** All five area statuses in parallel, each memory-cached; failed reads leave that area unknown and are never cached. */
async function readAreas(
  deps: VoiceContextDeps,
  timings: Timings,
  budget: { startMs: number; deps: VoiceContextDeps },
): Promise<ReadonlyMap<string, AreaRead>> {
  const entries = await Promise.all(
    AREAS.map(async (area): Promise<readonly [string, AreaRead]> => {
      const cached = deps.caches.areas.get(area.postcode);
      if (cached !== undefined) {
        return [area.postcode, cached] as const;
      }
      try {
        const raw = await timings.time("kv", () =>
          deps.timeout(
            () => deps.kv.get(kvKeys.areaStatus(area.postcode), { type: "json" }),
            cut(TIMEOUTS.areaStatusMs, budget),
          ),
        );
        if (raw === TIMED_OUT) {
          return [area.postcode, undefined] as const;
        }
        if (raw === null) {
          deps.caches.areas.set(area.postcode, null);
          return [area.postcode, null] as const;
        }
        const status = parseAreaStatus(raw);
        if (status === null) {
          return [area.postcode, undefined] as const;
        }
        deps.caches.areas.set(area.postcode, status);
        return [area.postcode, status] as const;
      } catch {
        return [area.postcode, undefined] as const;
      }
    }),
  );
  return new Map(entries);
}

/**
 * The CRM lookup: KV and mock-crm start together, the first usable answer
 * wins — a KV hit (customer or not-found marker) or a mock-crm answer
 * (200 customer, 404). A KV miss or a failed call is not an answer, so the
 * other side is still awaited; both settled without an answer is
 * `crm_error`, and the deadline winning is `crm_timeout`. Late settlements
 * are handled no-ops, never unhandled rejections. The mock-crm side carries
 * the `INTERNAL_KEY` read inside the same bound (T22: 2,000 ms covers a
 * cold key read and a cold mock-crm one after another, DEBUGLOG issue 17).
 */
async function lookupCaller(
  deps: VoiceContextDeps,
  timings: Timings,
  digits: string,
  budget: { startMs: number; deps: VoiceContextDeps },
): Promise<LookupOutcome> {
  const cached = deps.caches.crm.get(digits);
  if (cached !== undefined) {
    return { answer: cached, source: "memory" };
  }
  const combined = new Promise<LookupOutcome>((resolve) => {
    let done = false;
    let settled = 0;
    let failed = 0;
    const finish = (outcome: LookupOutcome): void => {
      if (!done) {
        done = true;
        resolve(outcome);
      }
    };
    const note = (sideFailed: boolean): void => {
      settled += 1;
      if (sideFailed) {
        failed += 1;
      }
      if (settled === 2 && failed > 0) {
        finish({ answer: null, reason: "error" });
      }
    };
    void timings
      .time("kv", () => deps.kv.get(kvKeys.crmPhone(digits), { type: "json" }))
      .then((raw) => {
        const answer = raw === null ? null : parseCrmCacheValue(raw);
        if (answer !== null) {
          finish({ answer, source: "kv" });
        } else {
          note(false);
        }
      })
      .catch(() => {
        note(true);
      });
    void timings
      .time("crm", () => deps.crm.lookupByPhone(digits))
      .then((result) => {
        if (result.ok) {
          finish({ answer: result.answer, source: "crm" });
        } else {
          note(true);
        }
      })
      .catch(() => {
        note(true);
      });
  });
  const raced = await deps.timeout(() => combined, cut(TIMEOUTS.crmLookupMs, budget));
  if (raced === TIMED_OUT) {
    return { answer: null, reason: "timeout" };
  }
  // Only answers are kept for 60 s — a customer or the not-found marker; a
  // timeout or an error is never cached, so the next request tries again.
  if (raced.answer !== null) {
    deps.caches.crm.set(digits, raced.answer);
  }
  return raced;
}

interface DvLogFields {
  traceId: string | null;
  /** `telnyx_conversation_channel` as received (T22), cut to 32 characters; null before the body parses. */
  channel: string | null;
  callerPhone: string | null;
  accountNumber: string | null;
  identity: string;
  area: string | null;
  areaOutage: boolean;
  repeatCaller: boolean;
  cache: "memory" | "kv" | "miss";
  /** `started` when the fire-and-forget CRM cache write began (T24); its own `crm_cache_write` line carries the outcome. */
  cacheWrite: "started" | null;
  outcome: "ok" | "degraded" | "error";
  reasons: string[];
  status: number;
}

/** The one `dv` log line per request, node `init` (docs/ARCHITECTURE.md, Observability). */
function logDv(deps: VoiceContextDeps, timings: Timings, fields: DvLogFields): void {
  deps.log.log(fields.status >= 500 ? "error" : "info", "dv", {
    trace_id: fields.traceId,
    node: "init",
    channel: fields.channel,
    caller: fields.callerPhone !== null ? maskPhone(fields.callerPhone) : null,
    account: fields.accountNumber !== null ? maskAccount(fields.accountNumber) : null,
    identity: fields.identity,
    area: fields.area,
    area_outage: fields.areaOutage ? "true" : "false",
    repeat_caller: fields.repeatCaller ? "true" : "false",
    cache: fields.cache,
    ...(fields.cacheWrite !== null ? { cache_write: fields.cacheWrite } : {}),
    outcome: fields.outcome,
    reasons: fields.reasons,
    status: fields.status,
    latency_ms: timings.snapshot(),
  });
}

export async function handleDv(req: Request, deps: VoiceContextDeps): Promise<Response> {
  const timings = startTimings(deps.now);
  // Step 8's budget starts at arrival (T24), before the body read and the
  // signature check, so a fresh replica's slow first reads can never push
  // the answer past it.
  const budget = { startMs: deps.now(), deps };

  const rawBody = await req.text();
  const signature = await verifySignedRequest(req, rawBody, deps, timings);
  if (!signature.ok) {
    logAuthFailed(deps, "dv", signature.reason, req);
    return forbidden();
  }

  let parsedBody: z.infer<typeof dvBodySchema>;
  try {
    parsedBody = dvBodySchema.parse(JSON.parse(rawBody));
  } catch {
    logDv(deps, timings, {
      traceId: null, channel: null, callerPhone: null, accountNumber: null, identity: "anonymous",
      area: null, areaOutage: false, repeatCaller: false, cache: "miss",
      cacheWrite: null, outcome: "error", reasons: ["bad_request"], status: 400,
    });
    return badRequest();
  }
  const payload = parsedBody.data.payload;

  // Step 3: ids. trace_id is the call control id; sid derives from it.
  const traceId = payload.call_control_id;
  const sid = sessionIdFromCallControlId(traceId);
  const channel = payload.telnyx_conversation_channel.slice(0, 32);
  const isPhoneCall = payload.telnyx_conversation_channel === "phone_call";
  // A withheld number arrives as a missing or null target (T24): no
  // callerPhone anywhere, like a call with no phone at all.
  const callerPhone =
    isPhoneCall && typeof payload.telnyx_end_user_target === "string"
      ? payload.telnyx_end_user_target
      : null;
  const digits = callerPhone === null ? null : callerPhone.replace(/\D/g, "");
  // A caller with too few digits to be a subscriber number is anonymous
  // without any lookup (T22): no mock-crm call and no `crm/phone/` key,
  // exactly the path a caller with no phone takes. A browser test call with
  // a stub caller once cached a 404 as "not found" (DEBUGLOG issue 17).
  const lookupDigits = digits !== null && digits.length >= 8 ? digits : null;

  // Step 4: both token keys, the flags, the CRM lookup and the five area
  // statuses start together — cold containers pay the sidecar reads here,
  // in parallel. The token keys are cut to what remains of the budget
  // (T24), like every other awaited wait in this route.
  const flagsPromise = readFlags(deps, timings, budget);
  const tokenKeyPromise = readSecretKeyTimed(
    deps,
    timings,
    SECRET_HANDLES.mcpTokenKey,
    cut(SECRET_READ_TIMEOUT_MS, budget),
  );
  const encKeyPromise = readSecretKeyTimed(
    deps,
    timings,
    SECRET_HANDLES.mcpEncKey,
    cut(SECRET_READ_TIMEOUT_MS, budget),
  );
  const lookupPromise: Promise<LookupOutcome> =
    lookupDigits === null
      ? Promise.resolve({ answer: null, reason: "no_phone" })
      : lookupCaller(deps, timings, lookupDigits, budget);
  const areasPromise = readAreas(deps, timings, budget);

  // Step 5: flags and token keys first, before anything changes state. A
  // forced error is test path E; a key that cannot be read fails closed.
  const flags = await flagsPromise;
  if (flags.dvForceError) {
    logDv(deps, timings, {
      traceId, channel, callerPhone, accountNumber: null, identity: "anonymous",
      area: null, areaOutage: false, repeatCaller: false, cache: "miss",
      cacheWrite: null, outcome: "error", reasons: ["dv_force_error"], status: 500,
    });
    return Response.json({ error: "dv_force_error" }, { status: 500 });
  }
  const [tokenKey, encKey] = await Promise.all([tokenKeyPromise, encKeyPromise]);
  if (tokenKey === null || encKey === null) {
    logDv(deps, timings, {
      traceId, channel, callerPhone, accountNumber: null, identity: "anonymous",
      area: null, areaOutage: false, repeatCaller: false, cache: "miss",
      cacheWrite: null, outcome: "error", reasons: ["secret_error"], status: 500,
    });
    return Response.json({ error: "secret_error" }, { status: 500 });
  }

  // Step 6: identity.
  const lookup = await lookupPromise;
  const reasons: string[] = [];
  if (lookup.answer === null && lookup.reason === "timeout") {
    reasons.push("crm_timeout");
  } else if (lookup.answer === null && lookup.reason === "error") {
    reasons.push("crm_error");
  }
  const customer = lookup.answer?.kind === "customer" ? lookup.answer.customer : null;
  // The log's cache field: only a memory or KV hit counts as a cache hit; a
  // lookup mock-crm had to answer is a miss that refilled the caches.
  const cacheSource: "memory" | "kv" | "miss" =
    lookup.answer === null || lookup.source === "crm" ? "miss" : lookup.source;
  const verified = payload.telnyx_end_user_target_verified === true;
  const identity =
    customer === null ? "anonymous" : verified ? "attested" : ("number_match" as const);
  const accountNumber = customer?.accountNumber ?? null;

  // Step 7: once the CRM lookup has answered, the state-changing calls run
  // in parallel, each cut to what remains of the budget.
  let repeatCaller = false;
  const recordCallPromise =
    customer === null
      ? Promise.resolve()
      : (async (): Promise<void> => {
          try {
            const raced = await timings.time("actor", () =>
              deps.timeout(
                () =>
                  deps.accounts.recordCall(
                    customer.accountNumber,
                    { callId: sid, nowMs: deps.now() },
                    traceId,
                  ),
                cut(TIMEOUTS.recordCallMs, budget),
              ),
            );
            if (raced === TIMED_OUT) {
              reasons.push("actor_timeout");
            } else {
              repeatCaller = raced.repeatCaller;
            }
          } catch {
            reasons.push("actor_error");
          }
        })();
  const sessionPromise = (async (): Promise<void> => {
    try {
      const raced = await timings.time("actor", () =>
        deps.timeout(
          () =>
            deps.sessions.create(sid, {
              traceId,
              identity,
              ...(customer !== null
                ? {
                    accountNumber: customer.accountNumber,
                    postcode: customer.postcode,
                    lineId: customer.lineId,
                  }
                : {}),
              ...(callerPhone !== null ? { callerPhone } : {}),
              nowMs: deps.now(),
            }),
          cut(TIMEOUTS.sessionCreateMs, budget),
        ),
      );
      if (raced === TIMED_OUT) {
        reasons.push("session_timeout");
      }
    } catch {
      reasons.push("session_error");
    }
  })();
  // The KV copy of a mock-crm answer starts here, but the answer never
  // waits for it (T24): it keeps its own 2,500 ms bound, uncut by the
  // budget, and writes its own `crm_cache_write` line when it settles. A
  // failing write can never reject anything or surface unhandled.
  const cacheWriteAnswer = lookup.answer !== null && lookup.source === "crm" ? lookup.answer : null;
  const cacheWrite: "started" | null =
    cacheWriteAnswer !== null && lookupDigits !== null ? "started" : null;
  if (cacheWriteAnswer !== null && lookupDigits !== null) {
    const answer = cacheWriteAnswer;
    const digitsKey = lookupDigits;
    void (async (): Promise<void> => {
      try {
        const raced = await timings.time("kv", () =>
          deps.timeout(
            () =>
              deps.kv.put(kvKeys.crmPhone(digitsKey), encodeCrmCacheValue(answer), {
                expirationTtl: CRM_KV_TTL_SEC,
              }),
            TIMEOUTS.crmCacheWriteMs,
          ),
        );
        deps.log.log(raced === TIMED_OUT ? "warn" : "info", "crm_cache_write", {
          trace_id: traceId,
          outcome: raced === TIMED_OUT ? "timeout" : "ok",
          latency_ms: timings.snapshot(),
        });
      } catch {
        deps.log.log("warn", "crm_cache_write", {
          trace_id: traceId,
          outcome: "failed",
          latency_ms: timings.snapshot(),
        });
      }
    })();
  }
  const [areas] = await Promise.all([areasPromise, recordCallPromise, sessionPromise]);

  // A caller in one of the five areas whose read failed or timed out may
  // have missed the outage notice — degraded, with a reason, even though
  // the variable can only safely say "false".
  const areaRead = customer === null ? undefined : areas.get(customer.postcode);
  if (
    customer !== null &&
    areaNameForPostcode(customer.postcode) !== null &&
    areaRead === undefined
  ) {
    reasons.push("area_unknown");
  }

  // Step 9: the per-call token from the keys read at step 4, two hours ahead.
  const token = mintSessionToken({ sid, exp: deps.now() + SESSION_TTL_MS }, tokenKey);
  const mcpToken = encryptForTelnyx(token, encKey, deps.random);

  // Step 10: the variables, every one a string.
  const areaOutage = areaRead !== undefined && areaRead !== null && areaRead.state === "outage";
  const outageEta = areaOutage ? (areaRead.eta ?? "as soon as possible") : "as soon as possible";
  const callerKnown = customer !== null;
  const dynamic_variables: Record<string, string> = {
    session_ok: "true",
    session_id: sid,
    greeting_line: callerKnown ? `Hi ${customer.firstName}` : "Hello",
    first_name: callerKnown ? customer.firstName : "unknown",
    caller_known: callerKnown ? "true" : "false",
    identity_level: identity,
    needs_verification: identity === "attested" ? "false" : "true",
    verify_mode: identity === "number_match" ? "postcode" : "full",
    area_code: callerKnown ? customer.postcode : "unknown",
    area_name: callerKnown ? customer.areaName : "your area",
    area_outage: areaOutage ? "true" : "false",
    outage_eta: outageEta,
    repeat_caller: repeatCaller ? "true" : "false",
    diagnostics_enabled: flags.diagnosticsEnabled ? "true" : "false",
  };

  // Step 11: the one log line.
  logDv(deps, timings, {
    traceId, channel, callerPhone, accountNumber, identity,
    area: customer?.postcode ?? null, areaOutage, repeatCaller,
    cache: cacheSource, cacheWrite,
    outcome: reasons.length === 0 ? "ok" : "degraded", reasons, status: 200,
  });
  return Response.json(
    { dynamic_variables, encrypted_dynamic_variables: { mcp_token: mcpToken } },
    { status: 200 },
  );
}
