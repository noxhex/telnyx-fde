/**
 * The feature flags voice-tools reads from `flags/global` in KV (T19): the
 * incident decision inputs for `report_outage`. The document is shared with
 * voice-context and mock-crm, which read their own flags from it and ignore
 * the rest; this module does the same in the other direction.
 *
 * Everything read back from KV is validated with zod: a flag that is
 * missing or invalid falls back to its default independently of the others,
 * and a whole document that is not an object falls back to all three.
 *
 * The flags come from the per-container refreshing value (card T20,
 * `createRefreshingValue` in shared): one container keeps the last good
 * parse for the production 10 seconds and refreshes it in the background
 * once that lifetime has passed, so a tool call that answers from memory
 * waits for nothing. A read that resolves is a successful read — a missing
 * key parses to the defaults and counts as an answer like any other — and
 * only a KV error is a failed read, which keeps nothing.
 */

import { z } from "zod";

import type { KvNamespace } from "@telnyx/edge-runtime";

import type { Timings } from "@duinvezel/shared";
import { createRefreshingValue, kvKeys, TIMED_OUT as REFRESH_TIMED_OUT } from "@duinvezel/shared";
import type {
  RefreshingValue,
  RefreshSettledListener,
  RefreshTimeoutRunner,
} from "@duinvezel/shared";

import { FLAG_CACHE_TTL_MS, TIMED_OUT, TIMEOUTS } from "./config.js";
import type { TimeoutRunner } from "./config.js";
import type { VoiceToolsDeps } from "./deps.js";

export interface ToolsFlags {
  /** Distinct reporters inside the window that declare an incident (ADR-004). */
  incidentThreshold: number;
  /** The report window, in seconds. */
  reportWindowSecs: number;
  /** The ETA given out when an incident is declared, in minutes. */
  incidentEtaMinutes: number;
}

export const DEFAULT_TOOLS_FLAGS: ToolsFlags = Object.freeze({
  incidentThreshold: 3,
  reportWindowSecs: 1_800,
  incidentEtaMinutes: 240,
});

const rawFlagsSchema = z
  .object({
    incident_threshold: z.number().int().min(1).catch(DEFAULT_TOOLS_FLAGS.incidentThreshold),
    report_window_secs: z.number().int().min(1).catch(DEFAULT_TOOLS_FLAGS.reportWindowSecs),
    incident_eta_minutes: z.number().int().min(1).catch(DEFAULT_TOOLS_FLAGS.incidentEtaMinutes),
  })
  .catch({
    incident_threshold: DEFAULT_TOOLS_FLAGS.incidentThreshold,
    report_window_secs: DEFAULT_TOOLS_FLAGS.reportWindowSecs,
    incident_eta_minutes: DEFAULT_TOOLS_FLAGS.incidentEtaMinutes,
  });

/** Validates a value read back from `flags/global`; invalid input degrades flag by flag. */
export function parseFlags(raw: unknown): ToolsFlags {
  const parsed = rawFlagsSchema.parse(raw);
  return {
    incidentThreshold: parsed.incident_threshold,
    reportWindowSecs: parsed.report_window_secs,
    incidentEtaMinutes: parsed.incident_eta_minutes,
  };
}

/**
 * Builds the container's refreshing flags value (T20): one at module scope
 * in index.ts for the real container, a fresh one per test. `kv` is an
 * accessor because the module-scope value is made before any `env` exists;
 * the read only ever runs while a request with an env is on the go. The
 * local timeout runner is adapted to shared's runner here — both race a
 * task against a timer, they just resolve with different sentinels.
 */
export function createFlagsValue(options: {
  kv: () => KvNamespace | undefined;
  now: () => number;
  timeout: TimeoutRunner;
  onSettled?: RefreshSettledListener;
}): RefreshingValue<ToolsFlags> {
  const timeout: RefreshTimeoutRunner = async <T>(
    fn: () => Promise<T>,
    ms: number,
  ): Promise<T | typeof REFRESH_TIMED_OUT> => {
    const raced = await options.timeout(fn, ms);
    return raced === TIMED_OUT ? REFRESH_TIMED_OUT : raced;
  };
  return createRefreshingValue<ToolsFlags>({
    read: async (): Promise<ToolsFlags> => {
      const kv = options.kv();
      if (kv === undefined) {
        throw new Error("voice-tools: no KV binding");
      }
      return parseFlags(await kv.get(kvKeys.flags(), { type: "json" }));
    },
    lifetimeMs: FLAG_CACHE_TTL_MS,
    fallback: DEFAULT_TOOLS_FLAGS,
    now: options.now,
    timeout,
    onSettled: options.onSettled,
  });
}

type Deps = Pick<VoiceToolsDeps, "flagsValue">;

/**
 * The current flags from the container's refreshing value: a last good
 * parse answers at once and the tool call waits for nothing; while no read
 * has ever succeeded, the call waits for the read in flight, bounded at the
 * card's 1,000 ms. Never fails — the flags exist to be changed mid-demo, so
 * a KV wobble must never take the tools down. The `kv` hop times only what
 * the call itself waited.
 */
export async function readFlags(deps: Deps, timings: Timings): Promise<ToolsFlags> {
  const value = deps.flagsValue;
  if (value === undefined) {
    // `telnyx-edge dev` has no KV binding (DEBUGLOG issue 9); defaults.
    return DEFAULT_TOOLS_FLAGS;
  }
  return timings.time("kv", () => value.get(TIMEOUTS.flagsMs));
}
