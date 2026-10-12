import { describe, expect, it } from "vitest";

import { kvKeys } from "@duinvezel/shared";

import { hasValidInternalKey } from "../src/auth.js";
import { SECRET_READ_TIMEOUT_MS } from "../src/index.js";
import { TIMED_OUT } from "../src/flags.js";
import {
  DEMO_PHONE_HANDLE,
  hold,
  INTERNAL_KEY_HANDLE,
  makeHarness,
  manualTimeout,
  TEST_INTERNAL_KEY,
  tick,
} from "./helpers.js";
import type { HeldPromise } from "./helpers.js";

describe("hasValidInternalKey", () => {
  it("accepts the exact key", () => {
    expect(hasValidInternalKey(TEST_INTERNAL_KEY, TEST_INTERNAL_KEY)).toBe(true);
  });

  it("rejects a key that differs in one character", () => {
    expect(hasValidInternalKey(`${TEST_INTERNAL_KEY}x`, TEST_INTERNAL_KEY)).toBe(false);
    expect(hasValidInternalKey(TEST_INTERNAL_KEY.slice(0, -1), TEST_INTERNAL_KEY)).toBe(false);
  });

  it("rejects a key of a different length without throwing", () => {
    expect(hasValidInternalKey("short", TEST_INTERNAL_KEY)).toBe(false);
  });

  it("rejects null on either side", () => {
    expect(hasValidInternalKey(null, TEST_INTERNAL_KEY)).toBe(false);
    expect(hasValidInternalKey(TEST_INTERNAL_KEY, null)).toBe(false);
  });
});

describe("internal key on the routes", () => {
  it("answers 401 when the header is missing, before any state access of its own", async () => {
    const h = makeHarness();
    const res = await h.call("/customers?phone=3258000001", { key: null });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    // The only KV touch is the warm-up's flags read (the T20 exception);
    // the 401 itself waits for nothing and reads no document.
    expect(h.kv.calls.filter((c) => c.method === "put")).toHaveLength(0);
    expect(h.kv.calls.map((c) => c.key)).toEqual([kvKeys.flags()]);
  });

  it("answers 401 for a wrong key, using no flags of its own", async () => {
    const h = makeHarness();
    await h.setFlags({ crm_delay_ms: 0, crm_fail: false });
    h.kv.reset(); // forget the seeding write; only the request counts
    const res = await h.call("/customers?phone=3258000001", { key: "not-the-key" });

    expect(res.status).toBe(401);
    // Auth comes first: beyond the one warm-up flags read (T20), the
    // request reads no document before rejecting.
    expect(h.kv.calls.map((c) => c.key)).toEqual([kvKeys.flags()]);
  });

  it("serves the request with the right key", async () => {
    const h = makeHarness();
    const res = await h.call("/customers?phone=3258000001", { key: TEST_INTERNAL_KEY });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountNumber: "DV-100002" });
  });

  it("fails closed when the INTERNAL_KEY secret cannot be resolved", async () => {
    const h = makeHarness({ internalKey: null });
    const res = await h.call("/customers?phone=3258000001");

    expect(res.status).toBe(401);
  });

  it("counts a secret read that cannot answer in time as missing (401)", async () => {
    const h = makeHarness();
    let timerMs = -1;
    let fireTimer!: () => void;
    // The secret read never settles; only the injected timer can end the wait.
    h.setReadSecret(() => new Promise<string | null>(() => {}));
    h.deps.timeout = <T>(fn: () => Promise<T>, ms: number) =>
      new Promise<T | typeof TIMED_OUT>((resolve) => {
        timerMs = ms;
        void fn();
        fireTimer = () => {
          resolve(TIMED_OUT);
        };
      });

    const pending = h.call("/customers?phone=3258000001");
    fireTimer();
    const res = await pending;

    expect(res.status).toBe(401);
    expect(timerMs).toBe(SECRET_READ_TIMEOUT_MS);
  });

  it("reads INTERNAL_KEY after routing and before the auth check, once per container", async () => {
    const h = makeHarness();
    await h.call("/customers?phone=3258000001", { key: "nope" });

    // The warm-up read, shared by this request: exactly one read of each
    // handle, and the key check happens before any flags wait.
    expect(h.secretReads).toEqual([INTERNAL_KEY_HANDLE, DEMO_PHONE_HANDLE]);
  });

  it("logs the 401 without a caller or account", async () => {
    const h = makeHarness();
    await h.call("/accounts/DV-100002", { key: "nope" });

    const log = h.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === "crm_request");
    expect(log).toMatchObject({ event: "crm_request", route: "accounts", status: 401 });
    expect(log).not.toHaveProperty("caller");
    expect(log).not.toHaveProperty("account");
  });
});

describe("the bounded INTERNAL_KEY read, kept per container (T10 follow-up)", () => {
  it("answers 200 when the read settles after 300 ms but before the 1,000 ms timer fires", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const held = hold<string | null>();
    h.setReadSecret(() => held.promise);

    const pending = h.call("/accounts/DV-100002");
    await tick();
    const timer = manual.timers[0];
    expect(timer?.ms).toBe(SECRET_READ_TIMEOUT_MS);
    expect(timer?.ms).toBe(1_000);

    // The read lands after 300 ms but before the timer fires.
    h.clock.advance(300);
    held.resolve(TEST_INTERNAL_KEY);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(timer?.fired).toBe(false);
  });

  it("answers 401 when the timer wins; the late success is kept, so the next request needs no new read", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const reads: string[] = [];
    const heldByHandle = new Map<string, HeldPromise<string | null>[]>();
    h.setReadSecret((handle) => {
      reads.push(handle);
      const held = hold<string | null>();
      const list = heldByHandle.get(handle) ?? [];
      list.push(held);
      heldByHandle.set(handle, list);
      return held.promise;
    });

    const pending = h.call("/accounts/DV-100002");
    await tick();
    manual.timers[0]?.fire();
    const res = await pending;
    expect(res.status).toBe(401);

    // Settling that read afterwards changes nothing for the answered request
    // — but the late success is kept, so the next request needs no new read.
    heldByHandle.get(INTERNAL_KEY_HANDLE)?.[0]?.resolve(TEST_INTERNAL_KEY);
    await tick();
    const second = await h.call("/accounts/DV-100002");

    expect(second.status).toBe(200);
    expect(reads.filter((r) => r === INTERNAL_KEY_HANDLE)).toHaveLength(1);
  });
});
