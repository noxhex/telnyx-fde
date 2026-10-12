import { describe, expect, it } from "vitest";

import { makeHarness, TEST_DEMO_PHONE } from "./helpers.js";

describe("GET /customers", () => {
  it("returns the summary for a known phone number", async () => {
    const h = makeHarness();
    const res = await h.call("/customers?phone=3258000001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accountNumber: "DV-100002",
      firstName: "Marie",
      postcode: "8630",
      areaName: "Veurne",
      lineId: "LN-000002",
    });
    // The summary never leaks account details.
    expect(res.body).not.toHaveProperty("lastName");
    expect(res.body).not.toHaveProperty("plan");
    expect(res.body).not.toHaveProperty("lineProfile");
  });

  it("answers 404 for a number that belongs to nobody", async () => {
    const h = makeHarness();
    const res = await h.call("/customers?phone=3250000000");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("finds the demo account only through the DEMO_CALLER_PHONE secret", async () => {
    const h = makeHarness();
    const res = await h.call(`/customers?phone=${TEST_DEMO_PHONE.replace("+", "")}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accountNumber: "DV-100001",
      firstName: "Thiago",
      postcode: "8630",
      areaName: "Veurne",
    });
  });

  it("answers 503 — not 404 — when the queried digits match no fixture and the secret is absent (T20)", async () => {
    const h = makeHarness({ demoCallerPhone: null });
    // These digits may be the demo number; with DEMO_CALLER_PHONE
    // unreadable mock-crm cannot say "not found" for sure.
    const res = await h.call(`/customers?phone=${TEST_DEMO_PHONE.replace("+", "")}`);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "unavailable" });
  });

  it("does not find the demo account by a different number", async () => {
    const h = makeHarness();
    const res = await h.call("/customers?phone=3258009901");

    expect(res.status).toBe(404);
  });

  it("answers 404 for a missing or malformed phone parameter", async () => {
    const h = makeHarness();

    expect((await h.call("/customers")).status).toBe(404);
    expect((await h.call("/customers?phone=abc")).status).toBe(404);
    expect((await h.call("/customers?phone=")).status).toBe(404);
  });

  it("logs the matched caller masked", async () => {
    const h = makeHarness();
    await h.call("/customers?phone=3258000001");

    const log = h.lastLog();
    expect(log).toMatchObject({
      event: "crm_request",
      route: "customers",
      status: 200,
      caller: "+32…0001",
    });
    expect(log).not.toHaveProperty("account");
    expect(log).not.toHaveProperty("phone");
  });
});
