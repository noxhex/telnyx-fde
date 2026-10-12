/**
 * The production wiring of card T20 ("T10 follow-up, the production box"):
 * driving the real `default.fetch` across two requests with a fake env
 * exercises the container's own refreshing flags value, shared secret
 * store and warm-up box, all created once at module scope. A refreshing
 * value or a secret store made per request instead of per container fails
 * here, because the second request would read the flags and the secrets
 * again instead of joining what the first request started.
 *
 * This file drives `default.fetch` only; the other test files drive
 * `handleRequest`, whose injected deps stay per-test, so the module-scope
 * container state never leaks into them.
 */

import { describe, expect, it } from "vitest";

import { kvKeys } from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import { createKvFake } from "../../../packages/shared/test/fakes/kv.js";

import handler from "../src/index.js";
import type { CrmEnv } from "../src/index.js";
import { TEST_DEMO_PHONE, TEST_INTERNAL_KEY } from "./helpers.js";

describe("the container's own boxes across two default.fetch requests (T20)", () => {
  it("reads the flags and both secrets once across the whole container", async () => {
    const clock = createClockFake(1_000);
    const kv = createKvFake(clock.now);
    await kv.put(kvKeys.flags(), JSON.stringify({ crm_delay_ms: 0 }));
    kv.reset();
    const secretGets: string[] = [];
    const env = {
      KV: kv,
      SECRETS: {
        get: (handle: string): Promise<string | null> => {
          secretGets.push(handle);
          if (handle === "INTERNAL_KEY") {
            return Promise.resolve(TEST_INTERNAL_KEY);
          }
          if (handle === "DEMO_CALLER_PHONE") {
            return Promise.resolve(TEST_DEMO_PHONE);
          }
          return Promise.resolve(null);
        },
      },
    } as unknown as CrmEnv;

    // The first request: an unknown path answers at once and starts the
    // container's three warm-up reads.
    const first = await handler.fetch(new Request("http://mock-crm.test/nope"), env);
    expect(first.status).toBe(404);
    expect(secretGets).toEqual(["INTERNAL_KEY", "DEMO_CALLER_PHONE"]);
    expect(kv.calls.filter((c) => c.method === "get" && c.key === kvKeys.flags())).toHaveLength(1);

    // The second request answers from what the first started: no read again.
    const second = await handler.fetch(
      new Request("http://mock-crm.test/customers?phone=3258000001", {
        headers: { "x-internal-key": TEST_INTERNAL_KEY },
      }),
      env,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ accountNumber: "DV-100002" });

    expect(secretGets).toEqual(["INTERNAL_KEY", "DEMO_CALLER_PHONE"]);
    expect(kv.calls.filter((c) => c.method === "get" && c.key === kvKeys.flags())).toHaveLength(1);
  });
});
