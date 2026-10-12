import { describe, expect, it } from "vitest";

import { createRefreshingValue, TIMED_OUT } from "../src/refreshing-value.js";
import type {
  RefreshOutcome,
  RefreshingValueOptions,
  TimeoutRunner,
} from "../src/refreshing-value.js";

import { createClockFake } from "./fakes/clock.js";
import type { ClockFake } from "./fakes/clock.js";

// ---------- held promises and a manual timeout runner ----------

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

/** Flushes the microtask queue so a value awaiting held promises advances. */
async function tick(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

interface ManualTimer {
  ms: number;
  fired: boolean;
  fire(): void;
}

/** Timers fire only when the test says so; the task starts immediately and wins when it settles first. */
function manualTimeout(): { runner: TimeoutRunner; timers: ManualTimer[] } {
  const timers: ManualTimer[] = [];
  const runner: TimeoutRunner = <T>(fn: () => Promise<T>, ms: number) =>
    new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
      let done = false;
      const timer: ManualTimer = {
        ms,
        fired: false,
        fire() {
          if (!done) {
            done = true;
            this.fired = true;
            resolve(TIMED_OUT);
          }
        },
      };
      timers.push(timer);
      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            if (!done) {
              done = true;
              resolve(value);
            }
          },
          (error: unknown) => {
            if (!done) {
              done = true;
              reject(error);
            }
          },
        );
    });
  return { runner, timers };
}

const LIFETIME_MS = 10_000;
const FALLBACK = { flag: "fallback" };

interface Flags {
  flag: string;
}

interface Harness {
  clock: ClockFake;
  timers: ManualTimer[];
  /** The held reads that actually started, in order. */
  reads: HeldPromise<Flags>[];
  settledLog: { outcome: RefreshOutcome; durationMs: number }[];
  /** Queues a held promise the next read to start will await. */
  holdNextRead(): HeldPromise<Flags>;
  /** Queues a value the next read to start resolves with at once. */
  resolveNextRead(value: Flags): void;
  /** Swaps the injected clock (a broken clock for the fail-closed paths). */
  setNow(now: () => number): void;
  get(waitMs: number): Promise<Flags>;
  start(): void;
  create(options?: Partial<RefreshingValueOptions<Flags>>): void;
}

function makeHarness(startMs = 1_000): Harness {
  const clock = createClockFake(startMs);
  const manual = manualTimeout();
  const reads: HeldPromise<Flags>[] = [];
  const queued: ({ kind: "held"; held: HeldPromise<Flags> } | { kind: "value"; value: Flags })[] = [];
  const settledLog: { outcome: RefreshOutcome; durationMs: number }[] = [];
  let now: () => number = clock.now;
  let value: ReturnType<typeof createRefreshingValue<Flags>>;

  const h: Harness = {
    clock,
    timers: manual.timers,
    reads,
    settledLog,
    holdNextRead() {
      const held = hold<Flags>();
      queued.push({ kind: "held", held });
      return held;
    },
    resolveNextRead(v: Flags) {
      queued.push({ kind: "value", value: v });
    },
    setNow(next: () => number) {
      now = next;
    },
    get(waitMs: number) {
      return value.get(waitMs);
    },
    start() {
      value.start();
    },
    create(options = {}) {
      value = createRefreshingValue<Flags>({
        read: () => {
          const next = queued.shift();
          if (next === undefined) {
            const held = hold<Flags>();
            reads.push(held);
            return held.promise;
          }
          if (next.kind === "held") {
            reads.push(next.held);
            return next.held.promise;
          }
          return Promise.resolve(next.value);
        },
        lifetimeMs: LIFETIME_MS,
        fallback: FALLBACK,
        now: () => now(),
        timeout: manual.runner,
        onSettled: (outcome, durationMs) => {
          settledLog.push({ outcome, durationMs });
        },
        ...options,
      });
    },
  };
  h.create();
  return h;
}

// ---------- construction ----------

