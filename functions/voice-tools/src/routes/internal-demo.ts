/**
 * `/internal/demo/*` — the demo tooling (card T15): read and set the
 * feature flags, put simulated outage reports on an area, and reset the
 * demo state (the eight fixture accounts and the five areas) so the demo
 * can be repeated. The three routes sit behind `x-internal-key` like
 * `/internal/sessions` (ADR-014), checked in constant time before any state
 * access; a wrong or missing key answers 401. Actor calls carry the trace
 * id `demo-<request time in base 36>`, so their log lines — and the
 * `publish` lines the area alarms write after a reset — can be found. Every
 * request writes one `internal_demo` log line at the end.
 *
 * The KV hops here get 5,000 ms, because a KV write and read together took
 * up to 3.3 s in the health checks after the T20 ship. Each report and each
 * reset call gets 2,000 ms, so ten reports stay well inside the platform's
 * 30 s limit.
 */

import { z } from "zod";

import { AREAS, kvKeys, startTimings } from "@duinvezel/shared";
import type { Timings } from "@duinvezel/shared";

import { hasValidInternalKey, readSecretTimed } from "../auth.js";
import { SECRET_HANDLES, TIMED_OUT, TIMEOUTS } from "../config.js";
import type { VoiceToolsDeps } from "../deps.js";
import type { ReportResult, Symptom } from "../domain/area-incident.js";
import { readFlags } from "../flags.js";

const INTERNAL_KEY_HEADER = "x-internal-key";

type DemoRoute = "flags" | "reports" | "reset";

/** The fixture accounts the demo reset clears, DV-100001 to DV-100008 (mock-crm's fixtures). */
const FIXTURE_ACCOUNTS: readonly string[] = [
  "DV-100001",
  "DV-100002",
  "DV-100003",
  "DV-100004",
  "DV-100005",
  "DV-100006",
  "DV-100007",
  "DV-100008",
];

/**
 * The PUT flags body: known flags only, each a valid value or `null`, which
 * removes the key and brings back its default. A number parsed from JSON is
 * finite by construction, so `crm_delay_ms` needs no explicit finiteness
 * check. An unknown key or a bad value fails the whole body.
 */
const flagsPatchSchema = z.strictObject({
  crm_delay_ms: z.number().min(0).nullable().optional(),
  crm_fail: z.boolean().nullable().optional(),
  dv_force_error: z.boolean().nullable().optional(),
  diagnostics_enabled: z.boolean().nullable().optional(),
  incident_threshold: z.number().int().min(1).nullable().optional(),
  report_window_secs: z.number().int().min(1).nullable().optional(),
  incident_eta_minutes: z.number().int().min(1).nullable().optional(),
});

const reportsBodySchema = z.strictObject({
  postcode: z.string(),
  count: z.number().int().min(1).max(10),
  symptom: z.enum(["no_connection", "slow", "intermittent", "other"]).optional(),
});

/**
 * The constant-time key check, before any state access. Logs `auth_failed`
 * and returns false when the key is wrong, missing or unreadable; the
 * caller then answers 401 and does nothing else.
 */
async function passesInternalKey(
  req: Request,
  deps: VoiceToolsDeps,
  timings: Timings,
): Promise<boolean> {
  const internalKey = await readSecretTimed(deps, timings, SECRET_HANDLES.internalKey);
  if (hasValidInternalKey(req.headers.get(INTERNAL_KEY_HEADER), internalKey)) {
    return true;
  }
  deps.log.log("warn", "auth_failed", {
    route: "internal_demo",
    reason: internalKey === null ? "no_key" : "bad_key",
    user_agent: req.headers.get("user-agent"),
    status: 401,
    latency_ms: timings.snapshot(),
  });
  return false;
}

const unauthorized = (): Response => Response.json({ error: "unauthorized" }, { status: 401 });
const unavailable = (): { error: "unavailable" } => ({ error: "unavailable" });

/** One `internal_demo` line per request and the JSON answer, like /internal/sessions. */
function finish(
  deps: VoiceToolsDeps,
  timings: Timings,
  i: { route: DemoRoute; outcome: string; status: number; traceId: string | null; body: unknown },
): Response {
  deps.log.log(i.status >= 500 ? "error" : "info", "internal_demo", {
    route: i.route,
    outcome: i.outcome,
    status: i.status,
    trace_id: i.traceId,
    latency_ms: timings.snapshot(),
  });
  return Response.json(i.body, { status: i.status });
}

