/**
 * voice-tools — the MCP server the assistant calls during a conversation
 * (`POST /mcp`, ADR-009), the internal session issuer (`POST
 * /internal/sessions`, for MCP Inspector, the canary and the demo scripts)
 * and liveness (`GET /healthz`). Routing only: strict method+path matching,
 * and anything unknown is a 404 before any KV or actor access (ADR-014,
 * DEBUGLOG issue 4).
 *
 * The one ADR-014 exception is the warm-up (T22, the exception Thiago
 * allowed for mock-crm on 12 October and extended to this function on 13
 * October, DEBUGLOG issue 17): a replica's first request of any kind —
 * unknown paths and requests that fail authentication included — starts the
 * reads of `MCP_TOKEN_KEY` and `INTERNAL_KEY` and the flags read together,
 * once per replica, and never waits for them. The reads change no state, so
 * a tool call that lands on a replica that has never read its secrets joins
 * reads already running instead of paying the 0.55 to 1.0+ s of first uses
 * inside its own bounded hops.
 *
 * The real dependencies are built from `env` here; the route handlers take
 * theirs as an argument so tests inject fakes. Per container, once at
 * module level: the logger, the area-status memory cache (ADR-019), the
 * refreshing flags value (T20), the shared secret store and the warm-up box
 * (T22). The secret store keeps a success for the container's life — a
 * success that lands after a request stopped waiting included — and keeps
 * nothing for a failed or empty read, so the next use reads again; while a
 * read is in flight every waiter shares it. The flags value serves its last
 * good parse with no wait and refreshes it in the background once its 10 s
 * lifetime has passed (DEBUGLOG issue 15). `telnyx-edge dev` has no secrets
 * and no KV (DEBUGLOG issue 9), so there a secret read resolves null and
 * the keyed routes fail closed — 401 on both — and the KV binding is
 * absent (`kv: undefined` in the deps, and no flags warm-up either).
 *
 * Every request writes exactly one log line: the route handlers write
 * theirs, and handleRequest writes the `healthz`, `method_not_allowed`
 * (GET /mcp is a 405) and `not_found` lines itself.
 */

// Re-export the actor classes from the entry point so they are bundled and
// shipped with the function; each exported name must equal its [[actors]]
// type in telnyx.toml.
export { AreaIncident } from "./actors/area-incident.js";
export { CustomerAccount } from "./actors/customer-account.js";
export { Session } from "./actors/session.js";

import { randomBytes } from "node:crypto";

import type { ActorNamespace, Env, KvNamespace, Secrets } from "@telnyx/edge-runtime";

import { createLogger, createMemoryCache, parseKey, SHARED_VERSION, startTimings } from "@duinvezel/shared";
import type { RefreshingValue } from "@duinvezel/shared";

import type { AreaStatusDoc } from "./area-status.js";
import { createAccountsClient } from "./clients/accounts.js";
import { createAreasClient } from "./clients/areas.js";
import { createCrmClient } from "./clients/crm.js";
import { createSessionsClient } from "./clients/sessions.js";
import { createFlagsValue } from "./flags.js";
import type { ToolsFlags } from "./flags.js";
import {
  AREA_CACHE_TTL_MS,
  realTimeoutRunner,
  SECRET_HANDLES,
  SERVICE_NAME,
} from "./config.js";
import type { CachesDep, SecretsDep, VoiceToolsDeps } from "./deps.js";
import { handleInternalSessions } from "./routes/internal-sessions.js";
import { handleMcp } from "./routes/mcp.js";

/** The bindings this function declares in telnyx.toml; KV and SECRETS are absent under `telnyx-edge dev`. */
export interface VoiceToolsEnv extends Env {
  KV?: KvNamespace;
  SECRETS?: Secrets;
  CUSTOMER_ACCOUNT: ActorNamespace;
  AREA_INCIDENT: ActorNamespace;
  SESSION: ActorNamespace;
}

export type RouteName =
  | "mcp"
  | "mcp_wrong_method"
  | "internal_sessions"
  | "healthz"
  | "not_found";

