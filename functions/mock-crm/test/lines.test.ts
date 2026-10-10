import { describe, expect, it } from "vitest";

import { makeHarness } from "./helpers.js";

describe("POST /lines/<lineId>/test", () => {
  it("tests an ok line after a simulated 800..1500 ms delay", async () => {
    const h = makeHarness({ randoms: [0.5, 0, 0] });
    const res = await h.call("/lines/LN-000002/test", { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lineState: "ok",
      signalDbm: -18,
      lastSeenMinutes: 0,
      suggestion: expect.stringContaining("restart the fiber box"),
      nearbyOutageSuspected: false,
    });
    // randoms[0] = 0.5 -> 800 + floor(0.5 * 701) = 1150 ms simulated delay.
    expect(h.delays).toEqual([1150]);
  });

  it("tests a degraded line", async () => {
    const h = makeHarness({ randoms: [0, 0, 0] });
    const res = await h.call("/lines/LN-000005/test", { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      lineState: "degraded",
      signalDbm: -26,
      nearbyOutageSuspected: false,
    });
    expect(res.body.suggestion).toContain("repair visit");
  });

  it("tests a down line and suspects a nearby outage", async () => {
    const h = makeHarness({ randoms: [0, 0, 0] });
    const res = await h.call("/lines/LN-000001/test", { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      lineState: "down",
      signalDbm: null,
      nearbyOutageSuspected: true,
    });
    expect(res.body.suggestion).toContain("outage");
  });

  it("keeps the simulated delay inside 800..1500 ms at the random edges", async () => {
    const low = makeHarness({ randoms: [0, 0, 0] });
    await low.call("/lines/LN-000002/test", { method: "POST" });
    const high = makeHarness({ randoms: [0.9999, 0, 0] });
    await high.call("/lines/LN-000002/test", { method: "POST" });

    expect(low.delays[0]).toBe(800);
    expect(high.delays[0]).toBe(1500);
  });

  it("keeps the simulated delay inside 800..1500 ms for a broken random", async () => {
    const nan = makeHarness({ randoms: [Number.NaN, 0, 0] });
    const nanRes = await nan.call("/lines/LN-000002/test", { method: "POST" });
    expect(nanRes.status).toBe(200);
    expect(nan.delays[0]).toBe(800);

    const above = makeHarness({ randoms: [2, 0, 0] });
    await above.call("/lines/LN-000002/test", { method: "POST" });
    expect(above.delays[0]).toBe(1500);
  });

  it("answers 404 for an unknown line without waiting", async () => {
    const h = makeHarness();
    const res = await h.call("/lines/LN-000099/test", { method: "POST" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(h.delays).toHaveLength(0);
  });

  it("answers 404 for a malformed line id and for a GET", async () => {
    const h = makeHarness();

    expect((await h.call("/lines/ln-000002/test", { method: "POST" })).status).toBe(404);
    expect((await h.call("/lines/LN-000002", { method: "POST" })).status).toBe(404);
    expect((await h.call("/lines/LN-000002/test")).status).toBe(404);
  });

  it("logs the owning account masked", async () => {
    const h = makeHarness();
    await h.call("/lines/LN-000004/test", { method: "POST" });

    const log = h.lastLog();
    expect(log).toMatchObject({
      event: "crm_request",
      route: "line_test",
      status: 200,
      account: "DV-…004",
    });
  });
});
