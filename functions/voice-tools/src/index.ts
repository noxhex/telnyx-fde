/**
 * voice-tools — the MCP server the assistant calls during a conversation
 * (`POST /mcp`, ADR-009), the internal session issuer (`POST
 * /internal/sessions`, for MCP Inspector, the canary and the demo scripts)
 * and liveness (`GET /healthz`). Routing only: strict method+path matching
 * first, and anything unknown is a 404 before any secret, KV or actor
 * access (ADR-014, DEBUGLOG issue 4).
 *
 * The real dependencies are built from `env` here; the route handlers take
 * theirs as an argument so tests inject fakes. Per container, once at
 * module level: the logger, the area-status memory cache (ADR-019) and the
 * secret memo maps. Secrets are read on first use and kept for the
 * container's lifetime; a failed read is not kept, so the next request
 * tries again (and the parsed key cache fails closed too). `telnyx-edge
 * dev` has no secrets and no KV (DEBUGLOG issue 9), so there a secret read
 * resolves null and the keyed routes fail closed — 401 on both — and the
 * KV binding is absent (`kv: undefined` in the deps).
 *
 * Every request writes exactly one log line: the route handlers write
 * theirs, and index.ts writes the `healthz`, `method_not_allowed` (GET
 * /mcp is a 405) and `not_found` lines itself.
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

import type { AreaStatusDoc } from "./area-status.js";
import { createAccountsClient } from "./clients/accounts.js";
import { createAreasClient } from "./clients/areas.js";
import { createCrmClient } from "./clients/crm.js";
import { createSessionsClient } from "./clients/sessions.js";
import type { ToolsFlags } from "./flags.js";
import {
  AREA_CACHE_TTL_MS,
  FLAG_CACHE_TTL_MS,
  realTimeoutRunner,
  SECRET_READ_TIMEOUT_MS,
  SERVICE_NAME,
  TIMED_OUT,
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

/** The per-container flags memory cache, created once next to the area cache (ADR-019, T19). */
const flagsCache = createMemoryCache<ToolsFlags>(FLAG_CACHE_TTL_MS, () => Date.now());

const caches: CachesDep = { areas: areaCache, flags: flagsCache };

/** Per-container secret memo: successes only, so a failed read is retried on the next request. */
const secretTextCache = new Map<string, string>();
const secretKeyCache = new Map<string, Uint8Array>();

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

function createSecretStore(env: VoiceToolsEnv): SecretsDep {
  const get = async (handle: string): Promise<string | null> => {
    const hit = secretTextCache.get(handle);
    if (hit !== undefined) {
      return hit;
    }
    const value = await resolveSecret(env, handle);
    if (value !== null) {
      secretTextCache.set(handle, value);
    }
    return value;
  };
  const getKey = async (handle: string): Promise<Uint8Array | null> => {
    const hit = secretKeyCache.get(handle);
    if (hit !== undefined) {
      return hit;
    }
    const raw = await get(handle);
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
  };
  return { get, getKey };
}

/** Builds the production dependencies for one request. */
export function buildDeps(env: VoiceToolsEnv): VoiceToolsDeps {
  const secrets = createSecretStore(env);
  return {
    now: () => Date.now(),
    kv: env.KV,
    sessions: createSessionsClient(env.SESSION),
    accounts: createAccountsClient(env.CUSTOMER_ACCOUNT),
    areas: createAreasClient(env.AREA_INCIDENT),
    crm: createCrmClient({
      crmUrl: process.env.CRM_URL ?? "",
      readInternalKey: async () => {
        // Bounded like every secret read; a timeout is a failed read and
        // the CRM call is never made.
        const raced = await realTimeoutRunner(
          () => secrets.get("INTERNAL_KEY"),
          SECRET_READ_TIMEOUT_MS,
        );
        return raced === TIMED_OUT ? null : raced;
      },
      fetchImpl: fetch,
    }),
    caches,
    secrets,
    log: logger,
    random: (n) => randomBytes(n),
    timeout: realTimeoutRunner,
  };
}

/** The log line for the routes index.ts answers itself: no state touched, one line each. */
function logSimple(event: string, req: Request, status: number, latency: Record<string, unknown>): void {
  logger.log("info", event, {
    method: req.method,
    path: new URL(req.url).pathname,
    status,
    latency_ms: latency,
  });
}

export default {
  async fetch(req: Request, env: VoiceToolsEnv): Promise<Response> {
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
        return handleMcp(req, buildDeps(env));
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
        return handleInternalSessions(req, buildDeps(env));
      case "not_found": {
        const timings = startTimings();
        const status = 404;
        logSimple("not_found", req, status, timings.snapshot());
        return Response.json({ error: "not_found" }, { status });
      }
    }
  },
};