/** Strict routing: only the card's method+path pairs match. */
export function matchRoute(method: string, pathname: string): RouteName {
  if (pathname === "/mcp") {
    if (method === "POST") {
      return "mcp";
    }
    if (method === "GET") {
      return "mcp_wrong_method";
    }
    return "not_found";
  }
  if (method === "POST" && pathname === "/internal/sessions") {
    return "internal_sessions";
  }
  if (method === "GET" && pathname === "/healthz") {
    return "healthz";
  }
  return "not_found";
}

const logger = createLogger(SERVICE_NAME);

/** The per-container area-status memory cache, created once with the rest of the module (ADR-019). */
const areaCache = createMemoryCache<AreaStatusDoc | null>(AREA_CACHE_TTL_MS, () => Date.now());

const caches: CachesDep = { areas: areaCache };

/**
 * The latest env the platform handed us. The flags value's and the secret
 * store's reads close over it, because those reads only ever run while a
 * request — and with it an env — is on the go. Under `telnyx-edge dev`
 * there is no KV binding (DEBUGLOG issue 9), and no request gets the value
 * then.
 */
let currentEnv: VoiceToolsEnv | undefined;

function requireEnv(): VoiceToolsEnv {
  if (currentEnv === undefined) {
    throw new Error("voice-tools: no env is set yet");
  }
  return currentEnv;
}

/**
 * The container's refreshing `flags/global` value (T20), created once next
 * to the area cache. Every settled read writes one `flags_read` line, so
 * the logs show how long reads take and whether background refreshes
 * succeed, even when no tool call waited for them.
 */
const flagsValue: RefreshingValue<ToolsFlags> = createFlagsValue({
  kv: () => currentEnv?.KV,
  now: () => Date.now(),
  timeout: realTimeoutRunner,
  onSettled: (outcome, durationMs) => {
    logger.log("info", "flags_read", {
      outcome,
      latency_ms: { total: durationMs, kv: durationMs },
    });
  },
});

/**
 * The per-container secret reads (T22), the shape mock-crm has had since
 * T20, copied per function: a successful read is kept for the container's
 * life, including a success that lands after a request stopped waiting; a
 * thrown read or an empty value keeps nothing, so a later request reads
 * again. While a read is in flight every waiter shares it — nobody starts
 * a second one. The promise never rejects: failures resolve null, so the
 * fire-and-forget warm-up reads are safe.
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

/** Once-per-replica warm-up state (T22): the two secret reads and the flags read start on the first request of any kind. */
export interface WarmBox {
  warmed: boolean;
}

/**
 * What one container holds and a test can replace: the refreshing flags
 * value, the shared secret reads as the routes' `SecretsDep`, and the
 * warm-up box. index.ts builds one at module scope; tests build their own.
 */
export interface ContainerBox {
  flagsValue: RefreshingValue<ToolsFlags>;
  secrets: SecretsDep;
  warmBox: WarmBox;
}

/** Raw secret read: the typed binding first (a sidecar HTTP call), then the same-named environment variable; dev provides neither. */
async function resolveSecret(env: VoiceToolsEnv, handle: string): Promise<string | null> {
  if (env.SECRETS !== undefined) {
    try {
      const value = await env.SECRETS.get(handle);
      if (value.length > 0) {
        return value;
      }
    } catch {
      // Fall through to the environment variable.
    }
  }
  const fromEnv = process.env[handle];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : null;
}

const secretStore: SecretStore = createSecretStore((handle) =>
  resolveSecret(requireEnv(), handle),
);

/** Per-container parsed-key memo: successes only, so an unparseable read is retried on the next request. */
const secretKeyCache = new Map<string, Uint8Array>();

/**
 * The container's `SecretsDep` over the shared store: the raw text from the
 * store (waiters join a read in flight), and the parsed base64url key
 * memoised per handle. A parse failure keeps nothing — the raw text was a
 * successful read and stays kept, so a retry costs no second sidecar call.
 */
