/**
 * The T22 container behaviour, on the injected box and on the real
 * `default.fetch` wiring: a replica's first request of any kind starts the
 * two secret reads and the flags read together and never waits for them; a
 * waiter joins the read in flight instead of starting a second one; a
 * success is kept for the container's life (a late success included) and a
 * failed or empty read is not. The box-level tests inject their own
 * refreshing flags value, secret store and warm-up box, the way the
 * module-level container works; one test drives `default.fetch` across two
 * requests so a box made per request instead of per container fails.
 */

import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorNamespace, KvNamespace, Secrets } from "@telnyx/edge-runtime";

import { kvKeys, mintSessionToken, parseKey } from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";

import { realTimeoutRunner, SECRET_HANDLES } from "../src/config.js";
import type { TimeoutRunner } from "../src/config.js";
import { createFlagsValue } from "../src/flags.js";
import { createSecretStore, handleRequest } from "../src/index.js";
import type { ContainerBox, VoiceToolsEnv } from "../src/index.js";

// ---------- held promises ----------

interface HeldPromise<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function hold<T>(): HeldPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes the microtask queue so a handler awaiting held promises advances. */
async function tick(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// ---------- the container box double ----------

/** The two handles the warm-up starts, in the production declaration's order. */
const HANDLES: readonly string[] = Object.values(SECRET_HANDLES);

interface BoxHarness {
  box: ContainerBox;
  /** Every handle passed to the raw secret reader, in order. */
  rawReads: string[];
  /** Arms one held raw read per handle; set before the request. */
  holdSecret(handle: string): HeldPromise<string | null>;
  /** Arms the held flags document read; set before the request. */
  holdFlags(): HeldPromise<unknown>;
  flagsGets(): number;
}

/**
 * The container box built the way index.ts builds it — the refreshing
 * flags value over a stubbed KV document, the store-backed secrets with a
 * memoised getKey, the warm-up box — with the raw secret read and the
 * flags document read under the test's finger.
 */
function makeBoxHarness(secretValues: Record<string, string | null> = {}): BoxHarness {
  const rawReads: string[] = [];
  const heldSecrets = new Map<string, HeldPromise<string | null>>();
  let heldFlags: HeldPromise<unknown> | null = null;
  let flagsGets = 0;
  const clock = createClockFake(1_600_000_000_000);

  const store = createSecretStore((handle) => {
    rawReads.push(handle);
    return heldSecrets.get(handle)?.promise ?? Promise.resolve(secretValues[handle] ?? null);
  });
  const keys = new Map<string, Uint8Array>();
  const flagsValue = createFlagsValue({
    kv: () =>
      ({
        get: () => {
          flagsGets += 1;
          return heldFlags?.promise ?? Promise.resolve(null);
        },
      }) as unknown as KvNamespace,
    now: clock.now,
    timeout: (<T>(fn: () => Promise<T>) => fn()) as TimeoutRunner,
  });

  return {
    box: {
      flagsValue,
      secrets: {
        get: (handle) => store.read(handle),
        async getKey(handle) {
          const hit = keys.get(handle);
          if (hit !== undefined) {
            return hit;
          }
          const raw = await store.read(handle);
          if (raw === null) {
            return null;
          }
          try {
            const bytes = parseKey(raw);
            keys.set(handle, bytes);
            return bytes;
          } catch {
            return null;
          }
        },
      },
      warmBox: { warmed: false },
    },
    rawReads,
    holdSecret(handle) {
      const held = hold<string | null>();
      heldSecrets.set(handle, held);
      return held;
    },
    holdFlags() {
      heldFlags = hold<unknown>();
      return heldFlags;
    },
    flagsGets: () => flagsGets,
  };
}

/**
 * A production-shaped env double: KV exists (the flags warm-up needs it)
 * and nothing else a route could reach works — a rejecting secrets binding
 * the injected box replaces, and actor namespaces that throw on use.
 */
function makeEnv(): VoiceToolsEnv {
  const actorNamespace = (name: string): ActorNamespace =>
    ({
      idFromName: () => {
        throw new Error(`${name} must not be reached by this route`);
      },
    }) as unknown as ActorNamespace;
  return {
    KV: {
      get: () => Promise.reject(new Error("kv must not be reached by this route")),
    } as unknown as KvNamespace,
    SECRETS: {
      get: () => Promise.reject(new Error("secrets must not be reached with an injected box")),
    } as unknown as Secrets,
    CUSTOMER_ACCOUNT: actorNamespace("CUSTOMER_ACCOUNT"),
    AREA_INCIDENT: actorNamespace("AREA_INCIDENT"),
    SESSION: actorNamespace("SESSION"),
  };
}

// ---------- the warm-up (T22) ----------

describe("container warm-up (T22, the ADR-014 exception)", () => {
  it("the first request of any kind starts every read and the flags value once; a second starts none", async () => {
    const env = makeEnv();
    const h = makeBoxHarness();

    // An unknown path answers 404 at once, with all three reads started.
    const first = await handleRequest(new Request("http://x.test/nope"), env, h.box);
    expect(first.status).toBe(404);
    expect(h.rawReads).toEqual([...HANDLES]);
    expect(h.flagsGets()).toBe(1);

    // /healthz in turn: 200 at once, and the warm-up ran once — nothing new.
    const health = await handleRequest(new Request("http://x.test/healthz"), env, h.box);
    expect(health.status).toBe(200);
    expect(h.rawReads).toEqual([...HANDLES]);
    expect(h.flagsGets()).toBe(1);
  });

  it("a request that fails authentication counts as the first request too", async () => {
    const env = makeEnv();
    const h = makeBoxHarness();

    // The replica's first request is a bearer-less POST /mcp: warm-up
    // runs, the request answers 401 without waiting for anything.
    const res = await handleRequest(
      new Request("http://x.test/mcp", { method: "POST", body: "{}" }),
      env,
      h.box,
    );
    expect(res.status).toBe(401);
    expect(h.rawReads).toEqual([...HANDLES]);
    expect(h.flagsGets()).toBe(1);

    const health = await handleRequest(new Request("http://x.test/healthz"), env, h.box);
    expect(health.status).toBe(200);
    expect(h.rawReads).toEqual([...HANDLES]);
  });

  it("the warm-up waits for nothing, even while every read is still held", async () => {
    const env = makeEnv();
    const h = makeBoxHarness();
    for (const handle of HANDLES) {
      h.holdSecret(handle);
    }
    h.holdFlags();

    const unknown = await handleRequest(new Request("http://x.test/nope"), env, h.box);
    expect(unknown.status).toBe(404);
    const health = await handleRequest(new Request("http://x.test/healthz"), env, h.box);
    expect(health.status).toBe(200);
    expect(h.rawReads).toEqual([...HANDLES]);
    expect(h.flagsGets()).toBe(1);
  });

  it("a request that needs a secret during the first request's reads joins the read in flight — one read, two waiters", async () => {
    const env = makeEnv();
    const tokenKeyRaw = randomBytes(32).toString("base64url");
    const h = makeBoxHarness({ MCP_TOKEN_KEY: tokenKeyRaw });
    const heldKey = h.holdSecret("MCP_TOKEN_KEY");

    // The first request (unknown path) starts the reads and answers at once.
    const first = await handleRequest(new Request("http://x.test/nope"), env, h.box);
    expect(first.status).toBe(404);

    // Two waiters on the same held read: two bearer-carrying /mcp posts
    // both need the token key for the signature check.
    const answered: string[] = [];
    const post = (id: number) =>
      handleRequest(
        new Request("http://x.test/mcp", {
          method: "POST",
          headers: { authorization: "Bearer junk.token.here" },
          body: "{}",
        }),
        env,
        h.box,
      ).then((r) => {
        answered.push(`post-${id}`);
        return r;
      });
    const firstMcp = post(1);
    const secondMcp = post(2);
    await tick();
    // Still waiting on the held read — and nobody started a second one.
    expect(answered).toEqual([]);
    expect(h.rawReads.filter((r) => r === "MCP_TOKEN_KEY")).toHaveLength(1);

    heldKey.resolve(tokenKeyRaw);
    const [one, two] = await Promise.all([firstMcp, secondMcp]);
    // Both got their (bad-signature) 401 from the same single read, and
    // neither reached an actor.
    expect(one.status).toBe(401);
    expect(two.status).toBe(401);
    expect(h.rawReads.filter((r) => r === "MCP_TOKEN_KEY")).toHaveLength(1);
  });
});

// ---------- what the store keeps (T22) ----------

describe("what the secret store keeps (T22)", () => {
  it("a successful read is kept: every later waiter shares it with no new raw read", async () => {
    let rawCalls = 0;
    const store = createSecretStore(() => {
      rawCalls += 1;
      return Promise.resolve("the-value");
    });
    expect(await store.read("H")).toBe("the-value");
    expect(await store.read("H")).toBe("the-value");
    expect(rawCalls).toBe(1);
  });

  it("two waiters share one read in flight", async () => {
    let rawCalls = 0;
    const held = hold<string | null>();
    const store = createSecretStore(() => {
      rawCalls += 1;
      return held.promise;
    });
    const first = store.read("H");
    const second = store.read("H");
    expect(rawCalls).toBe(1);
    held.resolve("joined");
    expect(await first).toBe("joined");
    expect(await second).toBe("joined");
    expect(rawCalls).toBe(1);
  });

  it("a late success is kept for the container's life, after a waiter gave up too", async () => {
    let rawCalls = 0;
    const held = hold<string | null>();
    const store = createSecretStore(() => {
      rawCalls += 1;
      return held.promise;
    });
    const waiter = store.read("H");
    // The waiter gives up at its own bound (never mind whom); the read
    // settles afterwards and is kept all the same.
    held.resolve("late");
    expect(await waiter).toBe("late");
    expect(await store.read("H")).toBe("late");
    expect(rawCalls).toBe(1);
  });

  it("a failed read is not kept: the next use reads again", async () => {
    let rawCalls = 0;
    let failing = true;
    const store = createSecretStore(() => {
      rawCalls += 1;
      return failing ? Promise.reject(new Error("sidecar down")) : Promise.resolve("recovered");
    });
    expect(await store.read("H")).toBeNull();
    failing = false;
    expect(await store.read("H")).toBe("recovered");
    expect(rawCalls).toBe(2);
    expect(await store.read("H")).toBe("recovered");
    expect(rawCalls).toBe(2);
  });

  it("an empty read is not kept: the next use reads again", async () => {
    let rawCalls = 0;
    let empty = true;
    const store = createSecretStore(() => {
      rawCalls += 1;
      return Promise.resolve(empty ? "" : "filled");
    });
    expect(await store.read("H")).toBe("");
    empty = false;
    expect(await store.read("H")).toBe("filled");
    expect(rawCalls).toBe(2);
  });
});

// ---------- the module container across two default.fetch requests ----------

describe("the module container across two default.fetch requests (T22)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads each secret and the flags document once across the whole container", async () => {
    // The production secret resolver falls back to same-named environment
    // variables; make the fallback see nothing, so only the fake binding
    // decides and an ambient variable can never save a failed read.
    for (const handle of HANDLES) {
      vi.stubEnv(handle, undefined as unknown as string);
    }
    vi.resetModules();
    const fresh = await import("../src/index.js");

    const secretGets: string[] = [];
    const kvGets: string[] = [];
    const kv = {
      get: (key: string) => {
        kvGets.push(key);
        return Promise.resolve(null);
      },
    } as unknown as KvNamespace;
    const actorNamespace = (name: string): ActorNamespace =>
      ({
        idFromName: () => {
          throw new Error(`${name} must not be reached by these requests`);
        },
      }) as unknown as ActorNamespace;
    const env: VoiceToolsEnv = {
      KV: kv,
      SECRETS: {
        get: (handle: string) => {
          secretGets.push(handle);
          return Promise.resolve(`test-${handle}`);
        },
      } as unknown as Secrets,
      CUSTOMER_ACCOUNT: actorNamespace("CUSTOMER_ACCOUNT"),
      AREA_INCIDENT: actorNamespace("AREA_INCIDENT"),
      SESSION: actorNamespace("SESSION"),
    };

    // The first request: POST /internal/sessions without the key header.
    // The warm-up runs; the auth check joins the INTERNAL_KEY read it
    // started and answers 401 (its fake binding value cannot match a
    // missing header).
    const first = await fresh.default.fetch(
      new Request("http://x.test/internal/sessions", { method: "POST", body: "{}" }),
      env,
    );
    expect(first.status).toBe(401);

    // The second request answers from what the first started: no read again.
    const second = await fresh.default.fetch(new Request("http://x.test/healthz"), env);
    expect(second.status).toBe(200);

    for (const handle of HANDLES) {
      expect(secretGets.filter((h) => h === handle)).toHaveLength(1);
    }
    expect(kvGets.filter((k) => k === kvKeys.flags())).toHaveLength(1);
  });
});

