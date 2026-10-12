/**
 * voice-context — the call setup webhook (`POST /dv`), the webhook behind
 * the Route call tool node (`POST /tools/disclosure`), the canary's deep
 * health check (`GET /internal/health`) and liveness (`GET /healthz`).
 * Routing only: strict method+path matching first, and anything unknown is
 * a 404 before any secret, KV or actor access (ADR-014, DEBUGLOG issue 4).
 *
 * The real dependencies are built from `env` here; the route handlers take
 * theirs as an argument so tests inject fakes (card T08, Design for
 * testing). Per container, once at module level: the logger, the memory
 * caches for area statuses and CRM answers (ADR-019), the refreshing flags
 * value (T20) and the secret memo maps. Secrets are read on first use and
 * kept for the container's lifetime; a failed read is not kept, so the next
 * request tries again (and the parsed key caches fail closed too). The
 * flags value serves its last good parse with no wait and refreshes it in
 * the background once its 10 s lifetime has passed, so only a container's
 * first requests can wait for KV (DEBUGLOG issue 15). `telnyx-edge dev`
 * has no secrets or KV (DEBUGLOG issue 9),
 * so there a secret read resolves null and the keyed routes fail closed —
 * 403 on `/dv` (no public key), 401 on `/internal/health`.
 */

import { randomBytes } from "node:crypto";

import type { ActorNamespace, Env, KvNamespace, Secrets } from "@telnyx/edge-runtime";

import {
  createLogger,
  createMemoryCache,
  createRefreshingValue,
  kvKeys,
  parseKey,
  SHARED_VERSION,
} from "@duinvezel/shared";
import type { RefreshingValue } from "@duinvezel/shared";

import { createAccountsClient } from "./clients/accounts.js";
import { createCrmClient } from "./clients/crm.js";
import { createSessionsClient } from "./clients/sessions.js";
import {
  CACHE_TTL_MS,
  DEFAULT_FLAGS,
  parseFlags,
  realTimeoutRunner,
  SECRET_READ_TIMEOUT_MS,
  TIMED_OUT,
} from "./config.js";
import type { AreaStatusDoc, CrmAnswer, DvFlags } from "./config.js";
import type { CachesDep, SecretsDep, VoiceContextDeps } from "./deps.js";
import { handleDisclosure } from "./routes/disclosure.js";
import { handleDv } from "./routes/dv.js";
import { handleInternalHealth } from "./routes/internal-health.js";

const SERVICE_NAME = "voice-context";

/** The bindings this function declares in telnyx.toml. */
export interface VoiceContextEnv extends Env {
  KV: KvNamespace;
  CUSTOMER_ACCOUNT: ActorNamespace;
  SESSION: ActorNamespace;
  SECRETS: Secrets;
}

export type RouteName = "dv" | "disclosure" | "internal_health" | "healthz" | "not_found";

/** Strict routing: only the known method+path pairs match. */
export function matchRoute(method: string, pathname: string): RouteName {
  if (method === "POST" && pathname === "/dv") {
    return "dv";
  }
  if (method === "POST" && pathname === "/tools/disclosure") {
    return "disclosure";
  }
  if (method === "GET" && pathname === "/internal/health") {
    return "internal_health";
  }
  if (method === "GET" && pathname === "/healthz") {
    return "healthz";
  }
  return "not_found";
}

const logger = createLogger(SERVICE_NAME);

/** Per-container memory caches, created once with the rest of the module. */
const caches: CachesDep = {
  areas: createMemoryCache<AreaStatusDoc | null>(CACHE_TTL_MS.areasMs, () => Date.now()),
  crm: createMemoryCache<CrmAnswer>(CACHE_TTL_MS.crmMs, () => Date.now()),
};

/**
 * The latest env the platform handed us. The flags value's read closes over
 * it, because that read only ever runs while a request — and with it an
 * env — is on the go.
 */
let currentEnv: VoiceContextEnv | undefined;

/**
 * The container's refreshing `flags/global` value (T20, DEBUGLOG issue 15):
 * one per container, next to the other caches. A read that resolves is a
 * successful read — a missing key parses to the defaults and counts as an
 * answer like any other; only a KV error is a failed read and keeps
 * nothing. Every settled read writes one `flags_read` line, so the logs
 * show how long reads take and whether background refreshes succeed, even
 * when no request waited for them.
 */
const flagsValue: RefreshingValue<DvFlags> = createRefreshingValue<DvFlags>({
  read: async (): Promise<DvFlags> => {
    if (currentEnv === undefined) {
      throw new Error("voice-context: no env is set yet");
    }
    return parseFlags(await currentEnv.KV.get(kvKeys.flags(), { type: "json" }));
  },
  lifetimeMs: CACHE_TTL_MS.flagsMs,
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

/** Per-container secret memo: successes only, so a failed read is retried on the next request. */
const secretTextCache = new Map<string, string>();
const secretKeyCache = new Map<string, Uint8Array>();

/**
 * Raw secret read for production: the typed binding first (a sidecar HTTP
 * call), then the same-named environment variable (secrets also arrive as
 * env vars). `telnyx-edge dev` provides neither, so this returns null.
 */
async function resolveSecret(env: VoiceContextEnv, handle: string): Promise<string | null> {
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

function createSecretStore(env: VoiceContextEnv): SecretsDep {
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

/** Builds the production dependencies for one matched route. */
export function buildDeps(env: VoiceContextEnv): VoiceContextDeps {
  const secrets = createSecretStore(env);
  return {
    now: () => Date.now(),
    kv: env.KV,
    crm: createCrmClient({
      crmUrl: process.env.CRM_URL ?? "",
      readInternalKey: async () => {
        // The one secret read outside a route's timeout runner, bounded the
        // same way; a timeout is a failed read and the call is never made.
        const raced = await realTimeoutRunner(
          () => secrets.get("INTERNAL_KEY"),
          SECRET_READ_TIMEOUT_MS,
        );
        return raced === TIMED_OUT ? null : raced;
      },
      fetchImpl: fetch,
    }),
    accounts: createAccountsClient(env.CUSTOMER_ACCOUNT),
    sessions: createSessionsClient(env.SESSION),
    caches,
    flagsValue,
    secrets,
    log: logger,
    random: (n) => randomBytes(n),
    timeout: realTimeoutRunner,
  };
}

export default {
  async fetch(req: Request, env: VoiceContextEnv): Promise<Response> {
    currentEnv = env;
    const url = new URL(req.url);
    const route = matchRoute(req.method, url.pathname);
    switch (route) {
      case "healthz":
        return Response.json({ ok: true, svc: SERVICE_NAME, shared: SHARED_VERSION }, { status: 200 });
      case "dv":
        return handleDv(req, buildDeps(env));
      case "disclosure":
        return handleDisclosure(req, buildDeps(env));
      case "internal_health":
        return handleInternalHealth(req, buildDeps(env));
      case "not_found":
        return Response.json({ error: "not_found" }, { status: 404 });
    }
  },
};
