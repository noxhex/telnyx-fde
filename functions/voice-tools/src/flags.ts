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
 * The read goes through the per-container memory cache with the production
 * lifetime from config (ADR-019), like `area-status.ts`. Only answers are
 * cached — a document that was there and parsed. A timeout, an error or a
 * missing key falls back to the defaults and is never cached, so the next
 * tool call tries again.
 */

import { z } from "zod";

import type { Timings } from "@duinvezel/shared";
import { kvKeys } from "@duinvezel/shared";

import { TIMED_OUT, TIMEOUTS } from "./config.js";
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

type Deps = Pick<VoiceToolsDeps, "kv" | "caches" | "timeout">;

/**
 * The current flags: memory first, then one KV read inside the 1,000 ms
 * timeout. A timeout, a KV error or a missing key resolves to the defaults
 * and is never cached; a parsed document is cached for the production 10
 * seconds. Never fails — the flags exist to be changed mid-demo, so a KV
 * wobble must never take the tools down.
 */
export async function readFlags(deps: Deps, timings: Timings): Promise<ToolsFlags> {
  const cached = deps.caches.flags.get("global");
  if (cached !== undefined) {
    return cached;
  }
  const kv = deps.kv;
  if (kv === undefined) {
    // `telnyx-edge dev` has no KV binding (DEBUGLOG issue 9); defaults.
    return DEFAULT_TOOLS_FLAGS;
  }
  try {
    const raw = await timings.time("kv", () =>
      deps.timeout(() => kv.get(kvKeys.flags(), { type: "json" }), TIMEOUTS.flagsMs),
    );
    if (raw === TIMED_OUT || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      // A timeout, a missing key or a stored non-document (a scalar or an
      // array) is no answer: the defaults apply and nothing is cached.
      return DEFAULT_TOOLS_FLAGS;
    }
    const flags = parseFlags(raw);
    deps.caches.flags.set("global", flags);
    return flags;
  } catch {
    return DEFAULT_TOOLS_FLAGS;
  }
}
