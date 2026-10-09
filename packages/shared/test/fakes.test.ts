import type { ActorStorage, KvNamespace } from "@telnyx/edge-runtime";
import { describe, expect, it } from "vitest";

import { createActorStorageFake } from "./fakes/actor-storage.js";
import { createClockFake } from "./fakes/clock.js";
import { createKvFake } from "./fakes/kv.js";

describe("clock fake", () => {
  it("starts at a given instant and advances", () => {
    const clock = createClockFake(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(50);
    expect(clock.now()).toBe(1050);
  });

  it("defaults to zero when no start is given", () => {
    const clock = createClockFake();
    expect(clock.now()).toBe(0);
    clock.advance(7);
    expect(clock.now()).toBe(7);
  });

  it("advances by fractional milliseconds", () => {
    const clock = createClockFake(0);
    clock.advance(0.4);
    expect(clock.now()).toBeCloseTo(0.4);
  });
});

describe("KV fake", () => {
  function makeKv() {
    const clock = createClockFake(0);
    const kv = createKvFake(() => clock.now());
    return { clock, kv };
  }

  it("returns null for a missing key", async () => {
    const { kv } = makeKv();
    expect(await kv.get("missing")).toBeNull();
  });

  it("round-trips text values", async () => {
    const { kv } = makeKv();
    await kv.put("k", "value");
    expect(await kv.get("k")).toBe("value");
  });

  it("round-trips JSON values", async () => {
    const { kv } = makeKv();
    await kv.put("j", JSON.stringify({ a: 1, b: "two" }));
    expect(await kv.get("j", { type: "json" })).toEqual({ a: 1, b: "two" });
  });

  it("returns the raw text when asking for text on a JSON-stored value", async () => {
    const { kv } = makeKv();
    await kv.put("j", JSON.stringify({ a: 1 }));
    expect(await kv.get("j")).toBe('{"a":1}');
  });

  it("deletes a key", async () => {
    const { kv } = makeKv();
    await kv.put("k", "v");
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
  });

  it("deleting a missing key does not throw", async () => {
    const { kv } = makeKv();
    await expect(kv.delete("missing")).resolves.toBeUndefined();
  });

  it("lists keys under a prefix", async () => {
    const { kv } = makeKv();
    await kv.put("a/1", "x");
    await kv.put("a/2", "y");
    await kv.put("b/3", "z");

    const result = await kv.list({ prefix: "a/" });
    expect(result.keys.map((k) => k.name).sort()).toEqual(["a/1", "a/2"]);
    expect(result.list_complete).toBe(true);

    expect(await kv.list({ prefix: "zz" })).toEqual({ keys: [], list_complete: true });
  });

  it("lists keys with no prefix as everything", async () => {
    const { kv } = makeKv();
    await kv.put("one", "1");
    await kv.put("two", "2");
    const result = await kv.list();
    expect(result.keys.map((k) => k.name).sort()).toEqual(["one", "two"]);
    expect(result.list_complete).toBe(true);
  });

  describe("expirationTtl", () => {
    it("honours the TTL against the injected clock in seconds", async () => {
      const { clock, kv } = makeKv();
      await kv.put("t", "value", { expirationTtl: 60 });

      // Just before the 60-second boundary it is still present.
      clock.advance(59_999);
      expect(await kv.get("t")).toBe("value");

      // At the 60-second boundary it is gone.
      clock.advance(1);
      expect(await kv.get("t")).toBeNull();
    });

    it("expires a short TTL quickly", async () => {
      const { clock, kv } = makeKv();
      await kv.put("s", "value", { expirationTtl: 1 });
      expect(await kv.get("s")).toBe("value");
      clock.advance(1_000);
      expect(await kv.get("s")).toBeNull();
    });

    it("keeps a value indefinitely when no TTL is given", async () => {
      const { clock, kv } = makeKv();
      await kv.put("p", "value");
      clock.advance(10_000_000);
      expect(await kv.get("p")).toBe("value");
    });
  });

  describe("edge cases", () => {
    it("returns null for a JSON get of a stored empty string", async () => {
      const { kv } = makeKv();
      await kv.put("empty", "");
      expect(await kv.get("empty", { type: "json" })).toBeNull();
      // A text read of the same key still round-trips the empty string.
      expect(await kv.get("empty")).toBe("");
    });

    it("throws for a non-finite expirationTtl", async () => {
      const { kv } = makeKv();
      for (const bad of [NaN, Infinity, -Infinity]) {
        await expect(kv.put("k", "v", { expirationTtl: bad })).rejects.toThrow();
      }
    });
  });

  describe("call recording", () => {
    it("starts with no recorded calls", async () => {
      const { kv } = makeKv();
      expect(kv.calls).toHaveLength(0);
    });

    it("records every call so a route can be asserted not to touch KV", async () => {
      const { kv } = makeKv();
      await kv.put("a", "x");
      await kv.get("a");
      await kv.delete("a");

      expect(kv.calls.map((c) => c.method)).toEqual(["put", "get", "delete"]);

      kv.reset();
      expect(kv.calls).toHaveLength(0);
    });
  });
});

describe("actor storage fake", () => {
  function makeStorage() {
    return createActorStorageFake();
  }

  it("returns undefined for a missing key", async () => {
    const store = makeStorage();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("round-trips values", async () => {
    const store = makeStorage();
    await store.put("k", { a: 1 });
    expect(await store.get("k")).toEqual({ a: 1 });
  });

  it("deletes a key", async () => {
    const store = makeStorage();
    await store.put("k", "v");
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });

  it("lists entries as a Map in key order", async () => {
    const store = makeStorage();
    await store.put("b", 2);
    await store.put("a", 1);
    const entries = await store.list<number>();
    expect([...entries.keys()]).toEqual(["a", "b"]);
    expect(entries.get("a")).toBe(1);
    expect(entries.get("b")).toBe(2);
  });

  it("deleteAll clears all stored state", async () => {
    const store = makeStorage();
    await store.put("a", 1);
    await store.put("b", 2);
    await store.deleteAll();
    expect(await store.list()).toEqual(new Map());
    expect(await store.get("a")).toBeUndefined();
  });

  describe("stored values are copies", () => {
    it("keeps its own copy, so changing the original after put changes nothing stored", async () => {
      const store = makeStorage();
      const value = { items: ["a"], count: 1 };
      await store.put("k", value);
      value.items.push("b");
      value.count = 99;
      expect(await store.get("k")).toEqual({ items: ["a"], count: 1 });
    });

    it("hands back a copy from get, so changing the result changes nothing stored", async () => {
      const store = makeStorage();
      await store.put("k", { nested: { n: 1 } });
      const first = await store.get<{ nested: { n: number } }>("k");
      expect(first).toBeDefined();
      if (first === undefined) {
        throw new Error("expected the key to exist");
      }
      first.nested.n = 42;
      expect(await store.get("k")).toEqual({ nested: { n: 1 } });
    });

    it("hands back copies from list too", async () => {
      const store = makeStorage();
      await store.put("k", { n: 1 });
      const entries = await store.list<{ n: number }>();
      const listed = entries.get("k");
      expect(listed).toBeDefined();
      if (listed === undefined) {
        throw new Error("expected the key to be listed");
      }
      listed.n = 42;
      expect(await store.get("k")).toEqual({ n: 1 });
    });
  });

  describe("rejected values", () => {
    it("throws for a function", async () => {
      const store = makeStorage();
      await expect(store.put("k", () => 1)).rejects.toThrow(/function/i);
    });

    it("throws for a class instance", async () => {
      class Thing {}
      const store = makeStorage();
      await expect(store.put("k", new Thing())).rejects.toThrow(/class instance/i);
    });

    it("throws for a circular reference", async () => {
      const store = makeStorage();
      const loop: Record<string, unknown> = { name: "loop" };
      loop.self = loop;
      await expect(store.put("k", loop)).rejects.toThrow(/circular/i);
    });
  });

  it("setAlarm, getAlarm and deleteAlarm work together", async () => {
    const store = makeStorage();
    expect(await store.getAlarm()).toBeNull();
    await store.setAlarm(1_700_000_000_000);
    expect(await store.getAlarm()).toBe(1_700_000_000_000);
    await store.deleteAlarm();
    expect(await store.getAlarm()).toBeNull();
  });

  it("setAlarm replaces any earlier alarm", async () => {
    const store = makeStorage();
    await store.setAlarm(1000);
    await store.setAlarm(2000);
    expect(await store.getAlarm()).toBe(2000);
  });

  it("deleteAll does not clear the alarm", async () => {
    const store = makeStorage();
    await store.put("a", 1);
    await store.setAlarm(5000);
    await store.deleteAll();
    expect(await store.list()).toEqual(new Map());
    expect(await store.getAlarm()).toBe(5000);
  });

  describe("list options", () => {
    async function seeded() {
      const store = createActorStorageFake();
      await store.put("a/1", 1);
      await store.put("a/2", 2);
      await store.put("b/1", 3);
      return store;
    }

    it("filters by prefix, in key order", async () => {
      const store = await seeded();
      const entries = await store.list({ prefix: "a/" });
      expect([...entries.keys()]).toEqual(["a/1", "a/2"]);
      expect(entries.get("a/1")).toBe(1);
    });

    it("honours start (inclusive), startAfter (exclusive) and end (exclusive)", async () => {
      const store = await seeded();
      expect([...(await store.list({ start: "a/2" })).keys()]).toEqual(["a/2", "b/1"]);
      expect([...(await store.list({ startAfter: "a/1" })).keys()]).toEqual(["a/2", "b/1"]);
      expect([...(await store.list({ start: "a/2", end: "b/1" })).keys()]).toEqual(["a/2"]);
    });

    it("honours limit and reverse", async () => {
      const store = await seeded();
      expect([...(await store.list({ limit: 2 })).keys()]).toEqual(["a/1", "a/2"]);
      expect([...(await store.list({ reverse: true })).keys()]).toEqual(["b/1", "a/2", "a/1"]);
    });
  });
});

describe("fakes take the shape of the real bindings", () => {
  it("the KV fake is assignable to KvNamespace", () => {
    const kv = createKvFake(() => 0);
    const asReal: KvNamespace = kv;
    expect(asReal).toBe(kv);
  });

  it("the actor storage fake is assignable to the ActorStorage surface the adapters use", () => {
    const store = createActorStorageFake();
    const asReal: Pick<
      ActorStorage,
      "get" | "put" | "delete" | "list" | "deleteAll" | "setAlarm" | "getAlarm" | "deleteAlarm"
    > = store;
    expect(asReal).toBe(store);
  });
});