import { describe, expect, it } from "vitest";

import { kvKeys } from "@duinvezel/shared";
import type { KvNamespace } from "@telnyx/edge-runtime";

import { matchRoute } from "../src/index.js";
import {
  DEMO_PHONE_HANDLE,
  hold,
  INTERNAL_KEY_HANDLE,
  makeHarness,
  manualTimeout,
  TEST_DEMO_PHONE,
  TEST_INTERNAL_KEY,
  tick,
} from "./helpers.js";
import type { HeldPromise } from "./helpers.js";

describe("routing", () => {
  it("serves GET /healthz with ok and the service name", async () => {
    const h = makeHarness();
    const res = await h.call("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, svc: "mock-crm" });
  });

  it("returns 404 for a wrong method on /healthz", async () => {
    const h = makeHarness();
    const res = await h.call("/healthz", { method: "POST" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
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

describe("container warm-up (T20, the ADR-014 exception)", () => {
  it("the first request of a container, an unknown path and /healthz in turn, starts the three reads once and answers without waiting", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const reads: string[] = [];
    const heldSecrets = new Map<string, HeldPromise<string | null>>();
    h.setReadSecret((handle) => {
      reads.push(handle);
      const held = hold<string | null>();
      heldSecrets.set(handle, held);
      return held.promise;
    });
    const heldFlags = hold<unknown>();
    let flagsGets = 0;
    h.setFlagsKv({
      get: () => {
        flagsGets += 1;
        return heldFlags.promise;
      },
    } as unknown as KvNamespace);

    // An unknown path answers 404 at once, with all three reads still held.
    const first = await h.call("/nope", { key: TEST_INTERNAL_KEY });
    expect(first.status).toBe(404);
    expect(first.body).toEqual({ error: "not_found" });
    expect(reads).toEqual([INTERNAL_KEY_HANDLE, DEMO_PHONE_HANDLE]);
    expect(flagsGets).toBe(1);
    // It waited for nothing: no read raced against the window.
    expect(manual.timers).toHaveLength(0);

    // /healthz in turn: 200 at once, and the warm-up ran once — nothing new.
    const health = await h.call("/healthz", { key: null });
    expect(health.status).toBe(200);
    expect(reads).toEqual([INTERNAL_KEY_HANDLE, DEMO_PHONE_HANDLE]);
    expect(flagsGets).toBe(1);
    expect(manual.timers).toHaveLength(0);

    // A keyed request while the reads are in flight joins them, so each
    // read still runs once.
    const pending = h.call("/accounts/DV-100002", { key: TEST_INTERNAL_KEY });
    await tick();
    expect(reads).toEqual([INTERNAL_KEY_HANDLE, DEMO_PHONE_HANDLE]);
    // The internal-key wait opens the window.
    expect(manual.timers).toHaveLength(1);
    expect(manual.timers[0]?.ms).toBe(1_000);
    heldSecrets.get(INTERNAL_KEY_HANDLE)?.resolve(TEST_INTERNAL_KEY);
    await tick();
    // The flags read is still held: the window closes on the flags wait.
    expect(manual.timers).toHaveLength(2);
    manual.timers[1]?.fire();
    const keyed = await pending;
    expect(keyed.status).toBe(200); // the defaults, while the doc is unreadable
    expect(flagsGets).toBe(1);
  });

  it("once the warm-up answers, /healthz and an unknown path start no reads and touch no KV", async () => {
    const h = makeHarness();
    await h.call("/nope", { key: TEST_INTERNAL_KEY }); // the first request: warms
    await tick();
    h.kv.reset();
    h.secretReads.length = 0;

    const health = await h.call("/healthz", { key: null });
    expect(health.status).toBe(200);
    expect(h.secretReads).toEqual([]);
    expect(h.kv.calls).toEqual([]);

    const missing = await h.call("/also-nope", { key: TEST_INTERNAL_KEY });
    expect(missing.status).toBe(404);
    expect(h.secretReads).toEqual([]);
    expect(h.kv.calls).toEqual([]);
  });

  it("/healthz answers 200 even while every warm-up read is still held", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    h.setReadSecret(() => hold<string | null>().promise);
    h.setFlagsKv({ get: () => hold<unknown>().promise } as unknown as KvNamespace);

    const res = await h.call("/healthz", { key: null });
    expect(res.status).toBe(200);
    expect(manual.timers).toHaveLength(0);
  });
});

describe("secret reads per route", () => {
  it("/accounts and the line test never wait on DEMO_CALLER_PHONE", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const heldDemo = hold<string | null>();
    h.setReadSecret((handle) =>
      handle === DEMO_PHONE_HANDLE ? heldDemo.promise : Promise.resolve(TEST_INTERNAL_KEY),
    );
    h.setFlagsKv({
      get: (key: string) =>
        Promise.resolve(key === kvKeys.flags() ? { crm_delay_ms: 0 } : null),
    } as unknown as KvNamespace);

    // DEMO_CALLER_PHONE stays held the whole time; both routes answer.
    expect((await h.call("/accounts/DV-100002")).status).toBe(200);

    const h2 = makeHarness();
    h2.deps.timeout = manual.runner;
    h2.setReadSecret((handle) =>
      handle === DEMO_PHONE_HANDLE ? heldDemo.promise : Promise.resolve(TEST_INTERNAL_KEY),
    );
    expect((await h2.call("/lines/LN-000002/test", { method: "POST" })).status).toBe(200);
  });

  it("only /customers waits for the DEMO_CALLER_PHONE read, after the key passes", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const heldDemo = hold<string | null>();
    h.setReadSecret((handle) =>
      handle === DEMO_PHONE_HANDLE ? heldDemo.promise : Promise.resolve(TEST_INTERNAL_KEY),
    );

    const pending = h.call("/customers?phone=3258000001");
    await tick();
    // The last wait is for the demo phone read, inside the same window.
    const demoWait = manual.timers.at(-1);
    expect(demoWait?.fired).toBe(false);
    heldDemo.resolve(TEST_DEMO_PHONE);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountNumber: "DV-100002" });
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

  it("a flags document settling inside the window applies to the request that waited", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const heldFlags = hold<unknown>();
    h.setFlagsKv({ get: () => heldFlags.promise } as unknown as KvNamespace);

    const pending = h.call("/customers?phone=3258000001");
    await tick();
    // The key read won at once; the flags wait got the whole window.
    const flagsWait = manual.timers.at(-1);
    expect(flagsWait?.ms).toBe(1_000);

    // The document lands after 300 ms but before the window closes.
    h.clock.advance(300);
    heldFlags.resolve({ crm_fail: true });
    const res = await pending;

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "unavailable" });
    expect(flagsWait?.fired).toBe(false);
  });

  it("a flags document read after 1,000 ms applies on the next request, from the last good value and without a new read", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    let gets = 0;
    const heldFlags = hold<unknown>();
    h.setFlagsKv({
      get: () => {
        gets += 1;
        return heldFlags.promise;
      },
    } as unknown as KvNamespace);

    // The first lookup's flags wait hits the window: the defaults serve.
    const pending = h.call("/accounts/DV-100002");
    await tick();
    const flagsWait = manual.timers.at(-1);
    expect(flagsWait?.ms).toBe(1_000);
    flagsWait?.fire();
    const first = await pending;
    expect(first.status).toBe(200);
    expect(h.delays).toHaveLength(0);

    // The read answers late: its success becomes the last good value.
    h.clock.advance(100);
    heldFlags.resolve({ crm_delay_ms: 250 });
    await tick();
    expect(gets).toBe(1);

    // The next lookup applies crm_delay_ms from the last good value: it
    // waits for nothing (no new flags wait, no second read).
    const timersBefore = manual.timers.length;
    const second = await h.call("/accounts/DV-100002");
    expect(second.status).toBe(200);
    expect(h.delays).toEqual([250]);
    expect(gets).toBe(1);
    // Only the kept internal-key wait raced (and won at once).
    expect(manual.timers.length).toBe(timersBefore + 1);
    expect(manual.timers.at(-1)?.settled).toBe(true);
  });

  it("crm_fail from the last good value answers 503 at once on the next request", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    let gets = 0;
    const heldFlags = hold<unknown>();
    h.setFlagsKv({
      get: () => {
        gets += 1;
        return heldFlags.promise;
      },
    } as unknown as KvNamespace);

    const pending = h.call("/accounts/DV-100002");
    await tick();
    manual.timers.at(-1)?.fire();
    expect((await pending).status).toBe(200);

    heldFlags.resolve({ crm_fail: true });
    await tick();
    const second = await h.call("/accounts/DV-100002");
    expect(second.status).toBe(503);
    expect(second.body).toEqual({ error: "unavailable" });
    expect(gets).toBe(1);
  });

  it("a lookup after the lifetime answers at once with the old flags and starts one read", async () => {
    const h = makeHarness();
    await h.setFlags({ crm_delay_ms: 10 });
    expect((await h.call("/accounts/DV-100002")).status).toBe(200);
    expect(h.delays).toEqual([10]);

    h.kv.reset();
    h.clock.advance(10_000); // exactly the lifetime
    await h.setFlags({ crm_delay_ms: 500 });

    // The old value answers at once, and one background read starts.
    const second = await h.call("/accounts/DV-100002");
    expect(second.status).toBe(200);
    expect(h.delays).toEqual([10, 10]);
    const flagGets = h.kv.calls.filter((c) => c.method === "get" && c.key === kvKeys.flags());
    expect(flagGets).toHaveLength(1);

    // Once the refresh settles, the changed document applies.
    await tick();
    const third = await h.call("/accounts/DV-100002");
    expect(third.status).toBe(200);
    expect(h.delays).toEqual([10, 10, 500]);
  });
});

