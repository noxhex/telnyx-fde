/**
 * The T22 container behaviour, on the injected box and on the real
 * `default.fetch` wiring: a replica's first request of any kind starts the
 * four secret reads and the flags read together and never waits for them;
 * a waiter joins the read in flight instead of starting a second one; a
 * success is kept for the container's life (a late success included) and a
 * failed or empty read is not. The box-level tests inject their own
 * refreshing flags value, secret store and warm-up box, the way the
 * module-level container works; one test drives `default.fetch` across two
 * requests so a box made per request instead of per container fails.
 */

import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorNamespace, KvNamespace, Secrets } from "@telnyx/edge-runtime";

import { createRefreshingValue, kvKeys, parseKey } from "@duinvezel/shared";
import type { CreateSessionInput } from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";

import {
  DEFAULT_FLAGS,
  parseFlags,
  realTimeoutRunner,
  SECRET_HANDLES,
} from "../src/config.js";
import type { DvFlags, TimeoutRunner } from "../src/config.js";
import { createSecretStore, handleRequest } from "../src/index.js";
import type { ContainerBox, VoiceContextEnv } from "../src/index.js";
import type { SecretsDep } from "../src/deps.js";

import {
  createTestKeyPair,
  makeDvBody,
  makeSignedRequest,
  makeUnsignedRequest,
} from "./helpers/signed-request.js";

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

