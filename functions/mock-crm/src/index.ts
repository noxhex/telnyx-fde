/**
 * mock-crm — the fake ISP back office. Routing only: strict method+path
 * matching, internal-key authentication before any state access (ADR-014),
 * the fault-injection flags, then the route module. One `crm_request` log
 * line per request, written however the request ends.
 *
 * Order of decisions for a request:
 *   0. warm-up — the container's first request of any kind, unknown paths
 *      and `/healthz` included, starts the `INTERNAL_KEY` read, the
 *      `DEMO_CALLER_PHONE` read and the flags read together, once per
 *      container, and never waits for them (T20; the one exception to
 *      ADR-014 that Thiago allowed on 12 October — the reads change no
 *      state). So a later keyed request joins reads already running;
 *   1. routing — unknown paths get a 404 immediately and `/healthz` a 200,
 *      without waiting for anything;
 *   2. auth — a keyed route waits for the shared `INTERNAL_KEY` read; a
 *      missing or wrong `x-internal-key` is a 401 without waiting for
 *      anything else (no flags, no handler);
 *   3. flags — from the container's refreshing flags value: a last good
 *      parse answers at once, otherwise the request waits within what
 *      remains of its window. `crm_fail` answers 503
 *      `{ "error": "unavailable" }`, then `crm_delay_ms` stalls every route
 *      except `/healthz`;
 *   4. the route handler — only `/customers` additionally waits for the
 *      shared `DEMO_CALLER_PHONE` read.
 *
 * A keyed request's waits share one window of `READ_WINDOW_MS`, which opens
 * when the request first waits for a read: the first keyed lookup on a new
 * container waits for the slowest of the warm-up reads, not their sum, and
 * never more than 1,000 ms in all (DEBUGLOG issue 15).
 */

import type { Env, KvNamespace, Secrets } from "@telnyx/edge-runtime";

import {
  createLogger,
  createRefreshingValue,
  maskAccount,
  maskPhone,
  startTimings,
} from "@duinvezel/shared";
import type { Fields, RefreshingValue, Timings } from "@duinvezel/shared";

import { hasValidInternalKey, INTERNAL_KEY_HEADER } from "./auth.js";
import {
  DEFAULT_FLAGS,
  FLAGS_CACHE_TTL_MS,
  realTimeoutRunner,
  readFlagsDocument,
  TIMED_OUT,
} from "./flags.js";
import type { CrmFlags, TimeoutRunner } from "./flags.js";
import { getAccount } from "./routes/accounts.js";
import { getCustomer } from "./routes/customers.js";
import { runLineTestRoute } from "./routes/lines.js";

const SERVICE_NAME = "mock-crm";

/**
 * One keyed request waits at most this long for everything it reads: the
 * window opens at the request's first wait and covers the `INTERNAL_KEY`
 * check, the flags and `DEMO_CALLER_PHONE` (T20).
 */
export const READ_WINDOW_MS = 1_000;

/** Kept under the old name: a single secret wait is bounded by the shared window. */
export const SECRET_READ_TIMEOUT_MS = READ_WINDOW_MS;

/** The two secrets keyed routes may need; both are warmed on a container's first request. */
const INTERNAL_KEY_HANDLE = "INTERNAL_KEY";
const DEMO_PHONE_HANDLE = "DEMO_CALLER_PHONE";

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

/**
 * The per-container secret reads (T20). A successful read is kept for the
 * container's life; a timeout, a thrown read or an empty value keeps
 * nothing, so a later request reads again. While a read is in flight every
 * waiter shares it — nobody starts a second one. The promise never rejects:
 * failures resolve null, so fire-and-forget warm-up reads are safe.
 */
export interface SecretStore {
  read(handle: string): Promise<string | null>;
}

export function createSecretStore(
  readSecret: (handle: string) => Promise<string | null>,
): SecretStore {
  const kept = new Map<string, string>();
  const inFlight = new Map<string, Promise<string | null>>();
  return {
    read(handle: string): Promise<string | null> {
      const hit = kept.get(handle);
      if (hit !== undefined) {
        return Promise.resolve(hit);
      }
      const current = inFlight.get(handle);
      if (current !== undefined) {
        return current;
      }
      const promise = (async (): Promise<string | null> => {
        try {
          const value = await readSecret(handle);
          if (value !== null && value.length > 0) {
            kept.set(handle, value);
          }
          return value;
        } catch {
          return null;
        } finally {
          inFlight.delete(handle);
        }
      })();
      inFlight.set(handle, promise);
      return promise;
    },
  };
}

/** Once-per-container warm-up state (T20): the three reads start on the first request of any kind. */
export interface WarmBox {
  warmed: boolean;
}

