/**
 * mock-crm — the fake ISP back office. Routing only: strict method+path
 * matching, internal-key authentication before any state access (ADR-014),
 * the fault-injection flags, then the route module. One `crm_request` log
 * line per request, written however the request ends.
 *
 * Order of decisions for a request:
 *   1. routing — unknown paths get a 404 immediately: no KV, no secrets
 *      (`env.SECRETS.get` is an HTTP call to the sidecar, so reading a
 *      secret costs a network hop only matched routes should pay for);
 *   2. the secret read — a matched route reads `INTERNAL_KEY` after routing
 *      and before auth, bounded by `SECRET_READ_TIMEOUT_MS`; a secret that
 *      cannot be read in time counts as missing, so auth fails closed 401;
 *   3. auth — a missing or wrong `x-internal-key` is a 401 before anything
 *      else happens (no KV, no flags, no handler);
 *   4. flags — `crm_fail` answers 503 `{ "error": "unavailable" }`, then
 *      `crm_delay_ms` stalls every route except `/healthz`;
 *   5. the route handler — only `/customers` additionally reads
 *      `DEMO_CALLER_PHONE` (timed, and only here).
 * `/healthz` skips all of it: no secret, no flags, no KV, so the health
 * check works while the CRM is made slow or broken on purpose.
 */

import type { Env, KvNamespace, Secrets } from "@telnyx/edge-runtime";

import {
  createLogger,
  maskAccount,
  maskPhone,
  startTimings,
} from "@duinvezel/shared";
import type { Fields, Timings } from "@duinvezel/shared";

import { hasValidInternalKey, INTERNAL_KEY_HEADER } from "./auth.js";
import { getFlags, realTimeoutRunner, TIMED_OUT } from "./flags.js";
import type { CrmFlags, FlagsCacheBox, TimeoutRunner } from "./flags.js";
import { getAccount } from "./routes/accounts.js";
import { getCustomer } from "./routes/customers.js";
import { runLineTestRoute } from "./routes/lines.js";

const SERVICE_NAME = "mock-crm";

/** A secret read is one HTTP hop to the sidecar; bound it like the KV hop. */
export const SECRET_READ_TIMEOUT_MS = 300;

/** The bindings this function declares in telnyx.toml. */
export interface CrmEnv extends Env {
  KV: KvNamespace;
  SECRETS: Secrets;
}

type RouteName = "healthz" | "customers" | "accounts" | "line_test" | "not_found";

interface RouteMatch {
  name: RouteName;
  /** Path parameter for `/accounts/<id>` and `/lines/<id>/test`. */
  param: string | null;
}

/** Strict routing: only the known method+path pairs match. */
export function matchRoute(method: string, pathname: string): RouteMatch {
  if (method === "GET" && pathname === "/healthz") {
    return { name: "healthz", param: null };
  }
  if (method === "GET" && pathname === "/customers") {
    return { name: "customers", param: null };
  }
  if (method === "GET" && pathname.startsWith("/accounts/")) {
    return { name: "accounts", param: pathname.slice("/accounts/".length) };
  }
  if (
    method === "POST" &&
    pathname.startsWith("/lines/") &&
    pathname.endsWith("/test")
  ) {
    return { name: "line_test", param: pathname.slice("/lines/".length, -"/test".length) };
  }
  return { name: "not_found", param: null };
}

/** Everything `handleRequest` needs; tests inject fakes and stubs. */
export interface CrmDeps {
  kv: KvNamespace;
  /**
   * Reads one secret by handle (raw: no timeout in here — `handleRequest`
   * bounds every read with `timeout`). Null or empty means missing.
   */
  readSecret: (handle: string) => Promise<string | null>;
  /** Bounds every outbound call (flags KV read, secret reads). */
  timeout: TimeoutRunner;
  now: () => number;
  random: () => number;
  delay: (ms: number) => Promise<void>;
  log: ReturnType<typeof createLogger>;
  flagsCache: FlagsCacheBox;
}

