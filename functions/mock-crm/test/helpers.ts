/**
 * Shared harness for the mock-crm tests: fresh KV fake, controllable clock,
 * recorded delays, scripted randoms and a captured log sink per test, then a
 * `call` helper that runs a request through `handleRequest`. Nothing here
 * touches a clock, a timer or real I/O, so every test is deterministic.
 */

import { kvKeys } from "@duinvezel/shared";
import { createLogger } from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import type { ClockFake } from "../../../packages/shared/test/fakes/clock.js";
import { createKvFake } from "../../../packages/shared/test/fakes/kv.js";
import type { KvFake } from "../../../packages/shared/test/fakes/kv.js";

import { handleRequest } from "../src/index.js";
import type { CrmDeps } from "../src/index.js";
import { TIMED_OUT } from "../src/flags.js";
import type { TimeoutRunner } from "../src/flags.js";

/** A promise the test holds and settles by hand; no real time passes. */
export interface HeldPromise<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function hold<T>(): HeldPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes the microtask queue so a handler awaiting held promises advances. */
export async function tick(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/** One manual timer: the runner's `ms`, and whether the fire or the task won. */
export interface ManualTimer {
  ms: number;
  fired: boolean;
  settled: boolean;
  fire(): void;
}

/**
 * A TimeoutRunner whose timers fire only when the test says so; tasks start
 * immediately, and a task that settles before its timer fires wins the race.
 * Late settlements are handled no-ops.
 */
export function manualTimeout(): { runner: TimeoutRunner; timers: ManualTimer[] } {
  const timers: ManualTimer[] = [];
  const runner: TimeoutRunner = <T>(fn: () => Promise<T>, ms: number) =>
    new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
      let done = false;
      const timer: ManualTimer = {
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
      timers.push(timer);
      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            if (!done) {
              done = true;
              timer.settled = true;
              resolve(value);
            }
          },
          (error: unknown) => {
            if (!done) {
              done = true;
              timer.settled = true;
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
    });
  return { runner, timers };
}

/** Stand-in secrets, generated per test run by the tester, never real. */
export const TEST_INTERNAL_KEY = "9f8c2a-test-internal-key";
export const TEST_DEMO_PHONE = "+3258009900";

/** Secret handles the function knows. */
export const INTERNAL_KEY_HANDLE = "INTERNAL_KEY";
export const DEMO_PHONE_HANDLE = "DEMO_CALLER_PHONE";

export interface HarnessOptions {
  demoCallerPhone?: string | null;
  internalKey?: string | null;
  randoms?: number[];
  clockStartMs?: number;
}

export interface Harness {
  deps: CrmDeps;
  kv: KvFake;
  clock: ClockFake;
  /** Every ms value passed to the injected delay, in order. */
  delays: number[];
  /** Consumed scripted randoms; once exhausted, `random` returns 0.5. */
  randoms: number[];
  /** Raw JSON log lines, one per request. */
  lines: string[];
  /** Every secret handle passed to the injected `readSecret`, in order. */
  secretReads: string[];
  /** Runs one request. Omit `key` for the right key, `null` for no header. */
  call(
    path: string,
    options?: { method?: string; key?: string | null },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Seeds or clears the flags document in KV. */
  setFlags(value: Record<string, unknown> | string | null): Promise<void>;
  /** The most recent log line, parsed. */
  lastLog(): Record<string, unknown>;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const clock = createClockFake(options.clockStartMs ?? 1_000);
  const kv = createKvFake(clock.now);
  const delays: number[] = [];
  const randoms = [...(options.randoms ?? [])];
  const lines: string[] = [];
  const secretReads: string[] = [];
  const log = createLogger(
    "mock-crm",
    (line) => {
      lines.push(line);
    },
    clock.now,
  );
  const internalKey =
    options.internalKey === undefined ? TEST_INTERNAL_KEY : options.internalKey;
  const demoCallerPhone =
    options.demoCallerPhone === undefined ? TEST_DEMO_PHONE : options.demoCallerPhone;

  const deps: CrmDeps = {
    kv,
    readSecret: (handle) => {
      secretReads.push(handle);
      if (handle === INTERNAL_KEY_HANDLE) {
        return Promise.resolve(internalKey);
      }
      if (handle === DEMO_PHONE_HANDLE) {
        return Promise.resolve(demoCallerPhone);
      }
      return Promise.resolve(null);
    },
    // Immediate runner: the task always wins, the timer never fires. Tests
    // that exercise a timeout replace `deps.timeout` with a manual one.
    timeout: <T>(fn: () => Promise<T>, _ms: number) => fn(),
    now: clock.now,
    random: () => (randoms.length > 0 ? (randoms.shift() as number) : 0.5),
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    log,
    flagsCache: { current: null },
    secretCache: { values: new Map<string, string>() },
  };

  return {
    deps,
    kv,
    clock,
    delays,
    randoms,
    lines,
    secretReads,
    async call(path, options = {}) {
      const key = options.key === undefined ? TEST_INTERNAL_KEY : options.key;
      const headers: Record<string, string> = {};
      if (key !== null) {
        headers["x-internal-key"] = key;
      }
      const res = await handleRequest(
        new Request(`http://mock-crm.test${path}`, {
          method: options.method ?? "GET",
          headers,
        }),
        deps,
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    async setFlags(value) {
      if (value === null) {
        await kv.delete(kvKeys.flags());
      } else if (typeof value === "string") {
        await kv.put(kvKeys.flags(), value);
      } else {
        await kv.put(kvKeys.flags(), JSON.stringify(value));
      }
      deps.flagsCache.current = null;
    },
    lastLog() {
      if (lines.length === 0) {
        throw new Error("no log lines captured");
      }
      return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    },
  };
}
