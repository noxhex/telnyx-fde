/**
 * The area status read model for the MCP tools (ADR-005), the same shape
 * voice-context reads at call setup: `area/<postcode>/status` from KV,
 * behind the per-container memory cache with the production lifetime from
 * config (ADR-019). Only answers are cached — the published document, or
 * null for a missing key, which means the area is `ok`. A timeout, an error
 * or an unparseable document is a failed read and is never cached, so the
 * next tool call tries again.
 */

import { z } from "zod";

import type { Timings } from "@duinvezel/shared";
import { kvKeys } from "@duinvezel/shared";

import { TIMED_OUT, TIMEOUTS } from "./config.js";
import type { VoiceToolsDeps } from "./deps.js";

/** The read model published by the AreaIncident actor (ADR-005). */
export interface AreaStatusDoc {
  state: "ok" | "outage";
  incidentId: string | null;
  eta: string | null;
  version: number;
  updatedAt: number;
}

const areaStatusSchema = z.object({
  state: z.enum(["ok", "outage"]),
  incidentId: z.string().nullable(),
  eta: z.string().nullable(),
  version: z.number(),
  updatedAt: z.number(),
});

/** Parses a value read back from `area/<postcode>/status`; unknown shapes mean a failed read, not a quiet area. */
export function parseAreaStatus(raw: unknown): AreaStatusDoc | null {
  const parsed = areaStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type AreaStatusRead =
  | { outcome: "ok"; status: AreaStatusDoc | null }
  | { outcome: "failed"; reason: "timeout" | "error" | "invalid" };

type Deps = Pick<VoiceToolsDeps, "kv" | "caches" | "timeout">;

/**
 * One postcode's status: memory first, then one KV read inside the 1,500 ms
 * timeout (a KV read takes about 0.8 s — DEBUGLOG issue 11). `postcode` must
 * already be a known area; callers check `areaNameForPostcode` first, so
 * this never touches KV for postcodes outside the five.
 */
export async function readAreaStatus(
  deps: Deps,
  timings: Timings,
  postcode: string,
): Promise<AreaStatusRead> {
  const cached = deps.caches.areas.get(postcode);
  if (cached !== undefined) {
    return { outcome: "ok", status: cached };
  }
  const kv = deps.kv;
  if (kv === undefined) {
    // `telnyx-edge dev` has no KV binding (DEBUGLOG issue 9); fail closed.
    return { outcome: "failed", reason: "error" };
  }
  try {
    const raw = await timings.time("kv", () =>
      deps.timeout(
        () => kv.get(kvKeys.areaStatus(postcode), { type: "json" }),
        TIMEOUTS.areaStatusMs,
      ),
    );
    if (raw === TIMED_OUT) {
      return { outcome: "failed", reason: "timeout" };
    }
    if (raw === null) {
      // A missing key is an answer, and it means ok.
      deps.caches.areas.set(postcode, null);
      return { outcome: "ok", status: null };
    }
    const status = parseAreaStatus(raw);
    if (status === null) {
      return { outcome: "failed", reason: "invalid" };
    }
    deps.caches.areas.set(postcode, status);
    return { outcome: "ok", status };
  } catch {
    return { outcome: "failed", reason: "error" };
  }
}
