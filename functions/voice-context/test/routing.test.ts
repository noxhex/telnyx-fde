import { describe, expect, it } from "vitest";

import type { ActorNamespace, KvNamespace, Secrets } from "@telnyx/edge-runtime";

import { SHARED_VERSION } from "@duinvezel/shared";

import handler, { matchRoute } from "../src/index.js";
import type { VoiceContextEnv } from "../src/index.js";

import { makeDvBody, makeUnsignedRequest } from "./helpers/signed-request.js";

/**
 * An env double in the style of `telnyx-edge dev` (DEBUGLOG issue 9): no
 * secrets binding at all. Any KV or actor access is recorded and then
 * fails, so a test can prove a route never reached state.
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
    const res = await handler.fetch(new Request("http://x.test/healthz"), env);
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
    const res = await handler.fetch(new Request("http://x.test/nope?x=1"), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });

  it("a wrong method on a known path answers 404 without any state access", async () => {
    const { env, kvCalls, actorCalls } = makeTrackedEnv();
    const res = await handler.fetch(new Request("http://x.test/dv", { method: "GET" }), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });

  it("an unsigned POST /dv answers 403 and makes no KV or actor call", async () => {
    const { env, kvCalls, actorCalls } = makeTrackedEnv();
    const res = await handler.fetch(makeUnsignedRequest({ body: makeDvBody() }), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });

  it("GET /internal/health without a key answers 401 and makes no KV or actor call", async () => {
    const { env, kvCalls, actorCalls } = makeTrackedEnv();
    const res = await handler.fetch(new Request("http://x.test/internal/health"), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(kvCalls).toEqual([]);
    expect(actorCalls).toEqual([]);
  });
});