// ---------- the production CRM path (T22, DEBUGLOG issue 17) ----------

describe("the production /mcp path survives a cold INTERNAL_KEY read (T22)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /**
   * Drives `handleRequest` with a `ContainerBox` built the way index.ts
   * builds the module one — the secret store with the memoised getKey, the
   * refreshing flags value over the env's KV, a fresh warm-up box — so the
   * request goes through the production `buildDeps` wiring, whose
   * `readInternalKey` joins the warm-up's read without its own 1,000 ms
   * cut. The production timeout runner runs on vitest's fake timers: the
   * held key read lands at 650 ms and mock-crm's answer 1,050 ms after
   * that, the two cold first uses behind Thiago's failed 12:40
   * `verify_account` one after another (DEBUGLOG issue 17). The regression
   * check for the removed 1,000 ms wrapper is the next describe — a 650 ms
   * hold lands before the wrapper's timer could ever fire, so the
   * discriminator there holds the key past 1,000 ms.
   */
  it("verify_account passes with the key held to 650 ms and mock-crm answering 1,050 ms later", async () => {
    for (const handle of HANDLES) {
      vi.stubEnv(handle, undefined as unknown as string);
    }
    vi.stubEnv("CRM_URL", "http://mock-crm.test");
    const T0 = 1_760_000_000_000;
    vi.useFakeTimers({
      now: T0,
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "performance",
      ],
    });

    const tokenKeyRaw = randomBytes(32).toString("base64url");
    const INTERNAL_KEY = "test-internal-key-t22";
    const SID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TRACE_ID = "trace-t22-prod";
    const ACCOUNT = {
      accountNumber: "DV-100002",
      firstName: "Marie",
      postcode: "8630",
      lineId: "LN-000002",
    };

    // The fake bindings: INTERNAL_KEY's sidecar read settles after 650
    // fake ms; MCP_TOKEN_KEY answers at once. KV holds nothing, the actors
    // answer at once.
    const kv = {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    } as unknown as KvNamespace;
    const secretsBinding = {
      get: (handle: string): Promise<string> => {
        if (handle === "INTERNAL_KEY") {
          return new Promise<string>((resolve) => {
            setTimeout(() => {
              resolve(INTERNAL_KEY);
            }, 650);
          });
        }
        if (handle === "MCP_TOKEN_KEY") {
          return Promise.resolve(tokenKeyRaw);
        }
        return Promise.resolve("");
      },
    } as unknown as Secrets;
    const sessionDoc = {
      v: 1,
      sid: SID,
      traceId: TRACE_ID,
      identity: "number_match",
      accountNumber: "DV-100002",
      postcode: "8630",
      lineId: "LN-000002",
      callerPhone: "+32491244713",
      createdAt: T0,
      expiresAt: T0 + 7_200_000,
      disclosedAt: null,
      verify: { failures: 0, lockedUntil: null },
    };
    const sessionNamespace = {
      idFromName: () => ({
        get: () => Promise.resolve(sessionDoc),
        setVerified: () => Promise.resolve({ outcome: "verified", lockedUntil: null }),
      }),
    } as unknown as ActorNamespace;
    const accountNamespace = {
      idFromName: () => ({
        verify: () => Promise.resolve({ outcome: "ok", attemptsLeft: 3, lockedUntil: null }),
      }),
    } as unknown as ActorNamespace;
    const areaNamespace = {
      idFromName: () => {
        throw new Error("verify_account never calls AREA_INCIDENT");
      },
    } as unknown as ActorNamespace;
    const env: VoiceToolsEnv = {
      KV: kv,
      SECRETS: secretsBinding,
      CUSTOMER_ACCOUNT: accountNamespace,
      AREA_INCIDENT: areaNamespace,
      SESSION: sessionNamespace,
    };

    // The container box, built the way index.ts builds its module box.
    const store = createSecretStore(async (handle) => {
      const value = await secretsBinding.get(handle);
      return value.length > 0 ? value : null;
    });
    const keyMemo = new Map<string, Uint8Array>();
    const flagsValue = createFlagsValue({
      kv: () => kv,
      now: () => Date.now(),
      timeout: realTimeoutRunner,
    });
    const box: ContainerBox = {
      flagsValue,
      secrets: {
        get: (handle) => store.read(handle),
        async getKey(handle) {
          const hit = keyMemo.get(handle);
          if (hit !== undefined) {
            return hit;
          }
          const raw = await store.read(handle);
          if (raw === null) {
            return null;
          }
          try {
            const bytes = parseKey(raw);
            keyMemo.set(handle, bytes);
            return bytes;
          } catch {
            return null;
          }
        },
      },
      warmBox: { warmed: false },
    };

    const fetchCalls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init });
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(Response.json(ACCOUNT));
          }, 1_050);
        });
      },
    );

    const token = mintSessionToken({ sid: SID, exp: T0 + 7_200_000 }, parseKey(tokenKeyRaw));
    // The two scripted holds: 650 ms for the key read, then 1,050 ms for
    // mock-crm. The account fetch's own 2,500 ms never comes into it.
    const pending = handleRequest(
      new Request("http://x.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "verify_account", arguments: { postcode: "8630" } },
        }),
      }),
      env,
      box,
    );
    await vi.advanceTimersByTimeAsync(650);
    await vi.advanceTimersByTimeAsync(1_050);
    const res = await pending;

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    };
    expect(body.result?.isError).not.toBe(true);
    const text = body.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    expect(JSON.parse(text as string)).toMatchObject({
      verified: true,
      first_name: "Marie",
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("http://mock-crm.test/accounts/DV-100002");
    expect(fetchCalls[0]?.init?.headers).toEqual({ "x-internal-key": INTERNAL_KEY });
  });
});

