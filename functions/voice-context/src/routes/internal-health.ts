/**
 * `GET /internal/health` — the deep health check the canary runs against
 * voice-context every 30 seconds (ADR-017). It requires the internal key
 * before any state access, then runs four real checks in parallel, each
 * with its own timeout: a KV put+get round trip on `canary/probe`, a real
 * CRM customer lookup (not `/healthz`, which stays up under `crm_fail`),
 * `CUSTOMER_ACCOUNT.snapshot` on `CANARY-0`, and `SESSION.get` on the
 * all-zeros sid, which finds nothing and writes nothing. T10 records these
 * per-check latencies, so every check reports its own `latency_ms`.
 *
 * Any failed check turns the answer 503 with `ok: false`; the body always
 * names every check so the canary's alert can say which dependency died.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { Timings } from "@duinvezel/shared";
import { kvKeys, startTimings } from "@duinvezel/shared";

import {
  CANARY_ACCOUNT_NAME,
  CANARY_CRM_PHONE_DIGITS,
  CANARY_SESSION_SID,
  SECRET_HANDLES,
  TIMED_OUT,
  TIMEOUTS,
} from "../config.js";
import type { VoiceContextDeps } from "../deps.js";
import { readSecretTimed } from "./disclosure.js";

const INTERNAL_KEY_HEADER = "x-internal-key";
const CANARY_PROBE_TTL_SEC = 60;

export interface HealthCheckResult {
  ok: boolean;
  latency_ms: number;
}

/** Constant-time compare over digests, so a length difference never throws. */
function hasValidInternalKey(provided: string | null, expected: string | null): boolean {
  if (provided === null || expected === null) {
    return false;
  }
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

async function timedCheck(
  deps: VoiceContextDeps,
  run: () => Promise<boolean>,
): Promise<HealthCheckResult> {
  const startedAt = deps.now();
  try {
    const ok = await run();
    return { ok, latency_ms: Math.round(deps.now() - startedAt) };
  } catch {
    return { ok: false, latency_ms: Math.round(deps.now() - startedAt) };
  }
}

async function checkKv(deps: VoiceContextDeps, timings: Timings): Promise<HealthCheckResult> {
  return timedCheck(deps, async () => {
    const value = `probe-${String(deps.now())}`;
    const put = await timings.time("kv", () =>
      deps.timeout(
        () => deps.kv.put(kvKeys.canaryProbe(), value, { expirationTtl: CANARY_PROBE_TTL_SEC }),
        TIMEOUTS.health.kvPutMs,
      ),
    );
    if (put === TIMED_OUT) {
      return false;
    }
    const got = await timings.time("kv", () =>
      deps.timeout(() => deps.kv.get(kvKeys.canaryProbe()), TIMEOUTS.health.kvGetMs),
    );
    return got !== TIMED_OUT && got === value;
  });
}

async function checkCrm(deps: VoiceContextDeps, timings: Timings): Promise<HealthCheckResult> {
  return timedCheck(deps, async () => {
    const raced = await timings.time("crm", () =>
      deps.timeout(() => deps.crm.lookupByPhone(CANARY_CRM_PHONE_DIGITS), TIMEOUTS.health.crmMs),
    );
    // A 404 would be an answer, but DV-100002 (+3258000001) is a fixture, so
    // a healthy mock-crm returns the customer; anything else is a failure.
    return raced !== TIMED_OUT && raced.ok && raced.answer.kind === "customer";
  });
}

async function checkAccount(deps: VoiceContextDeps, timings: Timings): Promise<HealthCheckResult> {
  return timedCheck(deps, async () => {
    const raced = await timings.time("actor", () =>
      deps.timeout(() => deps.accounts.snapshot(CANARY_ACCOUNT_NAME), TIMEOUTS.health.actorMs),
    );
    return raced !== TIMED_OUT;
  });
}

async function checkSession(deps: VoiceContextDeps, timings: Timings): Promise<HealthCheckResult> {
  return timedCheck(deps, async () => {
    const raced = await timings.time("actor", () =>
      deps.timeout(
        () => deps.sessions.get(CANARY_SESSION_SID, { nowMs: deps.now() }),
        TIMEOUTS.health.actorMs,
      ),
    );
    return raced !== TIMED_OUT;
  });
}

export async function handleInternalHealth(
  req: Request,
  deps: VoiceContextDeps,
): Promise<Response> {
  const timings = startTimings(deps.now);

  const internalKey = await readSecretTimed(deps, timings, SECRET_HANDLES.internalKey);
  if (!hasValidInternalKey(req.headers.get(INTERNAL_KEY_HEADER), internalKey)) {
    deps.log.log("warn", "auth_failed", {
      route: "internal_health",
      reason: internalKey === null ? "no_key" : "bad_key",
      user_agent: req.headers.get("user-agent"),
      status: 401,
    });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const [kv, crm, account, session] = await Promise.all([
    checkKv(deps, timings),
    checkCrm(deps, timings),
    checkAccount(deps, timings),
    checkSession(deps, timings),
  ]);
  const checks = { kv, crm, customer_account: account, session };
  const ok = kv.ok && crm.ok && account.ok && session.ok;
  const status = ok ? 200 : 503;

  deps.log.log(ok ? "info" : "error", "health", {
    route: "internal_health",
    ok,
    status,
    checks,
    latency_ms: timings.snapshot(),
  });
  return Response.json({ ok, checks }, { status });
}
