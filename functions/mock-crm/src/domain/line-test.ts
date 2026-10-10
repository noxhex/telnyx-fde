/**
 * The line test: what `POST /lines/<lineId>/test` returns once its simulated
 * delay has passed. Pure — all rules live here (AGENTS.md, domain logic is
 * pure), the route only finds the line's profile and waits. The result
 * depends on the fixture's line profile and an injected `random`, so tests
 * are deterministic.
 *
 * Signal strengths follow the card:
 * - `ok`       — signal between -18 and -22 dBm; caller is told to restart
 *   the fiber box if problems persist.
 * - `degraded` — signal between -26 and -28 dBm; caller is told to book a
 *   repair visit.
 * - `down`     — no signal at all, `nearbyOutageSuspected` is true and the
 *   suggestion is to report an outage.
 *
 * `random` is expected to return `[0, 1)`; out-of-range and non-finite
 * values are clamped into that range so a broken source can never push a
 * signal outside its band.
 */

import type { LineProfile } from "./fixtures.js";

export interface LineTestResult {
  lineState: LineProfile;
  /** `null` when the line is down: there is no signal to measure. */
  signalDbm: number | null;
  lastSeenMinutes: number;
  suggestion: string;
  nearbyOutageSuspected: boolean;
}

function unit(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(0.999_999, Math.max(0, value));
}

/** A real line test takes a moment; the fake takes 800 .. 1500 ms of it. */
export const LINE_TEST_DELAY_MIN_MS = 800;
export const LINE_TEST_DELAY_SPAN_MS = 701;

/**
 * The simulated wait before a line test answers, always between 800 and
 * 1500 ms — the `unit` clamp keeps a broken random inside that range.
 */
export function lineTestDelayMs(random: () => number): number {
  return LINE_TEST_DELAY_MIN_MS + Math.floor(unit(random) * LINE_TEST_DELAY_SPAN_MS);
}

export function runLineTest(
  profile: LineProfile,
  random: () => number,
): LineTestResult {
  switch (profile) {
    case "ok":
      // -18 .. -22 dBm, seen within the last ten minutes.
      return {
        lineState: "ok",
        signalDbm: -18 - Math.floor(unit(random) * 5),
        lastSeenMinutes: Math.floor(unit(random) * 10),
        suggestion:
          "The line looks fine from here. If you still have problems, restart the fiber box and give it five minutes.",
        nearbyOutageSuspected: false,
      };
    case "degraded":
      // -26 .. -28 dBm, still answering, but borderline.
      return {
        lineState: "degraded",
        signalDbm: -26 - Math.floor(unit(random) * 3),
        lastSeenMinutes: Math.floor(unit(random) * 10),
        suggestion:
          "The line is degraded. Book a repair visit so a technician can fix it.",
        nearbyOutageSuspected: false,
      };
    case "down":
      // No signal, last seen 30 .. 119 minutes ago: probably not just us.
      return {
        lineState: "down",
        signalDbm: null,
        lastSeenMinutes: 30 + Math.floor(unit(random) * 90),
        suggestion:
          "The line is down. Report an outage so we can start repairs.",
        nearbyOutageSuspected: true,
      };
  }
}
