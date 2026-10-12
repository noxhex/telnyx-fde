/**
 * Fault-injection flags, read from `flags/global` in KV. The mock-crm only
 * cares about two of them (`crm_delay_ms`, `crm_fail`); the rest of the flag
 * document belongs to other functions and is ignored.
 *
 * `flags/global` is shared mutable state, so everything read back from KV is
 * validated with zod: a flag that is missing or invalid falls back to its
 * default, independently of the other flag, and a whole document that is not
 * an object — or unreadable JSON — falls back to both defaults. `crm_delay_ms`
 * must be a finite, non-negative number to be honoured (AGENTS.md, time
 * inputs fail closed), which in zod 4 is what `z.number()` means; anything
 * else counts as invalid and the default stays.
 *
 * The read itself is bounded: `getFlags` races the KV call against
 * `FLAGS_TIMEOUT_MS` and treats a timeout like any other failed read — the
 * defaults apply, so a hanging KV can never stall a request into the
 * platform's 30-second limit (AGENTS.md, Timeouts). The race runs through an
 * injected `TimeoutRunner`, so tests drive the timer by hand instead of
 * waiting for wall time.
 *
 * Reads are cached in memory for ten seconds — the in-memory store lives in
 * a box the caller owns (module scope in production, per-test fresh). A
 * broken clock fails closed: with a non-finite `now` the age check is never
 * true, so every call re-reads KV instead of trusting a stale cache.
 */

import { z } from "zod";

import type { KvNamespace } from "@telnyx/edge-runtime";

import { kvKeys } from "@duinvezel/shared";

export interface CrmFlags {
  /** Extra delay added to every route except `/healthz`. */
  delayMs: number;
  /** When true, every route except `/healthz` answers 503. */
  fail: boolean;
}

export const DEFAULT_FLAGS: CrmFlags = Object.freeze({ delayMs: 0, fail: false });

export const FLAGS_CACHE_TTL_MS = 10_000;

/**
 * The KV read budget. A KV read takes about 0.8 s from inside a function
 * (DEBUGLOG issue 11), so the old 300 ms bound meant the flags never applied
 * on the deployed function (issue 14). 1,000 ms is what voice-tools and
 * voice-context give the same read (ADR-019). The ten-second cache and the
 * defaults on a timeout stay as they are.
 */
export const FLAGS_TIMEOUT_MS = 1_000;

/** What a `TimeoutRunner` resolves with when its timer wins the race. */
export const TIMED_OUT: unique symbol = Symbol("timed_out");

/**
 * Races `fn()` against `ms` milliseconds. Resolves with the fn value, or
 * with `TIMED_OUT` once the timer wins; rejections propagate. The production
 * runner uses real timers; tests inject a manual one so nothing waits.
 */
export type TimeoutRunner = <T>(
  fn: () => Promise<T>,
  ms: number,
) => Promise<T | typeof TIMED_OUT>;

export const realTimeoutRunner: TimeoutRunner = <T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> =>
  new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, ms);
    // Promise.resolve().then turns a synchronous throw into a rejection.
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });

const rawFlagsSchema = z
  .object({
    crm_delay_ms: z.number().min(0).catch(0),
    crm_fail: z.boolean().catch(false),
  })
  .catch({ crm_delay_ms: 0, crm_fail: false });

/** Validates a value read back from KV; invalid input degrades to defaults. */
export function parseFlags(raw: unknown): CrmFlags {
  const parsed = rawFlagsSchema.parse(raw);
  return { delayMs: parsed.crm_delay_ms, fail: parsed.crm_fail };
}

export interface FlagsCacheBox {
  current: { atMs: number; flags: CrmFlags } | null;
}

/**
 * Reads the flags, served from the box when its entry is younger than
 * `FLAGS_CACHE_TTL_MS`. A timed-out, failed or unparseable KV read degrades
 * to the defaults — the flags exist for demos, so a flags outage must never
 * take the CRM down.
 */
export async function getFlags(
  kv: KvNamespace,
  now: () => number,
  box: FlagsCacheBox,
  timeout: TimeoutRunner,
): Promise<CrmFlags> {
  const cached = box.current;
  if (cached !== null && now() - cached.atMs < FLAGS_CACHE_TTL_MS) {
    return cached.flags;
  }
  let flags: CrmFlags = DEFAULT_FLAGS;
  try {
    const raw = await timeout(() => kv.get(kvKeys.flags(), { type: "json" }), FLAGS_TIMEOUT_MS);
    if (raw !== TIMED_OUT) {
      flags = parseFlags(raw);
    }
  } catch {
    flags = DEFAULT_FLAGS;
  }
  box.current = { atMs: now(), flags };
  return flags;
}
