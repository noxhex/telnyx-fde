import { describe, expect, it } from "vitest";

import { createMemoryCache } from "../src/memory-cache.js";

import { createClockFake } from "./fakes/clock.js";

describe("createMemoryCache", () => {
  it("rejects a ttl of zero, negative, NaN, +/-Infinity, a non-number and a non-function clock", () => {
    const clock = createClockFake(1_000);
    for (const bad of [0, -1, NaN, Infinity, -Infinity, "1000" as unknown as number]) {
      expect(() => createMemoryCache(bad, clock.now)).toThrow(RangeError);
    }
    expect(() =>
      createMemoryCache(1_000, null as unknown as () => number),
    ).toThrow(TypeError);
  });

  it("serves a stored value until the ttl, misses at exactly the ttl and past it", () => {
    const clock = createClockFake(10_000);
    const cache = createMemoryCache<string>(1_000, clock.now);
    cache.set("k", "v");
    clock.advance(999);
    expect(cache.get("k")).toBe("v");
    clock.advance(1);
    expect(cache.get("k")).toBeUndefined();
    clock.advance(100_000);
    expect(cache.get("k")).toBeUndefined();
  });

  it("misses keys that were never set and treats get of a missing key as read-only", () => {
    const clock = createClockFake(0);
    const cache = createMemoryCache<number>(1_000, clock.now);
    expect(cache.get("nope")).toBeUndefined();
    cache.set("k", 1);
    clock.advance(2_000);
    expect(cache.get("nope")).toBeUndefined();
    expect(cache.get("k")).toBeUndefined();
  });

  it("expires per key, so one key's expiry does not touch another", () => {
    const clock = createClockFake(0);
    const cache = createMemoryCache<string>(1_000, clock.now);
    cache.set("a", "1");
    clock.advance(500);
    cache.set("b", "2");
    clock.advance(600);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
  });

  it("a later set overwrites value and write time", () => {
    const clock = createClockFake(0);
    const cache = createMemoryCache<string>(1_000, clock.now);
    cache.set("k", "old");
    clock.advance(900);
    cache.set("k", "new");
    clock.advance(900);
    expect(cache.get("k")).toBe("new");
  });

  it("fails closed while the clock reads non-finite: every get misses and no set is kept", () => {
    let t = 5_000;
    const cache = createMemoryCache<string>(1_000, () => t);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");

    // A read on a broken clock cannot prove the entry fresh, so it is
    // dropped: once the clock recovers the key still misses.
    t = NaN;
    expect(cache.get("k")).toBeUndefined();
    cache.set("n", "written-on-broken-clock");
    t = 6_000;
    expect(cache.get("n")).toBeUndefined();
    expect(cache.get("k")).toBeUndefined();

    t = Infinity;
    cache.set("i", "also-dropped");
    t = 6_500;
    expect(cache.get("i")).toBeUndefined();
  });

  it("drops an existing entry on a set during a broken clock instead of keeping the old value", () => {
    let t = 1_000;
    const cache = createMemoryCache<string>(1_000, () => t);
    cache.set("k", "old");
    t = NaN;
    cache.set("k", "new");
    t = 1_500;
    expect(cache.get("k")).toBeUndefined();
  });

  it("has and peekAt follow get: live entry reports both, any miss reports neither", () => {
    const clock = createClockFake(2_000);
    const cache = createMemoryCache<string>(1_000, clock.now);
    expect(cache.has("k")).toBe(false);
    expect(cache.peekAt("k")).toBeUndefined();
    cache.set("k", "v");
    expect(cache.has("k")).toBe(true);
    expect(cache.peekAt("k")).toBe(2_000);
    clock.advance(1_000);
    expect(cache.has("k")).toBe(false);
    expect(cache.peekAt("k")).toBeUndefined();
  });

  it("set rejects undefined, a non-string key and an empty key; readers miss a non-string key", () => {
    const clock = createClockFake(0);
    const cache = createMemoryCache<string | undefined>(1_000, clock.now);
    expect(() => cache.set("k", undefined)).toThrow(TypeError);
    expect(() => cache.set(1 as unknown as string, "v")).toThrow(TypeError);
    expect(() => cache.set("", "v")).toThrow(TypeError);
    expect(cache.get(1 as unknown as string)).toBeUndefined();
    expect(cache.has(null as unknown as string)).toBe(false);
    expect(cache.peekAt(undefined as unknown as string)).toBeUndefined();
  });

  it("deep-freezes plain data at write time, so a mutating reader cannot corrupt the next hit", () => {
    const clock = createClockFake(0);
    const cache = createMemoryCache<{ nested: { flag: boolean }; list: number[] }>(
      1_000,
      clock.now,
    );
    const value = { nested: { flag: false }, list: [1, 2] };
    cache.set("k", value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(() => {
      value.nested.flag = true;
    }).toThrow(TypeError);
    expect(cache.get("k")?.nested.flag).toBe(false);
  });

  it("stores handles by reference without freezing them", () => {
    const clock = createClockFake(0);
    const handle = { count: 0 };
    Object.setPrototypeOf(handle, { tag: "handle" });
    const cache = createMemoryCache<typeof handle>(1_000, clock.now);
    cache.set("k", handle);
    expect(cache.get("k")).toBe(handle);
    expect(Object.isFrozen(handle)).toBe(false);
    handle.count = 3;
    expect(cache.get("k")?.count).toBe(3);
  });
});
