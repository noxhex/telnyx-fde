import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorNamespace } from "@telnyx/edge-runtime";

import { mintSessionToken, parseKey, SHARED_VERSION } from "@duinvezel/shared";
import type { SessionDoc } from "@duinvezel/shared";

import handler, { matchRoute } from "../src/index.js";
import type { VoiceToolsEnv } from "../src/index.js";

/**
 * An env double in the style of `telnyx-edge dev` (DEBUGLOG issue 9): no
 * secrets or KV bindings at all. Any actor access is recorded and then
 * fails, so a test can prove a route never reached state.
 */
function makeTrackedEnv(): { env: VoiceToolsEnv; actorCalls: string[] } {
  const actorCalls: string[] = [];
  const actorNamespace = (name: string): ActorNamespace =>
    ({
      idFromName: (instance: string) => {
        actorCalls.push(`${name}:${instance}`);
        throw new Error("actors must not be reached by this route");
      },
    }) as unknown as ActorNamespace;
  const env: VoiceToolsEnv = {
    CUSTOMER_ACCOUNT: actorNamespace("CUSTOMER_ACCOUNT"),
    AREA_INCIDENT: actorNamespace("AREA_INCIDENT"),
    SESSION: actorNamespace("SESSION"),
  };
  return { env, actorCalls };
}

describe("matchRoute", () => {
  it("matches exactly the card's four routes, GET /mcp being the 405", () => {
    expect(matchRoute("POST", "/mcp")).toBe("mcp");
    expect(matchRoute("GET", "/mcp")).toBe("mcp_wrong_method");
    expect(matchRoute("POST", "/internal/sessions")).toBe("internal_sessions");
    expect(matchRoute("GET", "/healthz")).toBe("healthz");
  });

  it("rejects wrong methods, near-miss paths and every other path", () => {
    expect(matchRoute("PUT", "/mcp")).toBe("not_found");
    expect(matchRoute("DELETE", "/mcp")).toBe("not_found");
    expect(matchRoute("GET", "/internal/sessions")).toBe("not_found");
    expect(matchRoute("POST", "/healthz")).toBe("not_found");
    expect(matchRoute("GET", "/mcp/")).toBe("not_found");
    expect(matchRoute("GET", "/internal")).toBe("not_found");
    expect(matchRoute("GET", "/")).toBe("not_found");
    expect(matchRoute("GET", "/nope")).toBe("not_found");
  });
});

describe("fetch routing", () => {
  it("GET /healthz answers 200 with svc and shared version and touches no state", async () => {
    const { env, actorCalls } = makeTrackedEnv();
    const res = await handler.fetch(new Request("http://x.test/healthz"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      svc: "voice-tools",
      shared: SHARED_VERSION,
    });
    expect(actorCalls).toEqual([]);
  });

  it("GET /mcp answers 405 with an Allow header and touches no state", async () => {
    const { env, actorCalls } = makeTrackedEnv();
    const res = await handler.fetch(new Request("http://x.test/mcp"), env);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
    expect(actorCalls).toEqual([]);
  });

  it("an unknown path answers 404 without any state access", async () => {
    const { env, actorCalls } = makeTrackedEnv();
    const res = await handler.fetch(new Request("http://x.test/nope?x=1"), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(actorCalls).toEqual([]);
  });

  it("a wrong method on a known path answers 404 without any state access", async () => {
    const { env, actorCalls } = makeTrackedEnv();
    const res = await handler.fetch(new Request("http://x.test/internal/sessions"), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(actorCalls).toEqual([]);
  });

  it("POST /mcp without a token answers 401 with a JSON-RPC error and makes no actor call", async () => {
    const { env, actorCalls } = makeTrackedEnv();
    const res = await handler.fetch(
      new Request("http://x.test/mcp", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "unauthorized" },
    });
    expect(actorCalls).toEqual([]);
  });

  it("POST /internal/sessions without a key answers 401 and makes no actor call (dev fails closed)", async () => {
    const { env, actorCalls } = makeTrackedEnv();
    const res = await handler.fetch(
      new Request("http://x.test/internal/sessions", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(actorCalls).toEqual([]);
  });
});

// ---------- one log line per request ----------

/**
 * The module logger writes to stdout; spy on `process.stdout.write` for
 * exactly the fetch under test and count this service's lines.
 */
async function captureLines(run: () => Promise<unknown>): Promise<string[]> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return writes.filter((line) => line.includes('"svc":"voice-tools"'));
}

describe("one log line per request", () => {
  it("GET /healthz writes exactly one line", async () => {
    const { env } = makeTrackedEnv();
    const lines = await captureLines(() =>
      handler.fetch(new Request("http://x.test/healthz"), env),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ event: "healthz", status: 200 });
  });

  it("GET /mcp writes exactly one line", async () => {
    const { env } = makeTrackedEnv();
    const lines = await captureLines(() => handler.fetch(new Request("http://x.test/mcp"), env));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      event: "method_not_allowed",
      status: 405,
    });
  });

  it("an unknown path writes exactly one line", async () => {
    const { env } = makeTrackedEnv();
    const lines = await captureLines(() =>
      handler.fetch(new Request("http://x.test/nope"), env),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ event: "not_found", status: 404 });
  });
});