describe("the keyed read window (T20)", () => {
  it("the first keyed lookup answers when the 1,000 ms window closes, with both secrets and the default flags", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const heldKey = hold<string | null>();
    const heldDemo = hold<string | null>();
    const heldFlags = hold<unknown>();
    h.setReadSecret((handle) => {
      if (handle === INTERNAL_KEY_HANDLE) {
        return heldKey.promise;
      }
      if (handle === DEMO_PHONE_HANDLE) {
        return heldDemo.promise;
      }
      return Promise.resolve(null);
    });
    h.setFlagsKv({ get: () => heldFlags.promise } as unknown as KvNamespace);

    const pending = h.call("/customers?phone=3258000001");
    await tick();
    // The first wait opens the window: the whole 1,000 ms for the key.
    expect(manual.timers).toHaveLength(1);
    expect(manual.timers[0]?.ms).toBe(1_000);

    h.clock.advance(600);
    heldKey.resolve(TEST_INTERNAL_KEY);
    await tick();
    // The flags wait gets what remains: 400 ms.
    expect(manual.timers).toHaveLength(2);
    expect(manual.timers[1]?.ms).toBe(400);

    h.clock.advance(200);
    heldDemo.resolve(TEST_DEMO_PHONE);
    await tick();

    // The window closes at 1,000 ms: the flags wait ends and the defaults
    // apply; DEMO_CALLER_PHONE was already read, so its wait is a no-op.
    h.clock.advance(200);
    manual.timers[1]?.fire();
    await tick();
    expect(manual.timers).toHaveLength(3);
    expect(manual.timers[2]?.ms).toBe(0);

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountNumber: "DV-100002", firstName: "Marie" });
    expect(h.delays).toHaveLength(0); // the default flags
    const requestLog = h.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === "crm_request");
    expect((requestLog?.latency_ms as Record<string, unknown>).total).toBe(1_000);

    // The flags read's late success applies to the next request.
    h.clock.advance(100);
    heldFlags.resolve({ crm_fail: true });
    await tick();
    const second = await h.call("/accounts/DV-100002");
    expect(second.status).toBe(503);
    expect(second.body).toEqual({ error: "unavailable" });
  });

  it("a wrong key answers 401 without waiting for the flags", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const heldFlags = hold<unknown>();
    h.setFlagsKv({ get: () => heldFlags.promise } as unknown as KvNamespace);

    // The answer comes back while the flags document is still unreadable.
    const res = await h.call("/customers?phone=3258000001", { key: "not-the-key" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    // The one race was the internal-key read, won at once; no flags wait.
    expect(manual.timers).toHaveLength(1);
    expect(manual.timers[0]?.settled).toBe(true);
    expect(manual.timers[0]?.fired).toBe(false);
  });
});

