import { describe, expect, it } from "vitest";

import { kvKeys } from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import { createKvFake } from "../../../packages/shared/test/fakes/kv.js";

import {
  DEFAULT_FLAGS,
  FLAGS_CACHE_TTL_MS,
  FLAGS_TIMEOUT_MS,
  getFlags,
  parseFlags,
  TIMED_OUT,
} from "../src/flags.js";
import type { TimeoutRunner } from "../src/flags.js";

/** Immediate runner: the task always wins, the timer never fires. */
const noTimeout: TimeoutRunner = <T>(fn: () => Promise<T>) => fn();

describe("parseFlags", () => {
  it("falls back to the defaults on missing input", () => {
    expect(parseFlags(null)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags(undefined)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags({})).toEqual(DEFAULT_FLAGS);
    expect(parseFlags("some string")).toEqual(DEFAULT_FLAGS);
  });

  it("honours valid values", () => {
    expect(parseFlags({ crm_delay_ms: 250, crm_fail: true })).toEqual({
      delayMs: 250,
      fail: true,
    });
    expect(parseFlags({ crm_delay_ms: 0, crm_fail: false })).toEqual({
      delayMs: 0,
      fail: false,
    });
  });

  it("treats a delay that is not a finite, non-negative number as invalid", () => {
    for (const bad of [-1, "250", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(parseFlags({ crm_delay_ms: bad, crm_fail: true })).toEqual({
        delayMs: 0,
        fail: true,
      });
    }
  });

  it("falls back per flag: one bad flag keeps the other", () => {
    expect(parseFlags({ crm_delay_ms: 250, crm_fail: "yes" })).toEqual({
      delayMs: 250,
      fail: false,
    });
  });

  it("ignores flags owned by other functions", () => {
    expect(
      parseFlags({ crm_delay_ms: 10, crm_fail: false, incident_threshold: 3 }),
    ).toEqual({ delayMs: 10, fail: false });
  });
});

describe("getFlags", () => {
  it("reads flags/global from KV once per ten seconds", async () => {
    const clock = createClockFake(0);
    const kv = createKvFake(clock.now);
    await kv.put(kvKeys.flags(), JSON.stringify({ crm_delay_ms: 500 }));
    const box = { current: null };

    expect(await getFlags(kv, clock.now, box, noTimeout)).toEqual({
      delayMs: 500,
      fail: false,
    });
    expect(await getFlags(kv, clock.now, box, noTimeout)).toEqual({
      delayMs: 500,
      fail: false,
    });

    const gets = kv.calls.filter(
      (c) => c.method === "get" && c.key === kvKeys.flags(),
    );
    expect(gets).toHaveLength(1);
  });

  it("re-reads once the cache is older than ten seconds", async () => {
    const clock = createClockFake(0);
    const kv = createKvFake(clock.now);
    await kv.put(kvKeys.flags(), JSON.stringify({ crm_fail: true }));
    const box = { current: null };

    expect(await getFlags(kv, clock.now, box, noTimeout)).toEqual({
      delayMs: 0,
      fail: true,
    });
    clock.advance(FLAGS_CACHE_TTL_MS);
    await kv.put(kvKeys.flags(), JSON.stringify({ crm_fail: false }));

    expect(await getFlags(kv, clock.now, box, noTimeout)).toEqual({
      delayMs: 0,
      fail: false,
    });
    expect(kv.calls.filter((c) => c.method === "get")).toHaveLength(2);
  });

  it("falls back to defaults when KV holds invalid JSON or nothing", async () => {
    const clock = createClockFake(0);
    const kv = createKvFake(clock.now);
    const box = { current: null };

    expect(await getFlags(kv, clock.now, box, noTimeout)).toEqual(DEFAULT_FLAGS);

    box.current = null;
    await kv.put(kvKeys.flags(), "{not json");
    expect(await getFlags(kv, clock.now, box, noTimeout)).toEqual(DEFAULT_FLAGS);
  });

  it("never trusts the cache when the clock is not finite", async () => {
    const clock = createClockFake(0);
    const kv = createKvFake(clock.now);
    await kv.put(kvKeys.flags(), JSON.stringify({ crm_delay_ms: 40 }));
    const box = { current: null };
    const brokenNow = () => Number.NaN;

    expect(await getFlags(kv, brokenNow, box, noTimeout)).toEqual({
      delayMs: 40,
      fail: false,
    });
    expect(await getFlags(kv, brokenNow, box, noTimeout)).toEqual({
      delayMs: 40,
      fail: false,
    });

    // Every call went back to KV: no cache entry is ever trusted.
    expect(kv.calls.filter((c) => c.method === "get")).toHaveLength(2);
  });
});

describe("getFlags timeout", () => {
  it("gives up on a hanging KV read after 300 ms and uses the defaults", async () => {
    const clock = createClockFake(0);
    // A KV whose read never settles; only the injected timer can end this.
    const hangingKv = {
      get: () => new Promise(() => {}),
    } as unknown as ReturnType<typeof createKvFake>;
    let timerMs = -1;
    let fireTimer!: () => void;
    const manualTimeout: TimeoutRunner = <T>(fn: () => Promise<T>, ms: number) =>
      new Promise((resolve) => {
        timerMs = ms;
        void fn(); // starts the hanging read; its settlement is ignored
        fireTimer = () => {
          resolve(TIMED_OUT);
        };
      });

    const pending = getFlags(hangingKv, clock.now, { current: null }, manualTimeout);
    fireTimer();

    expect(timerMs).toBe(FLAGS_TIMEOUT_MS);
    expect(timerMs).toBe(300);
    await expect(pending).resolves.toEqual(DEFAULT_FLAGS);
  });
});
