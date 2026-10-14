import { describe, expect, it } from "vitest";

import { createLogger } from "@duinvezel/shared";
import type { CreateSessionResult, DisclosureResult, SessionDoc } from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import { createKvFake } from "../../../packages/shared/test/fakes/kv.js";
import type { KvFake } from "../../../packages/shared/test/fakes/kv.js";

import type { AccountsClient, RecordCallOutcome } from "../src/clients/accounts.js";
import type { CrmCallResult, CrmClient } from "../src/clients/crm.js";
import type { SessionsClient } from "../src/clients/sessions.js";
import { TIMED_OUT } from "../src/config.js";
import type { TimeoutRunner } from "../src/config.js";
import type { SecretsDep, VoiceContextDeps } from "../src/deps.js";
import { handleInternalHealth } from "../src/routes/internal-health.js";

const T0 = 1_600_000_000_000;
const INTERNAL_KEY = "test-internal-key-health";

interface HeldPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
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

async function tick(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

interface ChecksBody {
  ok: boolean;
  checks: {
    kv: { ok: boolean; latency_ms: number };
    crm: { ok: boolean; latency_ms: number };
    customer_account: { ok: boolean; latency_ms: number };
    session: { ok: boolean; latency_ms: number };
  };
}

interface Harness {
  deps: VoiceContextDeps;
  kv: KvFake;
  crmCalls: string[];
  snapshots: string[];
  sessionGets: string[];
  lines: string[];
  failKvPut: { current: boolean };
  kvGetOverride: { current: string | null | "error" };
  crmQueue: Array<CrmCallResult>;
  failAccount: { current: boolean };
  sessionGet: { current: Promise<SessionDoc | null> | null };
  firePending(): void;
  timerMs(): number[];
  call(key?: string | null): Promise<{ status: number; body: ChecksBody | Record<string, unknown> }>;
  lastLog(): Record<string, unknown>;
}

function makeHarness(): Harness {
  const clock = createClockFake(T0);
  const kv = createKvFake(clock.now);
  const crmCalls: string[] = [];
  const snapshots: string[] = [];
  const sessionGets: string[] = [];
  const lines: string[] = [];
  const failKvPut = { current: false };
  const kvGetOverride = { current: null as string | null | "error" };
  const crmQueue: CrmCallResult[] = [];
  const failAccount = { current: false };
  const sessionGet: { current: Promise<SessionDoc | null> | null } = { current: null };

  const kvProxy: KvFake = {
    get: ((key: string, options?: never) => {
      // Record only the calls the inner fake never sees; delegation records itself.
      if (kvGetOverride.current !== null) {
        kv.calls.push({ method: "get", key, options: options as never });
      }
      if (kvGetOverride.current === "error") {
        return Promise.reject(new Error("kv get down"));
      }
      if (kvGetOverride.current !== null) {
        return Promise.resolve(kvGetOverride.current);
      }
      return (kv.get as (k: never, o: never) => Promise<unknown>)(key as never, options as never);
    }) as KvFake["get"],
    put: async (key, value, options) => {
      if (failKvPut.current) {
        kv.calls.push({ method: "put", key, options });
        throw new Error("kv put down");
      }
      await kv.put(key, value, options);
    },
    delete: kv.delete.bind(kv),
    list: kv.list.bind(kv),
    calls: kv.calls,
    reset: () => kv.reset(),
  };

  const crm: CrmClient = {
    lookupByPhone: (digits) => {
      crmCalls.push(digits);
      if (crmQueue.length > 0) {
        return Promise.resolve(crmQueue.shift() as CrmCallResult);
      }
      return Promise.resolve({ ok: true, answer: { kind: "not_found" } });
    },
  };
  const accounts: AccountsClient = {
    recordCall: (): Promise<RecordCallOutcome> => {
      throw new Error("recordCall must not be called by health");
    },
    snapshot: (accountNumber) => {
      snapshots.push(accountNumber);
      return failAccount.current
        ? Promise.reject(new Error("actor down"))
        : Promise.resolve({ v: 1, calls: [], verify: { failures: 0, lockedUntil: null }, tickets: [] });
    },
  };
  const sessions: SessionsClient = {
    create: (): Promise<CreateSessionResult> => {
      throw new Error("create must not be called by health");
    },
    markDisclosure: (): Promise<DisclosureResult> => {
      throw new Error("markDisclosure must not be called by health");
    },
    get: (sid, _input) => {
      sessionGets.push(sid);
      return sessionGet.current ?? Promise.resolve(null);
    },
  };
  const secrets: SecretsDep = {
    get: (handle) => Promise.resolve(handle === "INTERNAL_KEY" ? INTERNAL_KEY : null),
    getKey: () => Promise.resolve(null),
  };

  interface Entry {
    ms: number;
    fired: boolean;
    settled: boolean;
    fire(): void;
  }
  const entries: Entry[] = [];
  const timeout: TimeoutRunner = <T>(fn: () => Promise<T>, ms: number) =>
    new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
      let done = false;
      const entry: Entry = {
        ms,
        fired: false,
        settled: false,
        fire() {
          if (!done) {
            done = true;
            this.fired = true;
            resolve(TIMED_OUT);
          }
        },
      };
      entries.push(entry);
      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            if (!done) {
              done = true;
              entry.settled = true;
              resolve(value);
            }
          },
          (error: unknown) => {
            if (!done) {
              done = true;
              entry.settled = true;
              reject(error);
            }
          },
        );
    });

  const deps: VoiceContextDeps = {
    now: clock.now,
    kv: kvProxy,
    crm,
    accounts,
    sessions,
    caches: {
      areas: { get: () => undefined, peekAt: () => undefined, has: () => false, set: () => {} },
      crm: { get: () => undefined, peekAt: () => undefined, has: () => false, set: () => {} },
    },
    // The route never reads the flags: any use fails the test.
    flagsValue: {
      get: () => Promise.reject(new Error("flagsValue must not be read by internal-health")),
      start: () => {
        throw new Error("flagsValue must not be started by internal-health");
      },
    },
    secrets,
    log: createLogger(
      "voice-context",
      (line) => {
        lines.push(line);
      },
      clock.now,
    ),
    random: (n) => new Uint8Array(n),
    timeout,
  };

  return {
    deps,
    kv,
    crmCalls,
    snapshots,
    sessionGets,
    lines,
    failKvPut,
    kvGetOverride,
    crmQueue,
    failAccount,
    sessionGet,
    firePending() {
      for (const entry of entries.filter((e) => !e.fired && !e.settled)) {
        entry.fire();
      }
    },
    timerMs() {
      return entries.map((e) => e.ms);
    },
    async call(key) {
      const headers: Record<string, string> = {};
      if (key !== null && key !== undefined) {
        headers["x-internal-key"] = key;
      }
      const res = await handleInternalHealth(
        new Request("http://voice-context.test/internal/health", { headers }),
        deps,
      );
      return { status: res.status, body: (await res.json()) as ChecksBody };
    },
    lastLog() {
      if (lines.length === 0) {
        throw new Error("no log lines captured");
      }
      return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    },
  };
}