describe("createRefreshingValue construction", () => {
  it("rejects a non-finite or non-positive lifetime", () => {
    const clock = createClockFake(0);
    const manual = manualTimeout();
    const base: RefreshingValueOptions<Flags> = {
      read: () => Promise.resolve({ flag: "x" }),
      lifetimeMs: 1_000,
      fallback: FALLBACK,
      now: clock.now,
      timeout: manual.runner,
    };
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createRefreshingValue({ ...base, lifetimeMs: bad })).toThrow(RangeError);
    }
    expect(() =>
      createRefreshingValue({ ...base, read: 42 as unknown as () => Promise<Flags> }),
    ).toThrow(TypeError);
    expect(() =>
      createRefreshingValue({ ...base, now: 42 as unknown as () => number }),
    ).toThrow(TypeError);
    expect(() =>
      createRefreshingValue({ ...base, timeout: 42 as unknown as TimeoutRunner }),
    ).toThrow(TypeError);
  });
});

// ---------- the first value ----------

describe("the first read", () => {
  it("a first get the read answers in time returns its value, and the wait is exactly waitMs", async () => {
    const h = makeHarness();
    h.resolveNextRead({ flag: "a" });

    await expect(h.get(750)).resolves.toEqual({ flag: "a" });
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(750);
    expect(h.settledLog).toEqual([{ outcome: "ok", durationMs: 0 }]);
  });

  it("a first get still pending at waitMs returns the fallback, and the late success serves the next get without a new read", async () => {
    const h = makeHarness();
    const held = h.holdNextRead();

    const pending = h.get(1_000);
    await tick();
    expect(h.timers).toHaveLength(1);
    h.timers[0]?.fire();
    await expect(pending).resolves.toBe(FALLBACK);

    // The read lands after its waiter gave up: it still becomes the last
    // good value, so the next get answers at once and starts nothing.
    h.clock.advance(300);
    held.resolve({ flag: "late" });
    await tick();
    await expect(h.get(1_000)).resolves.toEqual({ flag: "late" });
    expect(h.reads).toHaveLength(1);
    expect(h.timers).toHaveLength(1);
    expect(h.settledLog).toEqual([{ outcome: "ok", durationMs: 300 }]);
  });

  it("a get whose shared read rejects while it waits answers the fallback", async () => {
    const h = makeHarness();
    const held = h.holdNextRead();
    const pending = h.get(1_000);
    await tick();
    held.reject(new Error("kv down"));
    await expect(pending).resolves.toBe(FALLBACK);
    expect(h.settledLog).toEqual([{ outcome: "error", durationMs: 0 }]);
  });

  it("after a first read that timed out and then rejected, the next get starts a new read", async () => {
    const h = makeHarness();
    const held = h.holdNextRead();
    const first = h.get(1_000);
    await tick();
    h.timers[0]?.fire();
    await expect(first).resolves.toBe(FALLBACK);
    held.reject(new Error("kv down"));
    await tick();

    // The failure kept nothing: the next get reads again.
    const secondRead = h.holdNextRead();
    const second = h.get(1_000);
    await tick();
    expect(h.reads).toHaveLength(2);
    secondRead.resolve({ flag: "b" });
    await expect(second).resolves.toEqual({ flag: "b" });

    // The fallback is never returned once a value exists, and never stored.
    await expect(h.get(1_000)).resolves.toEqual({ flag: "b" });
    expect(h.reads).toHaveLength(2);
    expect(h.timers).toHaveLength(2);
  });

  it("two callers without a value share one read, so read is called once", async () => {
    const h = makeHarness();
    const held = h.holdNextRead();
    const one = h.get(1_000);
    await tick();
    const two = h.get(500);
    await tick();
    expect(h.reads).toHaveLength(1);
    expect(h.timers.map((t) => t.ms)).toEqual([1_000, 500]);

    held.resolve({ flag: "shared" });
    await expect(one).resolves.toEqual({ flag: "shared" });
    await expect(two).resolves.toEqual({ flag: "shared" });
  });
});

// ---------- the last good value and its background refresh ----------

