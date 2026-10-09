/**
 * Per-request latency accounting. Wraps every KV, actor, CRM and other HTTP
 * call so the request log line can report `latency_ms` split per hop
 * (docs/ARCHITECTURE.md, Observability). Durations on one hop add up, so two
 * overlapping KV reads count their combined cost, not the wall time once.
 *
 * One clock only: the injected one (`Date.now` by default, a fake in tests —
 * AGENTS.md, "Inject time"). `time()` reads it when the call starts and again
 * when the promise settles, success or failure, and adds the rounded
 * difference to the hop; `total` is the clock's reading now minus its reading
 * at `startTimings`. All reported values are whole milliseconds.
 */

export type Hop = "kv" | "actor" | "crm" | "http";

export interface Timings {
  time<T>(hop: Hop, fn: () => Promise<T>): Promise<T>;
  snapshot(): { total: number } & Partial<Record<Hop, number>>;
}

export function startTimings(now: () => number = () => Date.now()): Timings {
  const startedAt = now();
  const sums: Partial<Record<Hop, number>> = {};

  return {
    async time<T>(hop: Hop, fn: () => Promise<T>): Promise<T> {
      const callStartedAt = now();
      try {
        return await fn();
      } finally {
        sums[hop] = (sums[hop] ?? 0) + Math.round(now() - callStartedAt);
      }
    },
    snapshot() {
      return { total: Math.round(now() - startedAt), ...sums };
    },
  };
}