describe("handleInternalHealth auth", () => {
  it("no key answers 401 with no KV or actor access", async () => {
    const h = makeHarness();
    const { status, body } = await h.call(null);
    expect(status).toBe(401);
    expect(body).toEqual({ error: "unauthorized" });
    expect(h.kv.calls).toEqual([]);
    expect(h.crmCalls).toEqual([]);
    expect(h.snapshots).toEqual([]);
    expect(h.sessionGets).toEqual([]);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", reason: "bad_key", status: 401 });
  });

  it("a wrong key answers 401 with no KV or actor access", async () => {
    const h = makeHarness();
    const { status } = await h.call("definitely-wrong");
    expect(status).toBe(401);
    expect(h.kv.calls).toEqual([]);
    expect(h.snapshots).toEqual([]);
    expect(h.sessionGets).toEqual([]);
  });
});

describe("handleInternalHealth checks", () => {
  it("answers 200 with every check ok, each carrying its latency, from the canary inputs", async () => {
    const h = makeHarness();
    h.crmQueue.push({
      ok: true,
      answer: {
        kind: "customer",
        customer: {
          accountNumber: "DV-100002",
          firstName: "Marie",
          postcode: "8630",
          areaName: "Veurne",
          lineId: "LN-000002",
        },
      },
    });
    const { status, body } = await h.call(INTERNAL_KEY);
    expect(status).toBe(200);
    const checks = (body as ChecksBody).checks;
    expect((body as ChecksBody).ok).toBe(true);
    for (const [name, check] of Object.entries(checks)) {
      expect(check.ok, `check ${name} must be ok`).toBe(true);
      expect(typeof check.latency_ms, `check ${name} must carry latency_ms`).toBe("number");
      expect(check.latency_ms).toBeGreaterThanOrEqual(0);
    }
    // The canary's inputs: the probe round trip, the real customer lookup,
    // CANARY-0 and the all-zeros sid.
    expect(h.crmCalls).toEqual(["3258000001"]);
    expect(h.snapshots).toEqual(["CANARY-0"]);
    expect(h.sessionGets).toEqual(["00000000000000000000000000000000"]);
    const puts = h.kv.calls.filter((c) => c.method === "put");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.options).toEqual({ expirationTtl: 60 });
    expect(h.lastLog()).toMatchObject({ event: "health", ok: true, status: 200 });
  });

  it("gives every check the card's timeout", async () => {
    const h = makeHarness();
    h.crmQueue.push({ ok: true, answer: { kind: "not_found" } });
    await h.call(INTERNAL_KEY);
    expect(h.timerMs()).toEqual([2_000, 2_500, 1_500, 1_000, 1_000, 1_500]);
  });

  it("answers 503 when the KV put fails", async () => {
    const h = makeHarness();
    h.failKvPut.current = true;
    const { status, body } = await h.call(INTERNAL_KEY);
    expect(status).toBe(503);
    const checks = (body as ChecksBody).checks;
    expect(checks.kv.ok).toBe(false);
    expect(checks.crm.ok).toBe(false); // default crm stub answers not_found
  });

  it("answers 503 when the probe value does not round trip", async () => {
    const h = makeHarness();
    h.kvGetOverride.current = "not-the-probe-value";
    const { status, body } = await h.call(INTERNAL_KEY);
    expect(status).toBe(503);
    expect((body as ChecksBody).checks.kv.ok).toBe(false);
  });

  it("answers 503 when the CRM lookup fails", async () => {
    const h = makeHarness();
    h.crmQueue.push({ ok: false });
    const { status, body } = await h.call(INTERNAL_KEY);
    expect(status).toBe(503);
    const checks = (body as ChecksBody).checks;
    expect(checks.crm.ok).toBe(false);
    expect(checks.kv.ok).toBe(true);
    expect(checks.customer_account.ok).toBe(true);
    expect(checks.session.ok).toBe(true);
  });

  it("answers 503 when the account snapshot fails, and when the session get fails", async () => {
    const h = makeHarness();
    h.crmQueue.push({ ok: true, answer: { kind: "not_found" } });
    h.failAccount.current = true;
    const first = await h.call(INTERNAL_KEY);
    expect(first.status).toBe(503);
    expect((first.body as ChecksBody).checks.customer_account.ok).toBe(false);
    expect((first.body as ChecksBody).checks.session.ok).toBe(true);

    const h2 = makeHarness();
    h2.crmQueue.push({ ok: true, answer: { kind: "not_found" } });
    h2.sessionGet.current = Promise.reject(new Error("session actor down"));
    const second = await h2.call(INTERNAL_KEY);
    expect(second.status).toBe(503);
    expect((second.body as ChecksBody).checks.session.ok).toBe(false);
    expect((second.body as ChecksBody).checks.customer_account.ok).toBe(true);
  });

  it("a held check times out into 503, and a late settle changes nothing", async () => {
    const h = makeHarness();
    h.crmQueue.push({ ok: true, answer: { kind: "not_found" } });
    const held = hold<SessionDoc | null>();
    h.sessionGet.current = held.promise;
    const pending = h.call(INTERNAL_KEY);
    await tick();
    h.firePending();
    const { status, body } = await pending;
    expect(status).toBe(503);
    expect((body as ChecksBody).checks.session.ok).toBe(false);
    expect(h.lastLog()).toMatchObject({ event: "health", ok: false, status: 503 });
    held.resolve(null);
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"health"'))).toHaveLength(1);
  });
});