describe("the last good value", () => {
  async function seedValue(h: Harness, value: Flags): Promise<void> {
    h.resolveNextRead(value);
    await h.get(1_000);
    expect(h.settledLog).toHaveLength(1);
  }

  it("serves a value for lifetimeMs minus 1 ms and starts one background read at exactly lifetimeMs", async () => {
    const h = makeHarness();
    await seedValue(h, { flag: "v1" });

    h.clock.advance(LIFETIME_MS - 1);
    await expect(h.get(1_000)).resolves.toEqual({ flag: "v1" });
    expect(h.reads).toHaveLength(0);

    h.clock.advance(1);
    await expect(h.get(1_000)).resolves.toEqual({ flag: "v1" });
    expect(h.reads).toHaveLength(1); // the background refresh started

    // A second get before the refresh settles starts none, and never waits.
    await expect(h.get(1_000)).resolves.toEqual({ flag: "v1" });
    expect(h.reads).toHaveLength(1);
    expect(h.timers).toHaveLength(1); // only the seeding get ever waited
  });

  it("never waits with a value, also while the refresh it started never settles", async () => {
    const h = makeHarness();
    await seedValue(h, { flag: "v1" });

    h.clock.advance(LIFETIME_MS);
    await h.get(1_000); // starts the refresh
    expect(h.reads).toHaveLength(1);

    // The refresh never settles; every get still answers at once, and no
    // further read starts before the refresh has been in flight for a
    // whole lifetime.
    h.clock.advance(LIFETIME_MS - 1);
    await expect(h.get(1_000)).resolves.toEqual({ flag: "v1" });
    expect(h.reads).toHaveLength(1);
    expect(h.timers).toHaveLength(1);

    // The refresh lands at last: one lifetime late, but its success counts.
    h.clock.advance(1);
    h.reads[0]?.resolve({ flag: "v2" });
    await tick();
    expect(h.settledLog.at(-1)).toEqual({ outcome: "ok", durationMs: LIFETIME_MS });
    h.clock.advance(LIFETIME_MS - 1);
    await expect(h.get(1_000)).resolves.toEqual({ flag: "v2" });
  });

  it("a read in flight for lifetimeMs minus 1 still blocks a new one; at exactly lifetimeMs it does not", async () => {
    const h = makeHarness();
    const first = h.holdNextRead();
    const waiting = h.get(1_000);
    await tick();
    h.timers[0]?.fire();
    await expect(waiting).resolves.toBe(FALLBACK);

    h.clock.advance(LIFETIME_MS - 1);
    const stillWaiting = h.get(1_000);
    await tick();
    expect(h.reads).toHaveLength(1); // the old read still counts as in flight
    h.timers[1]?.fire();
    await expect(stillWaiting).resolves.toBe(FALLBACK);

    h.clock.advance(1);
    const second = h.holdNextRead();
    const newWait = h.get(1_000);
    await tick();
    expect(h.reads).toHaveLength(2); // the abandoned read no longer blocks
    second.resolve({ flag: "fresh" });
    await expect(newWait).resolves.toEqual({ flag: "fresh" });

    // When the older read settles afterwards, the newer value stays.
    first.resolve({ flag: "stale" });
    await tick();
    await expect(h.get(1_000)).resolves.toEqual({ flag: "fresh" });
    expect(h.settledLog.map((s) => s.outcome)).toEqual(["ok", "ok"]);
  });

  it("a refresh that rejects keeps the old value, and the next get starts another read", async () => {
    const h = makeHarness();
    await seedValue(h, { flag: "v1" });

    h.clock.advance(LIFETIME_MS);
    await h.get(1_000);
    expect(h.reads).toHaveLength(1);
    h.clock.advance(2_000);
    h.reads[0]?.reject(new Error("kv down"));
    await tick();
    expect(h.settledLog.at(-1)).toEqual({ outcome: "error", durationMs: 2_000 });

    // The old value still serves, and the next get refreshes it again.
    const next = h.holdNextRead();
    const pending = h.get(1_000);
    await expect(pending).resolves.toEqual({ flag: "v1" });
    expect(h.reads).toHaveLength(2);
    next.resolve({ flag: "v2" });
    await tick();
    h.clock.advance(7_999); // 9,999 ms after v2 settled: still fresh
    await expect(h.get(1_000)).resolves.toEqual({ flag: "v2" });
    expect(h.reads).toHaveLength(2);
  });
});

