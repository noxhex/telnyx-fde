/**
 * A controllable clock for tests. `now()` returns the current value in
 * milliseconds; `advance(ms)` moves it forward. Pass `clock.now` wherever
 * production code takes an injected clock (`createLogger`, `startTimings`,
 * `createKvFake`, domain functions taking `nowMs`).
 */

export interface ClockFake {
  now(): number;
  advance(ms: number): void;
}

export function createClockFake(startMs = 0): ClockFake {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}
