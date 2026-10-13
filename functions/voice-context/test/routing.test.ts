import { describe, expect, it } from "vitest";

import type { ActorNamespace, KvNamespace, Secrets } from "@telnyx/edge-runtime";

import { createRefreshingValue, SHARED_VERSION } from "@duinvezel/shared";

import { DEFAULT_FLAGS, parseFlags } from "../src/config.js";
import type { DvFlags, TimeoutRunner } from "../src/config.js";
import { handleRequest, matchRoute } from "../src/index.js";
import type { ContainerBox, VoiceContextEnv } from "../src/index.js";

import {
  createTestKeyPair,
  makeDvBody,
  makeSignedRequest,
  makeUnsignedRequest,
} from "./helpers/signed-request.js";

/**
 * An env double in the style of `telnyx-edge dev` (DEBUGLOG issue 9): no
 * usable secrets binding. Any KV or actor access is recorded and then
 * fails, so a test can prove a route never reached state. The T22 warm-up
 * reads do not show up here — they run on the per-test container box (the
 * refreshing flags value and the shared secret store), exactly like the
 * module-level container reads its own boxes and not the tracked bindings.
 */
function makeTrackedEnv(): { env: VoiceContextEnv; kvCalls: string[]; actorCalls: string[] } {
  const kvCalls: string[] = [];
  const actorCalls: string[] = [];
  const kv = new Proxy(
    {},
    {
      get: (_target, prop) => {
        kvCalls.push(String(prop));
        return () => Promise.reject(new Error("kv must not be reached by this route"));
      },
    },
  );
  const actorNamespace = (name: string): ActorNamespace =>
    ({
      idFromName: (instance: string) => {
        actorCalls.push(`${name}:${instance}`);
        throw new Error("actors must not be reached by this route");
      },
    }) as unknown as ActorNamespace;
  const env: VoiceContextEnv = {
    KV: kv as unknown as KvNamespace,
    CUSTOMER_ACCOUNT: actorNamespace("CUSTOMER_ACCOUNT"),
    SESSION: actorNamespace("SESSION"),
    SECRETS: {
      get: () => Promise.reject(new Error("no secrets under telnyx-edge dev")),
    } as unknown as Secrets,
  };
  return { env, kvCalls, actorCalls };
}

interface BoxDouble {
  box: ContainerBox;
  /** Every handle the box's secret double was asked for, in order (the warm-up first). */
  secretReads: string[];
  /** How often the box's flags document was read. */
  flagsGets(): number;
}

/**
 * A per-test container box: the same triple index.ts builds at module
 * scope (T22), with a flags value whose document read resolves to the
 * defaults and a secret double over the given values. Built fresh per test,
 * so the warm-up state never leaks between tests.
 */
function makeBox(secrets: Record<string, string | null> = {}): BoxDouble {
  const secretReads: string[] = [];
  let flagsGets = 0;
  const flagsValue = createRefreshingValue<DvFlags>({
    read: (): Promise<DvFlags> => {
      flagsGets += 1;
      return Promise.resolve(parseFlags(null));
    },
    lifetimeMs: 10_000,
    fallback: DEFAULT_FLAGS,
    now: () => 1_600_000_000_000,
    timeout: (<T>(fn: () => Promise<T>) => fn()) as TimeoutRunner,
  });
  return {
    box: {
      flagsValue,
      secrets: {
        get: (handle: string) => {
          secretReads.push(handle);
          return Promise.resolve(secrets[handle] ?? null);
        },
        getKey: () => Promise.resolve(null),
      },
      warmBox: { warmed: false },
    },
    secretReads,
    flagsGets: () => flagsGets,
  };
}

describe("matchRoute", () => {
  it("matches exactly the four known method+path pairs", () => {
    expect(matchRoute("POST", "/dv")).toBe("dv");
    expect(matchRoute("POST", "/tools/disclosure")).toBe("disclosure");
    expect(matchRoute("GET", "/internal/health")).toBe("internal_health");
    expect(matchRoute("GET", "/healthz")).toBe("healthz");
  });

  it("rejects wrong methods, near-miss paths and query-cleaned paths only via pathname", () => {
    expect(matchRoute("GET", "/dv")).toBe("not_found");
    expect(matchRoute("POST", "/tools/disclosure/")).toBe("not_found");
    expect(matchRoute("POST", "/healthz")).toBe("not_found");
    expect(matchRoute("GET", "/internal/healthz")).toBe("not_found");
    expect(matchRoute("GET", "/Internal/health")).toBe("not_found");
    expect(matchRoute("GET", "/")).toBe("not_found");
    expect(matchRoute("GET", "/nope")).toBe("not_found");
  });
});

describe("fetch routing", () => {
  it("GET /healthz answers 200 with svc and shared version and touches no state", async () => {
    const { env, kvCalls, actorCalls } = makeTrackedEnv();
    const { box } = makeBox();
    const res = await handleRequest(new Request("http://x.test/healthz"), env, box);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      svc: "voice-context",
      shared: SHARED_VERSION,
    });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });

  it("an unknown path answers 404 without any state access", async () => {
    const { env, kvCalls, actorCalls } = makeTrackedEnv();
    const { box } = makeBox();
    const res = await handleRequest(new Request("http://x.test/nope?x=1"), env, box);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });

  it("a wrong method on a known path answers 404 without any state access", async () => {
    const { env, kvCalls, actorCalls } = makeTrackedEnv();
    const { box } = makeBox();
    const res = await handleRequest(
      new Request("http://x.test/dv", { method: "GET" }),
      env,
      box,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });

  it("an unsigned POST /dv answers 403 and makes no KV or actor call", async () => {
    const { env, kvCalls, actorCalls } = makeTrackedEnv();
    const keyPair = createTestKeyPair();
    const { box } = makeBox({ TELNYX_PUBLIC_KEY: keyPair.publicKeyBase64 });
    const res = await handleRequest(makeUnsignedRequest({ body: makeDvBody() }), env, box);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });

  it("a wrongly signed POST /tools/disclosure answers 403 and makes no KV or actor call", async () => {
    const { env, kvCalls, actorCalls } = makeTrackedEnv();
    const keyPair = createTestKeyPair();
    const wrong = createTestKeyPair();
    const { box } = makeBox({ TELNYX_PUBLIC_KEY: keyPair.publicKeyBase64 });
    const res = await handleRequest(
      makeSignedRequest({
        keyPair: wrong,
        body: { session_id: "0".repeat(32) },
        path: "/tools/disclosure",
      }),
      env,
      box,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });

  it("GET /internal/health without a key answers 401 and makes no KV or actor call", async () => {
    const { env, kvCalls, actorCalls } = makeTrackedEnv();
    const { box } = makeBox({ INTERNAL_KEY: "the-internal-key" });
    const res = await handleRequest(
      new Request("http://x.test/internal/health"),
      env,
      box,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });
});
