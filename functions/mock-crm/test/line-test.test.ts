import { describe, expect, it } from "vitest";

import { lineTestDelayMs, runLineTest } from "../src/domain/line-test.js";

describe("runLineTest", () => {
  it("ok profile: signal between -18 and -22 at both random edges", () => {
    const low = runLineTest("ok", () => 0);
    expect(low.lineState).toBe("ok");
    expect(low.signalDbm).toBe(-18);
    expect(low.lastSeenMinutes).toBe(0);
    expect(low.nearbyOutageSuspected).toBe(false);
    expect(low.suggestion).toContain("restart the fiber box");

    const high = runLineTest("ok", () => 0.9999);
    expect(high.signalDbm).toBe(-22);
    expect(high.lastSeenMinutes).toBe(9);
  });

  it("degraded profile: signal between -26 and -28", () => {
    const low = runLineTest("degraded", () => 0);
    expect(low.lineState).toBe("degraded");
    expect(low.signalDbm).toBe(-26);
    expect(low.nearbyOutageSuspected).toBe(false);
    expect(low.suggestion).toContain("repair visit");

    expect(runLineTest("degraded", () => 0.9999).signalDbm).toBe(-28);
  });

  it("down profile: no signal, outage suspected, seen 30..119 minutes ago", () => {
    const low = runLineTest("down", () => 0);
    expect(low.lineState).toBe("down");
    expect(low.signalDbm).toBeNull();
    expect(low.lastSeenMinutes).toBe(30);
    expect(low.nearbyOutageSuspected).toBe(true);
    expect(low.suggestion).toContain("outage");

    expect(runLineTest("down", () => 0.9999).lastSeenMinutes).toBe(119);
  });

  it("clamps an out-of-range or broken random into a legal result", () => {
    for (const bad of [-0.5, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = runLineTest("ok", () => bad);
      expect(result.signalDbm).toBeGreaterThanOrEqual(-22);
      expect(result.signalDbm).toBeLessThanOrEqual(-18);
    }
  });
});

describe("lineTestDelayMs", () => {
  it("gives 800 ms at random 0 and 1500 ms at the top of the range", () => {
    expect(lineTestDelayMs(() => 0)).toBe(800);
    expect(lineTestDelayMs(() => 0.9999)).toBe(1500);
  });

  it("clamps a broken random into the 800..1500 ms range", () => {
    expect(lineTestDelayMs(() => Number.NaN)).toBe(800);
    expect(lineTestDelayMs(() => Number.POSITIVE_INFINITY)).toBe(800);
    expect(lineTestDelayMs(() => -1)).toBe(800);
    expect(lineTestDelayMs(() => 2)).toBe(1500);
  });
});
