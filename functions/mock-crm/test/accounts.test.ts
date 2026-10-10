import { describe, expect, it } from "vitest";

import { makeHarness } from "./helpers.js";

describe("GET /accounts/<accountNumber>", () => {
  it("returns the full account for a known number", async () => {
    const h = makeHarness();
    const res = await h.call("/accounts/DV-100005");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accountNumber: "DV-100005",
      firstName: "Wout",
      lastName: "Vandenberghe",
      postcode: "8660",
      areaName: "De Panne",
      lineId: "LN-000005",
      plan: "Basic",
      lineProfile: "degraded",
    });
  });

  it("returns the demo account by number without needing the secret", async () => {
    const h = makeHarness({ demoCallerPhone: null });
    const res = await h.call("/accounts/DV-100001");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accountNumber: "DV-100001",
      firstName: "Thiago",
      postcode: "8630",
      lineProfile: "down",
    });
  });

  it("answers 404 for an unknown account number in the right format", async () => {
    const h = makeHarness();
    const res = await h.call("/accounts/DV-100099");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("answers 404 for a malformed account number", async () => {
    const h = makeHarness();

    expect((await h.call("/accounts/DV-1")).status).toBe(404);
    expect((await h.call("/accounts/dv-100002")).status).toBe(404);
    expect((await h.call("/accounts/DV-200002")).status).toBe(404);
    expect((await h.call("/accounts/")).status).toBe(404);
  });

  it("answers 404 for a POST", async () => {
    const h = makeHarness();
    const res = await h.call("/accounts/DV-100002", { method: "POST" });

    expect(res.status).toBe(404);
  });

  it("logs the matched account masked", async () => {
    const h = makeHarness();
    await h.call("/accounts/DV-100005");

    const log = h.lastLog();
    expect(log).toMatchObject({
      event: "crm_request",
      route: "accounts",
      status: 200,
      account: "DV-…005",
    });
    expect(log).not.toHaveProperty("caller");
    expect(JSON.stringify(log)).not.toContain("DV-100005");
  });
});