/** Everything `handleRequest` needs; tests inject fakes and stubs. */
export interface CrmDeps {
  /** Bounds every outbound wait (the shared read window). */
  timeout: TimeoutRunner;
  now: () => number;
  random: () => number;
  delay: (ms: number) => Promise<void>;
  log: ReturnType<typeof createLogger>;
  /** The container's refreshing `flags/global` value (T20). */
  flags: RefreshingValue<CrmFlags>;
  /** The container's shared secret reads. */
  secrets: SecretStore;
  warmBox: WarmBox;
}

export async function handleRequest(req: Request, deps: CrmDeps): Promise<Response> {
  const timings = startTimings(deps.now);

  // Warm-up: the container's first request starts the three reads together
  // and never waits for them. The flags value starts a read only when it
  // has no value and none in flight; the secret store likewise never
  // duplicates a read, so this is cheap on every later request.
  if (!deps.warmBox.warmed) {
    deps.warmBox.warmed = true;
    deps.flags.start();
    void deps.secrets.read(INTERNAL_KEY_HANDLE);
    void deps.secrets.read(DEMO_PHONE_HANDLE);
  }

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
    // The read window for this request: it opens at the first wait and
    // bounds every later wait to what remains.
    let windowStartMs: number | null = null;
    const remainingMs = (): number => {
      const t = deps.now();
      windowStartMs ??= t;
      return Math.max(0, READ_WINDOW_MS - (t - windowStartMs));
    };

    const internalKey = await readSecretWithin(deps, timings, INTERNAL_KEY_HANDLE, remainingMs);
    if (!hasValidInternalKey(req.headers.get(INTERNAL_KEY_HEADER), internalKey)) {
      status = 401;
      body = { error: "unauthorized" };
    } else {
      const flags: CrmFlags = await timings.time("kv", () =>
        deps.flags.get(remainingMs()),
      );
      if (flags.fail) {
        status = 503;
        body = { error: "unavailable" };
      } else {
        if (flags.delayMs > 0) {
          await deps.delay(flags.delayMs);
        }
        if (match.name === "customers") {
          const demoCallerPhone = await readSecretWithin(deps, timings, DEMO_PHONE_HANDLE, remainingMs);
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
 * One wait for a shared secret read, inside the `http` timing hop and
 * bounded by the request's remaining window. `TIMED_OUT`, an error or an
 * empty value all count as missing (null), so authentication still fails
 * closed — and since a failed read is never kept, a later request reads
 * again. A success that settles after the window closed is kept by the
 * store and serves the next request.
 */
async function readSecretWithin(
  deps: CrmDeps,
  timings: Timings,
  handle: string,
  remainingMs: () => number,
): Promise<string | null> {
  return timings.time("http", async () => {
    const raced = await deps.timeout(() => deps.secrets.read(handle), remainingMs());
    if (raced === TIMED_OUT || raced === null || raced.length === 0) {
      return null;
    }
    return raced;
  });
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
 * the secret store — the wait in `handleRequest` bounds it with a timeout),
 * then the same-named environment variable, the second production surface
 * the platform injects at deploy time. `telnyx-edge dev` delivers neither —
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

const logger = createLogger(SERVICE_NAME);

/**
 * The latest env the platform handed us: the module-scope container readers
 * (the flags value and the secret store) close over it, because their reads
 * only ever run while a request — and with it an env — is on the go. One
 * value per container per kind, created once with the rest of the module,
 * so a container's first requests are the only ones that ever wait
 * (DEBUGLOG issue 15).
 */
let currentEnv: CrmEnv | undefined;

function requireEnv(): CrmEnv {
  if (currentEnv === undefined) {
    throw new Error("mock-crm: no env is set yet");
  }
  return currentEnv;
}

const flagsValue: RefreshingValue<CrmFlags> = createRefreshingValue<CrmFlags>({
  read: () => readFlagsDocument(requireEnv().KV),
  lifetimeMs: FLAGS_CACHE_TTL_MS,
  fallback: DEFAULT_FLAGS,
  now: () => Date.now(),
  timeout: realTimeoutRunner,
  onSettled: (outcome, durationMs) => {
    logger.log("info", "flags_read", {
      outcome,
      latency_ms: { total: durationMs, kv: durationMs },
    });
  },
});

const secretStore: SecretStore = createSecretStore((handle) =>
  resolveSecret(requireEnv(), handle),
);

const warmBox: WarmBox = { warmed: false };

export default {
  async fetch(req: Request, env: CrmEnv): Promise<Response> {
    currentEnv = env;
    return handleRequest(req, {
      timeout: realTimeoutRunner,
      now: () => Date.now(),
      random: () => Math.random(),
      delay: (ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
      log: logger,
      flags: flagsValue,
      secrets: secretStore,
      warmBox,
    });
  },
};