// ---------- the per-container secret memo (module level) ----------

const MEMO_T0 = 1_600_000_000_000;
const MEMO_TOKEN_KEY_RAW = randomBytes(32).toString("base64url");
const MEMO_TOKEN_KEY = parseKey(MEMO_TOKEN_KEY_RAW);
const MEMO_INTERNAL_KEY = randomBytes(16).toString("hex");
const MEMO_SID = "dddddddddddddddddddddddddddddddd";

const MEMO_LINE_RESULT = {
  lineState: "ok",
  signalDbm: -20,
  lastSeenMinutes: 2,
  suggestion: "The line looks fine from here.",
  nearbyOutageSuspected: false,
};

function memoSession(): SessionDoc {
  return {
    v: 1,
    sid: MEMO_SID,
    traceId: "memo-trace",
    identity: "attested",
    accountNumber: "DV-100002",
    postcode: "8630",
    lineId: "LN-000002",
    callerPhone: null,
    createdAt: MEMO_T0,
    expiresAt: Date.now() + 3_600_000,
    disclosedAt: null,
    verify: { failures: 0, lockedUntil: null },
  };
}

interface MemoEnv {
  env: VoiceToolsEnv;
  secretReads: string[];
  failNextSecretRead: (handle: string) => void;
}

/** An env double with a working secrets binding and a working SESSION actor, so authenticated MCP requests pass end to end. */
function makeMemoEnv(): MemoEnv {
  const secretReads: string[] = [];
  const failing = new Set<string>();
  const values: Record<string, string> = {
    MCP_TOKEN_KEY: MEMO_TOKEN_KEY_RAW,
    INTERNAL_KEY: MEMO_INTERNAL_KEY,
  };
  const secrets = {
    get: (handle: string) => {
      secretReads.push(handle);
      if (failing.delete(handle)) {
        return Promise.reject(new Error("secret sidecar down"));
      }
      return Promise.resolve(values[handle] ?? "");
    },
  };
  const session = memoSession();
  const sessionNamespace = {
    idFromName: () => ({
      get: () => Promise.resolve(session),
      create: () => Promise.reject(new Error("not used here")),
    }),
  };
  const neverNamespace = (): ActorNamespace =>
    ({
      idFromName: () => {
        throw new Error("this actor must not be reached here");
      },
    }) as unknown as ActorNamespace;
  return {
    env: {
      SECRETS: secrets,
      SESSION: sessionNamespace,
      CUSTOMER_ACCOUNT: neverNamespace(),
      AREA_INCIDENT: neverNamespace(),
    } as unknown as VoiceToolsEnv,
    secretReads,
    failNextSecretRead: (handle) => {
      failing.add(handle);
    },
  };
}

