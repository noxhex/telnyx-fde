import { describe, expect, it } from "vitest";

import { hasValidInternalKey } from "../src/auth.js";
import { SECRET_READ_TIMEOUT_MS } from "../src/index.js";
import { TIMED_OUT } from "../src/flags.js";
import {
  INTERNAL_KEY_HANDLE,
  makeHarness,
  TEST_INTERNAL_KEY,
} from "./helpers.js";

describe("hasValidInternalKey", () => {
  it("accepts the exact key", () => {
    expect(hasValidInternalKey(TEST_INTERNAL_KEY, TEST_INTERNAL_KEY)).toBe(true);
  });

  it("rejects a key that differs in one character", () => {
    expect(hasValidInternalKey(`${TEST_INTERNAL_KEY}x`, TEST_INTERNAL_KEY)).toBe(false);
    expect(hasValidInternalKey(TEST_INTERNAL_KEY.slice(0, -1), TEST_INTERNAL_KEY)).toBe(false);
  });

  it("rejects a key of a different length without throwing", () => {
    expect(hasValidInternalKey("short", TEST_INTERNAL_KEY)).toBe(false);
  });

  it("rejects null on either side", () => {
    expect(hasValidInternalKey(null, TEST_INTERNAL_KEY)).toBe(false);
    expect(hasValidInternalKey(TEST_INTERNAL_KEY, null)).toBe(false);
  });
});

describe("internal key on the routes", () => {
  it("answers 401 when the header is missing, before touching KV", async () => {
    const h = makeHarness();
    const res = await h.call("/customers?phone=3258000001", { key: null });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(h.kv.calls).toHaveLength(0);
  });

  it("answers 401 for a wrong key, before touching KV", async () => {
    const h = makeHarness();
    await h.setFlags({ crm_delay_ms: 0, crm_fail: false });
    const res = await h.call("/customers?phone=3258000001", { key: "not-the-key" });

    expect(res.status).toBe(401);
    // Flags were seeded but must never be read: auth comes first.
    expect(h.kv.calls.filter((c) => c.method === "get")).toHaveLength(0);
  });

  it("serves the request with the right key", async () => {
    const h = makeHarness();
    const res = await h.call("/customers?phone=3258000001", { key: TEST_INTERNAL_KEY });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountNumber: "DV-100002" });
  });

  it("fails closed when the INTERNAL_KEY secret cannot be resolved", async () => {
    const h = makeHarness({ internalKey: null });
    const res = await h.call("/customers?phone=3258000001");

    expect(res.status).toBe(401);
  });

  it("counts a secret read that cannot answer in time as missing (401, no KV)", async () => {
    const h = makeHarness();
    let timerMs = -1;
    let fireTimer!: () => void;
    // The secret read never settles; only the injected timer can end it.
    h.deps.readSecret = () => new Promise<string | null>(() => {});
    h.deps.timeout = <T>(fn: () => Promise<T>, ms: number) =>
      new Promise<T | typeof TIMED_OUT>((resolve) => {
        timerMs = ms;
        void fn();
        fireTimer = () => {
          resolve(TIMED_OUT);
        };
      });

    const pending = h.call("/customers?phone=3258000001");
    fireTimer();
    const res = await pending;

    expect(res.status).toBe(401);
    expect(timerMs).toBe(SECRET_READ_TIMEOUT_MS);
    // Auth failed before flags or anything else touched KV.
    expect(h.kv.calls).toHaveLength(0);
  });

  it("reads INTERNAL_KEY after routing and before the auth check", async () => {
    const h = makeHarness();
    await h.call("/customers?phone=3258000001", { key: "nope" });

    expect(h.secretReads).toEqual([INTERNAL_KEY_HANDLE]);
  });

  it("logs the 401 without a caller or account", async () => {
    const h = makeHarness();
    await h.call("/accounts/DV-100002", { key: "nope" });

    const log = h.lastLog();
    expect(log).toMatchObject({ event: "crm_request", route: "accounts", status: 401 });
    expect(log).not.toHaveProperty("caller");
    expect(log).not.toHaveProperty("account");
  });
});
