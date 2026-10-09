import { describe, expect, it } from "vitest";

import { startTimings } from "../src/index.js";
import type { Hop } from "../src/index.js";

// A tiny controllable clock so timing is fully deterministic.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// A promise the test settles by hand, so the fake clock can advance while a
// wrapped call is genuinely pending. No real time ever passes in these tests.
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("startTimings", () => {
  it("reports total as the wall time since start", () => {
    const clock = makeClock(1000);
    const timings = startTimings(clock.now);
    clock.advance(200);
    expect(timings.snapshot()).toEqual({ total: 200 });
  });

  it("reports zero hops that were never used", () => {
    const clock = makeClock(0);
    const timings = startTimings(clock.now);
    expect(timings.snapshot()).toEqual({ total: 0 });
  });

  it("adds a call's duration to its hop and returns the result", async () => {
    const clock = makeClock(0);
    const timings = startTimings(clock.now);

    const result = await timings.time("kv", async () => {
      clock.advance(7);
      return 42;
    });

    expect(result).toBe(42);
    expect(timings.snapshot()).toEqual({ total: 7, kv: 7 });
  });

  it("tracks each hop separately", async () => {
    const clock = makeClock(0);
    const timings = startTimings(clock.now);
    const gate = deferred();

    // All four calls are pending while the clock moves; each starts at a
    // different reading, so each hop must record its own duration.
    const kv = timings.time("kv", () => gate.promise);
    clock.advance(1);
    const crm = timings.time("crm", () => gate.promise);
    clock.advance(1);
    const actor = timings.time("actor", () => gate.promise);
    clock.advance(1);
    const http = timings.time("http", () => gate.promise);
    clock.advance(1);

    gate.resolve();
    await Promise.all([kv, crm, actor, http]);

    const snapshot = timings.snapshot();
    expect(snapshot.kv).toBe(4);
    expect(snapshot.crm).toBe(3);
    expect(snapshot.actor).toBe(2);
    expect(snapshot.http).toBe(1);
    expect(snapshot.total).toBe(4);
  });

  it("adds up parallel calls on the same hop", async () => {
    const clock = makeClock(0);
    const timings = startTimings(clock.now);
    const gate = deferred();

    // Both calls are pending while the clock moves 30 ms, so the hop records
    // 60 ms of overlapping work while the wall time only moves 30 ms.
    const running = Promise.all([
      timings.time("kv", () => gate.promise),
      timings.time("kv", () => gate.promise),
    ]);
    clock.advance(30);
    gate.resolve();
    await running;

    const snapshot = timings.snapshot();
    expect(snapshot.kv).toBe(60);
    expect(snapshot.total).toBe(30);
  });

  it("accumulates sequential calls on the same hop", async () => {
    const clock = makeClock(0);
    const timings = startTimings(clock.now);

    await timings.time("actor", async () => clock.advance(4));
    await timings.time("actor", async () => clock.advance(6));

    expect(timings.snapshot().actor).toBe(10);
    expect(timings.snapshot().total).toBe(10);
  });

  it("reports durations as whole milliseconds", async () => {
    const clock = makeClock(0);
    const timings = startTimings(clock.now);

    // A sub-millisecond call rounds to 0 whole ms.
    await timings.time("kv", async () => clock.advance(0.4));
    expect(timings.snapshot().kv).toBe(0);

    // A multi-millisecond call stays whole.
    await timings.time("crm", async () => clock.advance(5));
    expect(timings.snapshot().crm).toBe(5);
  });

  it("counts time spent while an awaited call is pending toward its hop and the total", async () => {
    const clock = makeClock(0);
    const timings = startTimings(clock.now);
    const gate = deferred<string>();

    const pending = timings.time("http", () => gate.promise);
    clock.advance(25);
    gate.resolve("done");
    await expect(pending).resolves.toBe("done");

    const snapshot = timings.snapshot();
    expect(snapshot.http).toBe(25);
    expect(snapshot.total).toBe(25);
  });

  it("records the duration even when the wrapped call fails", async () => {
    const clock = makeClock(0);
    const timings = startTimings(clock.now);
    const gate = deferred();

    const pending = timings.time("crm", () => gate.promise);
    clock.advance(9);
    gate.reject(new Error("boom"));
    await expect(pending).rejects.toThrow("boom");

    expect(timings.snapshot().crm).toBe(9);
    expect(timings.snapshot().total).toBe(9);
  });
});

// Type guard so the compiler checks that every hop in the union is representable.
const hops: Hop[] = ["kv", "actor", "crm", "http"];
void hops;