import { describe, expect, it } from "vitest";

import { matchRoute } from "../src/index.js";
import {
  DEMO_PHONE_HANDLE,
  INTERNAL_KEY_HANDLE,
  makeHarness,
  TEST_INTERNAL_KEY,
} from "./helpers.js";

describe("routing", () => {
  it("serves GET /healthz with ok and the service name", async () => {
    const h = makeHarness();
    const res = await h.call("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, svc: "mock-crm" });
  });

  it("/healthz needs no key and touches no KV", async () => {
    const h = makeHarness();
    await h.setFlags({ crm_fail: true });
    h.kv.reset(); // forget the seeding write; only the request counts

    const res = await h.call("/healthz", { key: null });

    expect(res.status).toBe(200);
    expect(h.kv.calls).toHaveLength(0);
  });

  it("returns 404 for a wrong method on /healthz", async () => {
    const h = makeHarness();
    const res = await h.call("/healthz", { method: "POST" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns 404 for an unknown path with no KV access, key or no key", async () => {
    const withKey = makeHarness();
    const res = await withKey.call("/nope", { key: TEST_INTERNAL_KEY });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(withKey.kv.calls).toHaveLength(0);

    const withoutKey = makeHarness();
    const res2 = await withoutKey.call("/packages/shared/src/index.ts", { key: null });
    expect(res2.status).toBe(404);
    expect(withoutKey.kv.calls).toHaveLength(0);
  });

  it("matches exactly the known method+path pairs", () => {
    expect(matchRoute("GET", "/healthz").name).toBe("healthz");
    expect(matchRoute("GET", "/customers").name).toBe("customers");
    expect(matchRoute("GET", "/accounts/DV-100001").name).toBe("accounts");
    expect(matchRoute("POST", "/lines/LN-000001/test").name).toBe("line_test");

    expect(matchRoute("GET", "/healthz/").name).toBe("not_found");
    expect(matchRoute("DELETE", "/customers").name).toBe("not_found");
    expect(matchRoute("GET", "/lines/LN-000001/test").name).toBe("not_found");
  });
});

describe("secret reads per route", () => {
  it("/healthz never calls SECRETS.get", async () => {
    const h = makeHarness();
    const res = await h.call("/healthz");

    expect(res.status).toBe(200);
    expect(h.secretReads).toEqual([]);
  });

  it("an unknown path never calls SECRETS.get, even with the right key", async () => {
    const h = makeHarness();
    const res = await h.call("/nope", { key: TEST_INTERNAL_KEY });

    expect(res.status).toBe(404);
    expect(h.secretReads).toEqual([]);
  });

  it("/accounts and the line test read INTERNAL_KEY only", async () => {
    const h = makeHarness();
    await h.call("/accounts/DV-100002");
    expect(h.secretReads).toEqual([INTERNAL_KEY_HANDLE]);

    const h2 = makeHarness();
    await h2.call("/lines/LN-000002/test", { method: "POST" });
    expect(h2.secretReads).toEqual([INTERNAL_KEY_HANDLE]);
  });

  it("only /customers reads DEMO_CALLER_PHONE, after the key passes", async () => {
    const h = makeHarness();
    await h.call("/customers?phone=3258000001");

    expect(h.secretReads).toEqual([INTERNAL_KEY_HANDLE, DEMO_PHONE_HANDLE]);
  });
});

describe("fault-injection flags", () => {
  it("crm_fail answers 503 unavailable on the routes but not on /healthz", async () => {
    const h = makeHarness();
    await h.setFlags({ crm_fail: true });

    const res = await h.call("/customers?phone=3258000001");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "unavailable" });

    expect((await h.call("/healthz")).status).toBe(200);
  });

  it("a bad flags document falls back to defaults and keeps serving", async () => {
    const h = makeHarness();
    await h.setFlags("{broken json");

    const res = await h.call("/customers?phone=3258000001");

    expect(res.status).toBe(200);
    expect(h.delays).toHaveLength(0);
  });

  it("crm_delay_ms delays every route except /healthz", async () => {
    const h = makeHarness();
    await h.setFlags({ crm_delay_ms: 250 });

    const res = await h.call("/customers?phone=3258000001");

    expect(res.status).toBe(200);
    expect(h.delays).toEqual([250]);

    await h.call("/healthz");
    expect(h.delays).toEqual([250]);
  });

  it("an invalid crm_delay_ms is ignored (fails closed to no delay)", async () => {
    const h = makeHarness();
    await h.setFlags({ crm_delay_ms: -50 });

    const res = await h.call("/customers?phone=3258000001");

    expect(res.status).toBe(200);
    expect(h.delays).toHaveLength(0);
  });
});

describe("request logging", () => {
  it("writes one crm_request line with route, status and latency_ms", async () => {
    const h = makeHarness();
    await h.call("/customers?phone=3258000001");

    expect(h.lines).toHaveLength(1);
    const log = h.lastLog();
    expect(log).toMatchObject({
      svc: "mock-crm",
      event: "crm_request",
      route: "customers",
      status: 200,
    });
    const latency = log.latency_ms as Record<string, unknown>;
    expect(typeof latency.total).toBe("number");
    expect(typeof latency.kv).toBe("number");
  });

  it("logs unknown paths as route not_found", async () => {
    const h = makeHarness();
    await h.call("/nope");

    expect(h.lastLog()).toMatchObject({
      event: "crm_request",
      route: "not_found",
      status: 404,
    });
  });

  it("never logs the internal key", async () => {
    const h = makeHarness();
    await h.call("/customers?phone=3258000001", { key: TEST_INTERNAL_KEY });

    expect(h.lines.join("\n")).not.toContain(TEST_INTERNAL_KEY);
  });
});