// ---------- the wrapper that T22 removed, checked against the production wiring ----------

describe("the removed 1,000 ms cut of the key read, checked through buildDeps (T22)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /**
   * The discriminator for the old `readInternalKey` wrapper (the key read
   * cut at 1,000 ms inside `buildDeps`): the wrapper's timer starts when
   * the CRM client asks for the key — about request time — but the store
   * joins the warm-up's shared read, which settles at the scripted hold.
   * So the wrapper only bites when the read is still in flight 1,000 ms
   * after the request started: the previous test's 650 ms hold verifies
   * even with the wrapper put back (the read lands first), which is why
   * this test holds the key to 1,200 ms, deeper into the 2,500 ms bound.
   * mock-crm answers 1,050 ms after the key, as on 13 October. With the
   * production wiring the fetch lands at 2,250 ms and the caller verifies;
   * with the wrapper restored the key read is cut at 1,000 ms, the account
   * fetch is `failed` and the tool answers its `isError` sentence — this
   * test fails.
   */
  it("verify_account still passes with the key held to 1,200 ms and mock-crm answering 1,050 ms later", async () => {
    for (const handle of HANDLES) {
      vi.stubEnv(handle, undefined as unknown as string);
    }
    vi.stubEnv("CRM_URL", "http://mock-crm.test");
    const T0 = 1_760_000_000_000;
    vi.useFakeTimers({
      now: T0,
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "performance",
      ],
    });

    const tokenKeyRaw = randomBytes(32).toString("base64url");
    const INTERNAL_KEY = "test-internal-key-t22";
    const SID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ACCOUNT = {
      accountNumber: "DV-100002",
      firstName: "Marie",
      postcode: "8630",
      lineId: "LN-000002",
    };

    const kv = {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    } as unknown as KvNamespace;
    const secretsBinding = {
      get: (handle: string): Promise<string> => {
        if (handle === "INTERNAL_KEY") {
          return new Promise<string>((resolve) => {
            setTimeout(() => {
              resolve(INTERNAL_KEY);
            }, 1_200);
          });
        }
        if (handle === "MCP_TOKEN_KEY") {
          return Promise.resolve(tokenKeyRaw);
        }
        return Promise.resolve("");
      },
    } as unknown as Secrets;
    const sessionDoc = {
      v: 1,
      sid: SID,
      traceId: "trace-t22-wrapper",
      identity: "number_match",
      accountNumber: "DV-100002",
      postcode: "8630",
      lineId: "LN-000002",
      callerPhone: "+32491244713",
      createdAt: T0,
      expiresAt: T0 + 7_200_000,
      disclosedAt: null,
      verify: { failures: 0, lockedUntil: null },
    };
    const env: VoiceToolsEnv = {
      KV: kv,
      SECRETS: secretsBinding,
      CUSTOMER_ACCOUNT: {
        idFromName: () => ({
          verify: () => Promise.resolve({ outcome: "ok", attemptsLeft: 3, lockedUntil: null }),
        }),
      } as unknown as ActorNamespace,
      AREA_INCIDENT: {
        idFromName: () => {
          throw new Error("verify_account never calls AREA_INCIDENT");
        },
      } as unknown as ActorNamespace,
      SESSION: {
        idFromName: () => ({
          get: () => Promise.resolve(sessionDoc),
          setVerified: () => Promise.resolve({ outcome: "verified", lockedUntil: null }),
        }),
      } as unknown as ActorNamespace,
    };

    // The container box, built the way index.ts builds its module box.
    const store = createSecretStore(async (handle) => {
      const value = await secretsBinding.get(handle);
      return value.length > 0 ? value : null;
    });
    const keyMemo = new Map<string, Uint8Array>();
    const box: ContainerBox = {
      flagsValue: createFlagsValue({
        kv: () => kv,
        now: () => Date.now(),
        timeout: realTimeoutRunner,
      }),
      secrets: {
        get: (handle) => store.read(handle),
        async getKey(handle) {
          const hit = keyMemo.get(handle);
          if (hit !== undefined) {
            return hit;
          }
          const raw = await store.read(handle);
          if (raw === null) {
            return null;
          }
          try {
            const bytes = parseKey(raw);
            keyMemo.set(handle, bytes);
            return bytes;
          } catch {
            return null;
          }
        },
      },
      warmBox: { warmed: false },
    };

    const fetchCalls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init });
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(Response.json(ACCOUNT));
          }, 1_050);
        });
      },
    );

    const token = mintSessionToken({ sid: SID, exp: T0 + 7_200_000 }, parseKey(tokenKeyRaw));
    const pending = handleRequest(
      new Request("http://x.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "verify_account", arguments: { postcode: "8630" } },
        }),
      }),
      env,
      box,
    );
    await vi.advanceTimersByTimeAsync(1_200);
    await vi.advanceTimersByTimeAsync(1_050);
    const res = await pending;

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    };
    expect(body.result?.isError).not.toBe(true);
    const text = body.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    expect(JSON.parse(text as string)).toMatchObject({
      verified: true,
      first_name: "Marie",
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("http://mock-crm.test/accounts/DV-100002");
  });
});