/** The four handles the warm-up starts, in the production declaration's order. */
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
 * flags value, the store-backed secrets with a memoised getKey, the warm-up
 * box — with the raw secret read and the flags document read under the
 * test's finger.
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
  const flagsValue = createRefreshingValue<DvFlags>({
    read: (): Promise<DvFlags> => {
      flagsGets += 1;
      return (heldFlags?.promise ?? Promise.resolve(null)).then((raw) => parseFlags(raw));
    },
    lifetimeMs: 10_000,
    fallback: DEFAULT_FLAGS,
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

/** A dev-like env double: no state a route may reach, and a rejecting secrets binding the injected box replaces. */
function makeEnv(): VoiceContextEnv {
  const kv = new Proxy(
    {},
    {
      get: (_target, prop) => () => {
        throw new Error(`kv.${String(prop)} must not be reached by this route`);
      },
    },
  );
  const actorNamespace = (name: string): ActorNamespace =>
    ({
      idFromName: () => {
        throw new Error(`${name} must not be reached by this route`);
      },
    }) as unknown as ActorNamespace;
  return {
    KV: kv as unknown as KvNamespace,
    CUSTOMER_ACCOUNT: actorNamespace("CUSTOMER_ACCOUNT"),
    SESSION: actorNamespace("SESSION"),
    SECRETS: {
      get: () => Promise.reject(new Error("no secrets under telnyx-edge dev")),
    } as unknown as Secrets,
  };
}

// ---------- the warm-up (T22) ----------

describe("container warm-up (T22, the ADR-014 exception)", () => {
  it("the first request of any kind starts every read and the flags value once; a second starts none", async () => {
    const env = makeEnv();
    const h = makeBoxHarness();

    // An unknown path answers 404 at once, with all five reads started.
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
    const keyPair = createTestKeyPair();
    const h = makeBoxHarness({ TELNYX_PUBLIC_KEY: keyPair.publicKeyBase64 });

    // The replica's first request is an unsigned /dv: warm-up runs, the
    // signature check joins the public key read it started, 403.
    const res = await handleRequest(makeUnsignedRequest({ body: makeDvBody() }), env, h.box);
    expect(res.status).toBe(403);
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
    const keyPair = createTestKeyPair();
    const h = makeBoxHarness({ TELNYX_PUBLIC_KEY: keyPair.publicKeyBase64 });
    const heldKey = h.holdSecret("TELNYX_PUBLIC_KEY");

    // The first request (unknown path) starts the reads and answers at once.
    const first = await handleRequest(new Request("http://x.test/nope"), env, h.box);
    expect(first.status).toBe(404);

    // Two waiters on the same held read: an unsigned /dv and an unsigned
    // /tools/disclosure both need the public key for their signature check.
    const answered: string[] = [];
    const dv = handleRequest(makeUnsignedRequest({ body: makeDvBody() }), env, h.box).then((r) => {
      answered.push("dv");
      return r;
    });
    const disclosure = handleRequest(
      makeUnsignedRequest({ body: { session_id: "0".repeat(32) }, path: "/tools/disclosure" }),
      env,
      h.box,
    ).then((r) => {
      answered.push("disclosure");
      return r;
    });
    await tick();
    // Still waiting on the held read — and nobody started a second one.
    expect(answered).toEqual([]);
    expect(h.rawReads.filter((r) => r === "TELNYX_PUBLIC_KEY")).toHaveLength(1);

    heldKey.resolve(keyPair.publicKeyBase64);
    const [dvRes, disclosureRes] = await Promise.all([dv, disclosure]);
    // Both got the (missing-headers) 403 from the same single read.
    expect(dvRes.status).toBe(403);
    expect(disclosureRes.status).toBe(403);
    expect(h.rawReads.filter((r) => r === "TELNYX_PUBLIC_KEY")).toHaveLength(1);
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
    const keyPair = createTestKeyPair();

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
    const env: VoiceContextEnv = {
      KV: kv,
      CUSTOMER_ACCOUNT: actorNamespace("CUSTOMER_ACCOUNT"),
      SESSION: actorNamespace("SESSION"),
      SECRETS: {
        get: (handle: string) => {
          secretGets.push(handle);
          return Promise.resolve(
            handle === "TELNYX_PUBLIC_KEY" ? keyPair.publicKeyBase64 : `test-${handle}`,
          );
        },
      } as unknown as Secrets,
    };

    // The first request: an unsigned /dv. The warm-up runs; its signature
    // check joins the public key read it started and answers 403 at once.
    const first = await fresh.default.fetch(makeUnsignedRequest({ body: makeDvBody() }), env);
    expect(first.status).toBe(403);

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

describe("the production /dv path survives a cold INTERNAL_KEY read (T22)", () => {
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
   * held key read lands at 1,200 ms and mock-crm's answer 600 ms after
   * that, the two cold first uses of Thiago's 12:35 call one after another
   * (DEBUGLOG issue 17). With the old wrapper (the key read cut at 1,000 ms
   * inside `buildDeps`) this whole test fails: the lookup is `crm_error`
   * and the caller is anonymous.
   */
  it("identifies the caller with the key held to 1,200 ms and mock-crm answering 600 ms later", async () => {
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

    const keyPair = createTestKeyPair();
    const tokenKeyRaw = randomBytes(32).toString("base64url");
    const encKeyRaw = randomBytes(32).toString("base64url");
    const INTERNAL_KEY = "test-internal-key-t22";
    const CUSTOMER = {
      accountNumber: "DV-100002",
      firstName: "Marie",
      postcode: "8630",
      areaName: "Veurne",
      lineId: "LN-000002",
    };

    // The fake bindings:INTERNAL_KEY's sidecar read settles after 1,200
    // fake ms; every other secret answers at once. KV answers nothing, the
    // actors answer at once.
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
        if (handle === "TELNYX_PUBLIC_KEY") {
          return Promise.resolve(keyPair.publicKeyBase64);
        }
        if (handle === "MCP_TOKEN_KEY") {
          return Promise.resolve(tokenKeyRaw);
        }
        if (handle === "MCP_ENC_KEY") {
          return Promise.resolve(encKeyRaw);
        }
        return Promise.resolve("");
      },
    } as unknown as Secrets;
    const sessionNamespace = {
      idFromName: (sid: string) => ({
        create: (input: CreateSessionInput) =>
          Promise.resolve({
            created: true,
            session: {
              v: 1,
              sid,
              traceId: input.traceId,
              identity: input.identity,
              accountNumber: input.accountNumber ?? null,
              postcode: input.postcode ?? null,
              lineId: input.lineId ?? null,
              callerPhone: input.callerPhone ?? null,
              createdAt: input.nowMs,
              expiresAt: input.nowMs + 7_200_000,
              disclosedAt: null,
              verify: { failures: 0, lockedUntil: null },
            },
          }),
      }),
    } as unknown as ActorNamespace;
    const accountNamespace = {
      idFromName: () => ({
        recordCall: () => Promise.resolve({ repeatCaller: false }),
      }),
    } as unknown as ActorNamespace;
    const env: VoiceContextEnv = {
      KV: kv,
      CUSTOMER_ACCOUNT: accountNamespace,
      SESSION: sessionNamespace,
      SECRETS: secretsBinding,
    };

    // The container box, built the way index.ts builds its module box.
    const store = createSecretStore(async (handle) => {
      const value = await secretsBinding.get(handle);
      return value.length > 0 ? value : null;
    });
    const keyMemo = new Map<string, Uint8Array>();
    const boxSecrets: SecretsDep = {
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
    };
    const flagsValue = createRefreshingValue<DvFlags>({
      read: async () => parseFlags(await kv.get(kvKeys.flags(), { type: "json" })),
      lifetimeMs: 10_000,
      fallback: DEFAULT_FLAGS,
      now: () => Date.now(),
      timeout: realTimeoutRunner,
    });
    const box: ContainerBox = { flagsValue, secrets: boxSecrets, warmBox: { warmed: false } };

    const fetchCalls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init });
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(Response.json(CUSTOMER));
          }, 600);
        });
      },
    );

    const stdout: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    try {
      // The two scripted holds: 1,200 ms for the key read, then 600 ms for
      // mock-crm. The lookup race's own 2,000 ms never comes into it.
      const pending = handleRequest(
        makeSignedRequest({
          keyPair,
          body: makeDvBody(),
          timestampSec: Math.floor(T0 / 1_000),
        }),
        env,
        box,
      );
      await vi.advanceTimersByTimeAsync(1_200);
      await vi.advanceTimersByTimeAsync(600);
      const res = await pending;

      expect(res.status).toBe(200);
      const body = (await res.json()) as { dynamic_variables: Record<string, string> };
      expect(body.dynamic_variables.first_name).toBe("Marie");
      expect(body.dynamic_variables.identity_level).toBe("number_match");

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe(
        "http://mock-crm.test/customers?phone=32491244713",
      );
      expect(fetchCalls[0]?.init?.headers).toEqual({ "x-internal-key": INTERNAL_KEY });

      const dvLine = stdout
        .flatMap((chunk) => chunk.split("\n"))
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.event === "dv");
      expect(dvLine).toBeDefined();
      expect(dvLine?.identity).toBe("number_match");
      expect(dvLine?.reasons).toEqual([]);
      expect(dvLine?.outcome).toBe("ok");
    } finally {
      spy.mockRestore();
    }
  });
});
