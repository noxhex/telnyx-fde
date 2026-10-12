import { describe, expect, it } from "vitest";

import { kvKeys } from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import { createKvFake } from "../../../packages/shared/test/fakes/kv.js";

import {
  DEFAULT_FLAGS,
  FLAGS_CACHE_TTL_MS,
  FLAGS_TIMEOUT_MS,
  parseFlags,
  readFlagsDocument,
} from "../src/flags.js";

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

describe("the production flags timing (T20)", () => {
  it("keeps the cache lifetime at ten seconds and the request's wait bound at 1,000 ms", () => {
    // The refreshing flags value's lifetime and the bound a keyed request
    // waits when no read has ever succeeded, pinned to the card's values.
    expect(FLAGS_CACHE_TTL_MS).toBe(10_000);
    expect(FLAGS_TIMEOUT_MS).toBe(1_000);
  });
});

describe("readFlagsDocument", () => {
  it("reads flags/global and resolves with the parsed document", async () => {
    const clock = createClockFake(0);
    const kv = createKvFake(clock.now);
    await kv.put(kvKeys.flags(), JSON.stringify({ crm_delay_ms: 500, crm_fail: true }));

    await expect(readFlagsDocument(kv)).resolves.toEqual({ delayMs: 500, fail: true });
    expect(kv.calls.filter((c) => c.method === "get")).toEqual([
      { method: "get", key: kvKeys.flags(), options: { type: "json" } },
    ]);
  });

  it("a missing key is an answer: it resolves with the defaults, like any other answer", async () => {
    const clock = createClockFake(0);
    const kv = createKvFake(clock.now);

    await expect(readFlagsDocument(kv)).resolves.toEqual(DEFAULT_FLAGS);
  });

  it("a document with an invalid flag falls back flag by flag and still resolves", async () => {
    const clock = createClockFake(0);
    const kv = createKvFake(clock.now);
    await kv.put(kvKeys.flags(), JSON.stringify({ crm_delay_ms: -10, crm_fail: true }));
    await expect(readFlagsDocument(kv)).resolves.toEqual({ delayMs: 0, fail: true });
  });

  it("a stored blob that is not JSON at all fails the read, like any KV error", async () => {
    const clock = createClockFake(0);
    const kv = createKvFake(clock.now);
    await kv.put(kvKeys.flags(), "{not json");
    await expect(readFlagsDocument(kv)).rejects.toThrow();
  });

  it("rejects when the KV read itself fails, so the failed read keeps nothing", async () => {
    const broken = {
      get: () => Promise.reject(new Error("kv down")),
    };
    await expect(
      readFlagsDocument(broken as never),
    ).rejects.toThrow("kv down");
  });
});