describe("an unreadable DEMO_CALLER_PHONE answers 503 (T20)", () => {
  function holdDemoPhone(h: ReturnType<typeof makeHarness>): void {
    h.setReadSecret((handle) =>
      handle === DEMO_PHONE_HANDLE
        ? hold<string | null>().promise
        : Promise.resolve(TEST_INTERNAL_KEY),
    );
  }

  it("an unknown number with DEMO_CALLER_PHONE timed out answers 503, not 404", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    holdDemoPhone(h);

    const pending = h.call("/customers?phone=3250000000");
    await tick();
    manual.timers.at(-1)?.fire(); // the demo wait hits the window
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "unavailable" });
  });

  it("a fixture number in the same state answers 200", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    holdDemoPhone(h);

    const pending = h.call("/customers?phone=3258000001");
    await tick();
    manual.timers.at(-1)?.fire();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountNumber: "DV-100002" });
  });

  it("an unknown number with DEMO_CALLER_PHONE read answers 404", async () => {
    const h = makeHarness();
    const res = await h.call("/customers?phone=3250000000");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});

describe("secrets shared per container (T20)", () => {
  it("two keyed requests read INTERNAL_KEY once", async () => {
    const h = makeHarness();
    const first = await h.call("/accounts/DV-100002");
    const second = await h.call("/lines/LN-000002/test", { method: "POST" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The warm-up's two reads, joined by both requests; nothing more.
    expect(h.secretReads).toEqual([INTERNAL_KEY_HANDLE, DEMO_PHONE_HANDLE]);
  });

  it("two lookups of the demo number read DEMO_CALLER_PHONE once and both find the demo account", async () => {
    const h = makeHarness();
    const path = `/customers?phone=${TEST_DEMO_PHONE.replace("+", "")}`;
    const first = await h.call(path);
    const second = await h.call(path);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toMatchObject({ accountNumber: "DV-100001" });
    expect(second.body).toEqual(first.body);
    expect(h.secretReads).toEqual([INTERNAL_KEY_HANDLE, DEMO_PHONE_HANDLE]);
  });

  it("a read that timed out and then settled missing is not kept: the next request reads again", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const reads: string[] = [];
    const heldByHandle = new Map<string, HeldPromise<string | null>[]>();
    h.setReadSecret((handle) => {
      reads.push(handle);
      const held = hold<string | null>();
      const list = heldByHandle.get(handle) ?? [];
      list.push(held);
      heldByHandle.set(handle, list);
      return held.promise;
    });

    const pending = h.call("/accounts/DV-100002");
    await tick();
    manual.timers[0]?.fire(); // the internal-key wait hits the window
    expect((await pending).status).toBe(401);

    // That read settles empty afterwards: a failure, so nothing is kept.
    heldByHandle.get(INTERNAL_KEY_HANDLE)?.[0]?.resolve(null);
    await tick();

    // The next keyed request reads again — and gets in this time.
    const second = h.call("/accounts/DV-100002");
    await tick();
    heldByHandle.get(INTERNAL_KEY_HANDLE)?.[1]?.resolve(TEST_INTERNAL_KEY);
    expect((await second).status).toBe(200);
    expect(reads.filter((r) => r === INTERNAL_KEY_HANDLE)).toHaveLength(2);
  });

  it("a thrown read is not kept: the next request reads again", async () => {
    const h = makeHarness();
    const reads: string[] = [];
    let failing = true;
    h.setReadSecret((handle) => {
      reads.push(handle);
      if (failing) {
        return Promise.reject(new Error("secret store down"));
      }
      return Promise.resolve(
        handle === INTERNAL_KEY_HANDLE ? TEST_INTERNAL_KEY : TEST_DEMO_PHONE,
      );
    });
    expect((await h.call("/accounts/DV-100002")).status).toBe(401);

    failing = false;
    expect((await h.call("/accounts/DV-100002")).status).toBe(200);
    expect(reads.filter((r) => r === INTERNAL_KEY_HANDLE)).toEqual([
      INTERNAL_KEY_HANDLE,
      INTERNAL_KEY_HANDLE,
    ]);
  });

  it("an empty read is not kept: the next request reads again", async () => {
    const h = makeHarness();
    const reads: string[] = [];
    let empty = true;
    h.setReadSecret((handle) => {
      reads.push(handle);
      if (empty) {
        return Promise.resolve("");
      }
      return Promise.resolve(
        handle === INTERNAL_KEY_HANDLE ? TEST_INTERNAL_KEY : TEST_DEMO_PHONE,
      );
    });
    expect((await h.call("/accounts/DV-100002")).status).toBe(401);

    empty = false;
    expect((await h.call("/accounts/DV-100002")).status).toBe(200);
    expect(reads.filter((r) => r === INTERNAL_KEY_HANDLE)).toEqual([
      INTERNAL_KEY_HANDLE,
      INTERNAL_KEY_HANDLE,
    ]);
  });
});

describe("request logging", () => {
  function requestLines(h: ReturnType<typeof makeHarness>): Record<string, unknown>[] {
    return h.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === "crm_request");
  }

  function flagsReadLines(h: ReturnType<typeof makeHarness>): Record<string, unknown>[] {
    return h.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === "flags_read");
  }

  it("writes one crm_request line with route, status and latency_ms", async () => {
    const h = makeHarness();
    await h.call("/customers?phone=3258000001");

    const logs = requestLines(h);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      svc: "mock-crm",
      event: "crm_request",
      route: "customers",
      status: 200,
    });
    const latency = logs[0]?.latency_ms as Record<string, unknown>;
    expect(typeof latency.total).toBe("number");
    expect(typeof latency.kv).toBe("number");
  });

  it("logs unknown paths as route not_found", async () => {
    const h = makeHarness();
    await h.call("/nope");

    expect(requestLines(h)[0]).toMatchObject({
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

  it("writes one flags_read line per settled flags read, and none while no read has settled", async () => {
    const h = makeHarness();
    // No request yet, so no read ever ran.
    expect(h.lines).toEqual([]);

    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const heldFlags = hold<unknown>();
    h.setFlagsKv({ get: () => heldFlags.promise } as unknown as KvNamespace);
    const pending = h.call("/accounts/DV-100002");
    await tick();
    manual.timers.at(-1)?.fire();
    await pending;
    expect(flagsReadLines(h)).toEqual([]);

    h.clock.advance(250);
    heldFlags.resolve({ crm_delay_ms: 0 });
    await tick();
    const logs = flagsReadLines(h);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      svc: "mock-crm",
      event: "flags_read",
      outcome: "ok",
      latency_ms: { total: 250, kv: 250 },
    });
  });

  it("logs a failed flags read with outcome error", async () => {
    const h = makeHarness();
    const manual = manualTimeout();
    h.deps.timeout = manual.runner;
    const heldFlags = hold<unknown>();
    h.setFlagsKv({ get: () => heldFlags.promise } as unknown as KvNamespace);
    const pending = h.call("/accounts/DV-100002");
    await tick();
    manual.timers.at(-1)?.fire();
    await pending;

    h.clock.advance(80);
    heldFlags.reject(new Error("kv down"));
    await tick();
    const logs = flagsReadLines(h);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "flags_read",
      outcome: "error",
      latency_ms: { total: 80, kv: 80 },
    });
  });
});