export async function handleRequest(req: Request, deps: CrmDeps): Promise<Response> {
  const timings = startTimings(deps.now);
  const url = new URL(req.url);
  const match = matchRoute(req.method, url.pathname);
  let status: number;
  let body: Record<string, unknown>;
  let caller: string | null = null;
  let account: string | null = null;

  if (match.name === "not_found") {
    status = 404;
    body = { error: "not_found" };
  } else if (match.name === "healthz") {
    status = 200;
    body = { ok: true, svc: SERVICE_NAME };
  } else {
    const internalKey = await readSecretTimed(deps, timings, "INTERNAL_KEY");
    if (!hasValidInternalKey(req.headers.get(INTERNAL_KEY_HEADER), internalKey)) {
      status = 401;
      body = { error: "unauthorized" };
    } else {
      const flags: CrmFlags = await timings.time("kv", () =>
        getFlags(deps.kv, deps.now, deps.flagsCache, deps.timeout),
      );
      if (flags.fail) {
        status = 503;
        body = { error: "unavailable" };
      } else {
        if (flags.delayMs > 0) {
          await deps.delay(flags.delayMs);
        }
        if (match.name === "customers") {
          const demoCallerPhone = await readSecretTimed(deps, timings, "DEMO_CALLER_PHONE");
          const outcome = getCustomer(url.searchParams, demoCallerPhone);
          ({ status, body } = outcome);
          caller = outcome.callerPhone;
        } else if (match.name === "accounts") {
          const outcome = getAccount(match.param ?? "");
          ({ status, body } = outcome);
          account = outcome.accountNumber;
        } else {
          const outcome = await runLineTestRoute(match.param ?? "", deps);
          ({ status, body } = outcome);
          account = outcome.accountNumber;
        }
      }
    }
  }

  logRequest(deps, match.name, status, caller, account, timings.snapshot());
  return Response.json(body, { status });
}

/**
 * One bounded secret read: `TIMED_OUT`, a thrown error or an empty value all
 * count as missing (null), so authentication still fails closed when the
 * secret store cannot answer in time. The read is wrapped in the `http`
 * timing hop so the request log carries its latency like any other
 * outbound call.
 */
async function readSecretTimed(
  deps: CrmDeps,
  timings: Timings,
  handle: string,
): Promise<string | null> {
  try {
    const value = await timings.time("http", () =>
      deps.timeout(() => deps.readSecret(handle), SECRET_READ_TIMEOUT_MS),
    );
    if (value === TIMED_OUT || value === null || value.length === 0) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** The one log line per request. */
function logRequest(
  deps: CrmDeps,
  route: RouteName,
  status: number,
  caller: string | null,
  account: string | null,
  latencyMs: Record<string, unknown>,
): void {
  const fields: Fields = { route, status, latency_ms: latencyMs };
  if (caller !== null) {
    fields.caller = maskPhone(caller);
  }
  if (account !== null) {
    fields.account = maskAccount(account);
  }
  deps.log.log(status >= 500 ? "error" : "info", "crm_request", fields);
}

/**
 * Raw secret read for production: the typed binding first (an HTTP call to
 * the secret store — `handleRequest` bounds it with a timeout), then the
 * same-named environment variable, the second production surface the
 * platform injects at deploy time. `telnyx-edge dev` delivers neither —
 * verified on CLI v0.5.10: no secrets emulation and no environment variable
 * passthrough — so this returns null there and keyed routes answer 401.
 */
async function resolveSecret(env: CrmEnv, handle: string): Promise<string | null> {
  try {
    const value = await env.SECRETS.get(handle);
    if (value.length > 0) {
      return value;
    }
  } catch {
    // Fall through to the environment variable.
  }
  const fromEnv = process.env[handle];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : null;
}

/** Flags cache for the life of this module instance (per container). */
const flagsCache: FlagsCacheBox = { current: null };

export default {
  async fetch(req: Request, env: CrmEnv): Promise<Response> {
    return handleRequest(req, {
      kv: env.KV,
      readSecret: (handle) => resolveSecret(env, handle),
      timeout: realTimeoutRunner,
      now: () => Date.now(),
      random: () => Math.random(),
      delay: (ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
      log: createLogger(SERVICE_NAME),
      flagsCache,
    });
  },
};
