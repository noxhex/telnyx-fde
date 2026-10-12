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
 * The flags come from the per-container refreshing value (card T20,
 * `createRefreshingValue` in shared): one container keeps the last good
 * parse and refreshes it in the background once its lifetime has passed, so
 * a request that answers from memory waits for nothing. `index.ts` builds
 * that value from `readFlagsDocument`; a missing key is an answer (the
 * defaults the parser gives, kept like any other answer), and only a KV
 * error is a failed read, which changes nothing.
 */

import { z } from "zod";

import type { KvNamespace } from "@telnyx/edge-runtime";

import { kvKeys, TIMED_OUT } from "@duinvezel/shared";
import type { RefreshTimeoutRunner } from "@duinvezel/shared";

export { TIMED_OUT };

/** The timeout runner this function uses; its sentinel is shared's, so it plugs straight into `createRefreshingValue`. */
export type TimeoutRunner = RefreshTimeoutRunner;

export interface CrmFlags {
  /** Extra delay added to every route except `/healthz`. */
  delayMs: number;
  /** When true, every route except `/healthz` answers 503. */
  fail: boolean;
}

export const DEFAULT_FLAGS: CrmFlags = Object.freeze({ delayMs: 0, fail: false });

/** The refreshing flags value's lifetime: how long a last good parse serves before a background refresh (ADR-019). */
export const FLAGS_CACHE_TTL_MS = 10_000;

/**
 * How long a request waits for the flags when no read has ever succeeded:
 * the old read bound, kept (T20). In a keyed request the wait is further cut
 * to what remains of that request's 1,000 ms read window (index.ts).
 */
export const FLAGS_TIMEOUT_MS = 1_000;

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

/**
 * One `flags/global` read for the refreshing flags value: resolves with the
 * parsed flags — a missing key parses to the defaults and counts as an
 * answer like any other — and rejects only when the KV read itself fails.
 */
export async function readFlagsDocument(kv: KvNamespace): Promise<CrmFlags> {
  return parseFlags(await kv.get(kvKeys.flags(), { type: "json" }));
}