const containerSecrets: SecretsDep = {
  get: (handle) => secretStore.read(handle),
  async getKey(handle) {
    const hit = secretKeyCache.get(handle);
    if (hit !== undefined) {
      return hit;
    }
    const raw = await secretStore.read(handle);
    if (raw === null) {
      return null;
    }
    try {
      const bytes = parseKey(raw);
      secretKeyCache.set(handle, bytes);
      return bytes;
    } catch {
      return null;
    }
  },
};

/** Builds the production dependencies for one request. */
export function buildDeps(env: VoiceToolsEnv, box: ContainerBox): VoiceToolsDeps {
  return {
    now: () => Date.now(),
    kv: env.KV,
    sessions: createSessionsClient(env.SESSION),
    accounts: createAccountsClient(env.CUSTOMER_ACCOUNT),
    areas: createAreasClient(env.AREA_INCIDENT),
    crm: createCrmClient({
      crmUrl: process.env.CRM_URL ?? "",
      // T22: this read is no longer cut at SECRET_READ_TIMEOUT_MS. It joins
      // the warm-up's shared read and counts against the tool's own bound
      // (crmAccountMs on verify_account, which is sized for two cold first
      // uses in a row).
      readInternalKey: () => box.secrets.get(SECRET_HANDLES.internalKey),
      fetchImpl: fetch,
    }),
    caches,
    flagsValue: env.KV === undefined ? undefined : box.flagsValue,
    secrets: box.secrets,
    log: logger,
    random: (n) => randomBytes(n),
    timeout: realTimeoutRunner,
  };
}

/** The log line for the routes handleRequest answers itself: no state touched, one line each. */
function logSimple(event: string, req: Request, status: number, latency: Record<string, unknown>): void {
  logger.log("info", event, {
    method: req.method,
    path: new URL(req.url).pathname,
    status,
    latency_ms: latency,
  });
}

/**
 * One request through the container: the warm-up first (T22), then strict
 * routing. The warm-up's reads are fire-and-forget — the store and the
 * flags value keep whatever settles — and the swallowed rejection only
 * guards an injected double; the production store never rejects. There is
 * no flags warm-up without a KV binding (`telnyx-edge dev`), where no
 * request gets the flags value anyway.
 */
export async function handleRequest(
  req: Request,
  env: VoiceToolsEnv,
  box: ContainerBox,
): Promise<Response> {
  currentEnv = env;
  if (!box.warmBox.warmed) {
    box.warmBox.warmed = true;
    if (env.KV !== undefined) {
      box.flagsValue.start();
    }
    void box.secrets.get(SECRET_HANDLES.mcpTokenKey).catch(() => undefined);
    void box.secrets.get(SECRET_HANDLES.internalKey).catch(() => undefined);
  }
  const url = new URL(req.url);
  const route = matchRoute(req.method, url.pathname);
  switch (route) {
    case "healthz": {
      const timings = startTimings();
      const status = 200;
      logSimple("healthz", req, status, timings.snapshot());
      return Response.json({ ok: true, svc: SERVICE_NAME, shared: SHARED_VERSION }, { status });
    }
    case "mcp":
      return handleMcp(req, buildDeps(env, box));
    case "mcp_wrong_method": {
      const timings = startTimings();
      const status = 405;
      logSimple("method_not_allowed", req, status, timings.snapshot());
      // RFC 9110: a 405 must list the methods the resource supports.
      return Response.json(
        { error: "method_not_allowed" },
        { status, headers: { allow: "POST" } },
      );
    }
    case "internal_sessions":
      return handleInternalSessions(req, buildDeps(env, box));
    case "not_found": {
      const timings = startTimings();
      const status = 404;
      logSimple("not_found", req, status, timings.snapshot());
      return Response.json({ error: "not_found" }, { status });
    }
  }
}

/** The real container, created once with the rest of the module. */
const containerBox: ContainerBox = {
  flagsValue,
  secrets: containerSecrets,
  warmBox: { warmed: false },
};

export default {
  async fetch(req: Request, env: VoiceToolsEnv): Promise<Response> {
    return handleRequest(req, env, containerBox);
  },
};
