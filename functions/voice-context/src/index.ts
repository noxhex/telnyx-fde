/**
 * voice-context — the call setup webhook (`POST /dv`), the webhook behind
 * the Route call tool node (`POST /tools/disclosure`), the canary's deep
 * health check (`GET /internal/health`) and liveness (`GET /healthz`).
 * Routing only: strict method+path matching, and anything unknown is a 404
 * before any KV or actor access (ADR-014, DEBUGLOG issue 4).
 *
 * The one ADR-014 exception is the warm-up (T22, the exception Thiago
 * allowed for mock-crm on 12 October and extended to this function on 13
 * October, DEBUGLOG issue 17): a replica's first request of any kind —
 * unknown paths and requests that fail authentication included — starts the
 * reads of `TELNYX_PUBLIC_KEY`, `MCP_TOKEN_KEY`, `MCP_ENC_KEY` and
 * `INTERNAL_KEY` and the flags read together, once per replica, and never
 * waits for them. The reads change no state, so a call that lands on a
 * replica that has never read its secrets joins reads already running
 * instead of paying the 0.55 to 1.0+ s of first uses inside its own
 * bounded steps.
 *
 * The real dependencies are built from `env` here; the route handlers take
 * theirs as an argument so tests inject fakes (card T08, Design for
 * testing). Per container, once at module level: the logger, the memory
 * caches for area statuses and CRM answers (ADR-019), the refreshing flags
 * value (T20), the shared secret store and the warm-up box (T22). The
 * secret store keeps a success for the container's life — a success that
 * lands after a request stopped waiting included — and keeps nothing for a
 * failed or empty read, so the next use reads again; while a read is in
 * flight every waiter shares it. The flags value serves its last good
 * parse with no wait and refreshes it in the background once its 10 s
 * lifetime has passed (DEBUGLOG issue 15). `telnyx-edge dev` has no
 * secrets or KV (DEBUGLOG issue 9), so there a secret read resolves null
 * and the keyed routes fail closed — 403 on `/dv` (no public key), 401 on
 * `/internal/health`.
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
  SECRET_HANDLES,
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
 * The latest env the platform handed us. The flags value's and the secret
 * store's reads close over it, because those reads only ever run while a
 * request — and with it an env — is on the go.
 */
let currentEnv: VoiceContextEnv | undefined;

function requireEnv(): VoiceContextEnv {
  if (currentEnv === undefined) {
    throw new Error("voice-context: no env is set yet");
  }
  return currentEnv;
}

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
    return parseFlags(await requireEnv().KV.get(kvKeys.flags(), { type: "json" }));
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

/** Once-per-replica warm-up state (T22): the four secret reads and the flags read start on the first request of any kind. */
export interface WarmBox {
  warmed: boolean;
}

/**
 * What one container holds and a test can replace: the refreshing flags
 * value, the shared secret reads as the routes' `SecretsDep`, and the
 * warm-up box. index.ts builds one at module scope; tests build their own.
 */
export interface ContainerBox {
  flagsValue: RefreshingValue<DvFlags>;
  secrets: SecretsDep;
  warmBox: WarmBox;
}

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

/** Builds the production dependencies for one matched route. */
export function buildDeps(env: VoiceContextEnv, box: ContainerBox): VoiceContextDeps {
  return {
    now: () => Date.now(),
    kv: env.KV,
    crm: createCrmClient({
      crmUrl: process.env.CRM_URL ?? "",
      // T22: this read is no longer cut at SECRET_READ_TIMEOUT_MS. It joins
      // the warm-up's shared read and counts against the lookup's own bound
      // (crmLookupMs on /dv, health.crmMs on /internal/health), which is
      // sized for two cold first uses in a row.
      readInternalKey: () => box.secrets.get(SECRET_HANDLES.internalKey),
      fetchImpl: fetch,
    }),
    accounts: createAccountsClient(env.CUSTOMER_ACCOUNT),
    sessions: createSessionsClient(env.SESSION),
    caches,
    flagsValue: box.flagsValue,
    secrets: box.secrets,
    log: logger,
    random: (n) => randomBytes(n),
    timeout: realTimeoutRunner,
  };
}

/**
 * One request through the container: the warm-up first (T22), then strict
 * routing. The warm-up's reads are fire-and-forget — the store and the
 * flags value keep whatever settles — and the swallowed rejection only
 * guards an injected double; the production store never rejects.
 */
export async function handleRequest(
  req: Request,
  env: VoiceContextEnv,
  box: ContainerBox,
): Promise<Response> {
  currentEnv = env;
  if (!box.warmBox.warmed) {
    box.warmBox.warmed = true;
    box.flagsValue.start();
    void box.secrets.get(SECRET_HANDLES.telnyxPublicKey).catch(() => undefined);
    void box.secrets.get(SECRET_HANDLES.mcpTokenKey).catch(() => undefined);
    void box.secrets.get(SECRET_HANDLES.mcpEncKey).catch(() => undefined);
    void box.secrets.get(SECRET_HANDLES.internalKey).catch(() => undefined);
  }

  const url = new URL(req.url);
  const route = matchRoute(req.method, url.pathname);
  switch (route) {
    case "healthz":
      return Response.json(
        { ok: true, svc: SERVICE_NAME, shared: SHARED_VERSION },
        { status: 200 },
      );
    case "dv":
      return handleDv(req, buildDeps(env, box));
    case "disclosure":
      return handleDisclosure(req, buildDeps(env, box));
    case "internal_health":
      return handleInternalHealth(req, buildDeps(env, box));
    case "not_found":
      return Response.json({ error: "not_found" }, { status: 404 });
  }
}

/** The real container, created once with the rest of the module. */
const containerBox: ContainerBox = {
  flagsValue,
  secrets: containerSecrets,
  warmBox: { warmed: false },
};

export default {
  async fetch(req: Request, env: VoiceContextEnv): Promise<Response> {
    return handleRequest(req, env, containerBox);
  },
};