/** A fresh copy of the module (the memo lives at module level) plus a request poster with a valid token. */
async function freshModule(): Promise<{
  post: (body: Record<string, unknown>, env: VoiceToolsEnv) => Promise<{ status: number; body: unknown }>;
}> {
  // The production secret resolver falls back to same-named environment
  // variables; make the fallback see nothing, so only the fake binding
  // decides and an ambient variable can never save a failed read.
  vi.stubEnv("MCP_TOKEN_KEY", undefined as unknown as string);
  vi.stubEnv("INTERNAL_KEY", undefined as unknown as string);
  vi.stubEnv("CRM_URL", "http://mock-crm.test");
  vi.resetModules();
  const fresh = await import("../src/index.js");
  const token = mintSessionToken({ sid: MEMO_SID, exp: Date.now() + 3_600_000 }, MEMO_TOKEN_KEY);
  return {
    async post(body, env) {
      const res = await fresh.default.fetch(
        new Request("http://x.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }),
        env,
      );
      return { status: res.status, body: await res.json() };
    },
  };
}

const PING = { jsonrpc: "2.0", id: 0, method: "ping" };
const DIAGNOSE = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "run_line_diagnostics", arguments: {} },
};

describe("the per-container secret memo, through default.fetch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("two authenticated requests read MCP_TOKEN_KEY from the binding once", async () => {
    const { env, secretReads } = makeMemoEnv();
    const { post } = await freshModule();
    const first = await post(PING, env);
    const second = await post(PING, env);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secretReads.filter((h) => h === "MCP_TOKEN_KEY")).toHaveLength(1);
  });

  it("a failed MCP_TOKEN_KEY read is not kept: the next request reads it again and passes", async () => {
    const { env, secretReads, failNextSecretRead } = makeMemoEnv();
    failNextSecretRead("MCP_TOKEN_KEY");
    const { post } = await freshModule();
    const failed = await post(PING, env);
    expect(failed.status).toBe(503);
    const recovered = await post(PING, env);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ result: {} });
    // Two reads in total: the failed one and the retried one; the success
    // after that is memoised for the next container-level request again.
    expect(secretReads.filter((h) => h === "MCP_TOKEN_KEY")).toHaveLength(2);
    const third = await post(PING, env);
    expect(third.status).toBe(200);
    expect(secretReads.filter((h) => h === "MCP_TOKEN_KEY")).toHaveLength(2);
  });

  it("a failed INTERNAL_KEY read makes no call to mock-crm, and the next tool call works", async () => {
    const { env, secretReads, failNextSecretRead } = makeMemoEnv();
    failNextSecretRead("INTERNAL_KEY");
    const { post } = await freshModule();
    const fetchStub = vi.fn().mockImplementation(() => Promise.resolve(Response.json(MEMO_LINE_RESULT)));
    vi.stubGlobal("fetch", fetchStub);
    try {
      const failed = await post(DIAGNOSE, env);
      expect(failed.status).toBe(200);
      // No key, so no outbound call was ever attempted (a 401 from mock-crm
      // would just be another failure).
      expect(fetchStub).not.toHaveBeenCalled();
      expect(failed.body).toMatchObject({
        result: { isError: true },
      });

      // The failed read was not kept: the very next tool call reads the key
      // again and reaches mock-crm.
      const recovered = await post(DIAGNOSE, env);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toMatchObject({
        result: {
          content: [{ type: "text", text: JSON.stringify(MEMO_LINE_RESULT) }],
        },
      });
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(secretReads.filter((h) => h === "INTERNAL_KEY")).toHaveLength(2);

      // The success is memoised: a third tool call needs no third key read.
      const third = await post(DIAGNOSE, env);
      expect(third.status).toBe(200);
      expect(fetchStub).toHaveBeenCalledTimes(2);
      expect(secretReads.filter((h) => h === "INTERNAL_KEY")).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