type FlagsRead = { ok: true; doc: unknown } | { ok: false };

/**
 * One bounded read of `flags/global` (5,000 ms). `telnyx-edge dev` has no
 * KV binding (DEBUGLOG issue 9), which counts as a failed read.
 */
async function readFlagsDoc(deps: VoiceToolsDeps, timings: Timings): Promise<FlagsRead> {
  const kv = deps.kv;
  if (kv === undefined) {
    return { ok: false };
  }
  try {
    const raced = await timings.time("kv", () =>
      deps.timeout(() => kv.get(kvKeys.flags(), { type: "json" }), TIMEOUTS.demoKvMs),
    );
    return raced === TIMED_OUT ? { ok: false } : { ok: true, doc: raced };
  } catch {
    return { ok: false };
  }
}

/** One bounded write of `flags/global` (5,000 ms). */
async function writeFlagsDoc(
  deps: VoiceToolsDeps,
  timings: Timings,
  doc: Record<string, unknown>,
): Promise<boolean> {
  const kv = deps.kv;
  if (kv === undefined) {
    return false;
  }
  try {
    const raced = await timings.time("kv", () =>
      deps.timeout(() => kv.put(kvKeys.flags(), JSON.stringify(doc)), TIMEOUTS.demoKvMs),
    );
    return raced !== TIMED_OUT;
  } catch {
    return false;
  }
}

/** `GET /internal/demo/flags` — the stored document, or `{}` when there is none. A failed read answers 503. */
export async function handleDemoFlagsGet(req: Request, deps: VoiceToolsDeps): Promise<Response> {
  const timings = startTimings(deps.now);
  if (!(await passesInternalKey(req, deps, timings))) {
    return unauthorized();
  }
  const read = await readFlagsDoc(deps, timings);
  if (!read.ok) {
    return finish(deps, timings, {
      route: "flags",
      outcome: "kv_error",
      status: 503,
      traceId: null,
      body: unavailable(),
    });
  }
  return finish(deps, timings, {
    route: "flags",
    outcome: "ok",
    status: 200,
    traceId: null,
    body: read.doc ?? {},
  });
}

/**
 * `PUT /internal/demo/flags` — merge a patch into the stored document and
 * answer the result; a stored value that is not a JSON object counts as
 * `{}`. A failed read or write answers 503, and a failed read writes
 * nothing.
 */