// ---------- start() ----------

describe("start", () => {
  it("starts one read and returns at once; the success is stored for the next get", async () => {
    const h = makeHarness();
    const held = h.holdNextRead();
    h.start(); // returns at once: no waiting
    expect(h.reads).toHaveLength(1);

    h.start(); // a read is already in flight: nothing new
    expect(h.reads).toHaveLength(1);

    held.resolve({ flag: "warmed" });
    await tick();
    h.start(); // a value exists now: still nothing new
    expect(h.reads).toHaveLength(1);
    await expect(h.get(1_000)).resolves.toEqual({ flag: "warmed" });
  });
});

// ---------- onSettled ----------

describe("onSettled", () => {
  it("is called once per settled read, with the outcome and the duration in ms", async () => {
    const h = makeHarness();
    const first = h.holdNextRead();
    h.start();
    h.clock.advance(250);
    first.resolve({ flag: "a" });
    await tick();
    expect(h.settledLog).toEqual([{ outcome: "ok", durationMs: 250 }]);

    h.clock.advance(LIFETIME_MS);
    await h.get(1_000); // starts the refresh
    h.clock.advance(40);
    h.reads[1]?.reject(new Error("kv down"));
    await tick();
    expect(h.settledLog).toEqual([
      { outcome: "ok", durationMs: 250 },
      { outcome: "error", durationMs: 40 },
    ]);
  });

  it("a listener that throws cannot break the read or its waiters", async () => {
    const h = makeHarness();
    let calls = 0;
    h.create({
      onSettled: () => {
        calls += 1;
        throw new Error("listener bug");
      },
    });
    h.resolveNextRead({ flag: "a" });
    await expect(h.get(1_000)).resolves.toEqual({ flag: "a" });
    expect(calls).toBe(1);
    await expect(h.get(1_000)).resolves.toEqual({ flag: "a" });
  });

  it("without a listener the reads still work", async () => {
    const h = makeHarness();
    h.create({ onSettled: undefined });
    h.resolveNextRead({ flag: "a" });
    await expect(h.get(1_000)).resolves.toEqual({ flag: "a" });
  });
});

// ---------- a non-finite clock fails closed ----------

describe("a non-finite clock", () => {
  it("makes get behave as if there were no last good value, and stores nothing that settles then", async () => {
    const h = makeHarness();
    h.setNow(() => Number.NaN);

    // No value can ever be trusted: the first get starts a read and waits
    // for it. The read's own success still answers the waiter, but it is
    // not stored.
    const first = h.holdNextRead();
    const waiting = h.get(1_000);
    await tick();
    first.resolve({ flag: "live" });
    await expect(waiting).resolves.toEqual({ flag: "live" });
    expect(h.settledLog).toHaveLength(1);

    // The next get starts another read instead of serving what settled.
    const second = h.holdNextRead();
    const again = h.get(1_000);
    await tick();
    expect(h.reads).toHaveLength(2);
    h.timers[1]?.fire();
    await expect(again).resolves.toBe(FALLBACK);
    second.reject(new Error("kv down"));
    await tick();
  });

  it("an existing value is not served while the clock is broken, but is served again once it heals", async () => {
    const h = makeHarness();
    h.resolveNextRead({ flag: "v1" });
    await h.get(1_000);
    expect(h.reads).toHaveLength(0);

    // The clock breaks: get ignores the stored value, starts a read and
    // waits; the timer ending the wait gives the fallback. That read's late
    // success is not stored either.
    h.setNow(() => Number.NaN);
    const held = h.holdNextRead();
    const waiting = h.get(1_000);
    await tick();
    expect(h.reads).toHaveLength(1);
    h.timers[1]?.fire();
    await expect(waiting).resolves.toBe(FALLBACK);
    held.resolve({ flag: "dropped" });
    await tick();

    // The clock heals: the value from before the breakage serves again —
    // "dropped" never replaced it.
    h.setNow(h.clock.now);
    await expect(h.get(1_000)).resolves.toEqual({ flag: "v1" });
    expect(h.reads).toHaveLength(1);
  });
});