export async function handleDemoFlagsPut(req: Request, deps: VoiceToolsDeps): Promise<Response> {
  const timings = startTimings(deps.now);
  if (!(await passesInternalKey(req, deps, timings))) {
    return unauthorized();
  }
  let patch: z.infer<typeof flagsPatchSchema>;
  try {
    patch = flagsPatchSchema.parse(await req.json());
  } catch {
    return finish(deps, timings, {
      route: "flags",
      outcome: "bad_request",
      status: 400,
      traceId: null,
      body: { error: "bad_request" },
    });
  }
  const read = await readFlagsDoc(deps, timings);
  if (!read.ok) {
    return finish(deps, timings, {
      route: "flags",
      outcome: "kv_error",
      status: 503,
      traceId: null,
      body: unavailable(),
    });
  }
  const merged: Record<string, unknown> =
    read.doc !== null && typeof read.doc === "object" && !Array.isArray(read.doc)
      ? { ...(read.doc as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  // KV has no compare-and-swap, so two writes at once could lose one. That
  // is fine for one person setting flags by hand.
  if (!(await writeFlagsDoc(deps, timings, merged))) {
    return finish(deps, timings, {
      route: "flags",
      outcome: "kv_error",
      status: 503,
      traceId: null,
      body: unavailable(),
    });
  }
  return finish(deps, timings, {
    route: "flags",
    outcome: "ok",
    status: 200,
    traceId: null,
    body: merged,
  });
}

/** The answer for one simulated report, in the shape `report_outage` answers. */
function reportAnswer(r: ReportResult): Record<string, unknown> {
  return {
    reports_in_window: r.reportsInWindow,
    threshold: r.threshold,
    counted: r.counted,
    incident_declared: r.incidentDeclared,
    incident_id: r.incidentId,
    eta: r.eta,
  };
}

/**
 * `POST /internal/demo/reports` — `count` simulated reporters on one area,
 * one `AREA_INCIDENT.report` after the other, with the current flags'
 * threshold, window and ETA, as `report_outage` does. A failed or timed-out
 * report stops the run and answers 503 with the results so far.
 */
export async function handleDemoReports(req: Request, deps: VoiceToolsDeps): Promise<Response> {
  const timings = startTimings(deps.now);
  if (!(await passesInternalKey(req, deps, timings))) {
    return unauthorized();
  }
  let body: z.infer<typeof reportsBodySchema>;
  try {
    body = reportsBodySchema.parse(await req.json());
  } catch {
    return finish(deps, timings, {
      route: "reports",
      outcome: "bad_request",
      status: 400,
      traceId: null,
      body: { error: "bad_request" },
    });
  }
  if (!AREAS.some((area) => area.postcode === body.postcode)) {
    return finish(deps, timings, {
      route: "reports",
      outcome: "bad_request",
      status: 400,
      traceId: null,
      body: { error: "bad_request" },
    });
  }
  // SIM-<n>-<time>: <n> counts up from 1 and <time> is the request time in
  // base 36, so a second run adds new reporters instead of being deduped.
  const stamp = deps.now().toString(36);
  const traceId = `demo-${stamp}`;
  const symptom: Symptom = body.symptom ?? "no_connection";
  const flags = await readFlags(deps, timings);
  const results: Record<string, unknown>[] = [];
  const stop = (outcome: string): Response =>
    finish(deps, timings, { route: "reports", outcome, status: 503, traceId, body: { results } });
  for (let n = 1; n <= body.count; n++) {
    try {
      const raced = await timings.time("actor", () =>
        deps.timeout(
          () =>
            deps.areas.report(body.postcode, {
              accountId: `SIM-${String(n)}-${stamp}`,
              symptom,
              nowMs: deps.now(),
              threshold: flags.incidentThreshold,
              windowMs: flags.reportWindowSecs * 1_000,
              etaMs: flags.incidentEtaMinutes * 60_000,
              traceId,
            }),
          TIMEOUTS.demoReportMs,
        ),
      );
      if (raced === TIMED_OUT) {
        return stop("report_unavailable");
      }
      results.push(reportAnswer(raced));
    } catch {
      return stop("report_error");
    }
  }
  return finish(deps, timings, {
    route: "reports",
    outcome: "ok",
    status: 200,
    traceId,
    body: { results },
  });
}

/**
 * `POST /internal/demo/reset` — reset the eight fixture accounts and the
 * five areas. The thirteen calls run in parallel, each with its own
 * timeout, and one failure does not stop the others. The status is 200 when
 * all thirteen are `ok`, otherwise 500.
 */
export async function handleDemoReset(req: Request, deps: VoiceToolsDeps): Promise<Response> {
  const timings = startTimings(deps.now);
  if (!(await passesInternalKey(req, deps, timings))) {
    return unauthorized();
  }
  const traceId = `demo-${deps.now().toString(36)}`;
  const oneReset = async (call: () => Promise<unknown>): Promise<"ok" | "error"> => {
    try {
      const raced = await timings.time("actor", () =>
        deps.timeout(call, TIMEOUTS.demoResetMs),
      );
      return raced === TIMED_OUT ? "error" : "ok";
    } catch {
      return "error";
    }
  };
  const accounts: Record<string, "ok" | "error"> = {};
  const areas: Record<string, "ok" | "error"> = {};
  await Promise.all([
    ...FIXTURE_ACCOUNTS.map(async (accountNumber) => {
      accounts[accountNumber] = await oneReset(() => deps.accounts.reset(accountNumber, traceId));
    }),
    ...AREAS.map(async (area) => {
      areas[area.postcode] = await oneReset(() =>
        deps.areas.reset(area.postcode, { nowMs: deps.now(), traceId }),
      );
    }),
  ]);
  const allOk =
    Object.values(accounts).every((v) => v === "ok") &&
    Object.values(areas).every((v) => v === "ok");
  const status = allOk ? 200 : 500;
  return finish(deps, timings, {
    route: "reset",
    outcome: allOk ? "ok" : "error",
    status,
    traceId,
    body: { accounts, areas },
  });
}
