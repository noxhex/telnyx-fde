import { describe, expect, it } from "vitest";

import { createLogger } from "@duinvezel/shared";
import type { DisclosureResult, SessionDoc } from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import { createKvFake } from "../../../packages/shared/test/fakes/kv.js";

import type { SessionsClient } from "../src/clients/sessions.js";
import { TIMED_OUT } from "../src/config.js";
import type { TimeoutRunner } from "../src/config.js";
import type { SecretsDep, VoiceContextDeps } from "../src/deps.js";
import { handleDisclosure } from "../src/routes/disclosure.js";

import { createTestKeyPair, makeSignedRequest, makeUnsignedRequest } from "./helpers/signed-request.js";

const T0 = 1_600_000_000_000;
const VALID_SID = "0123456789abcdef0123456789abcdef";

interface HeldPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function hold<T>(): HeldPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

class SessionsStub implements SessionsClient {
  readonly disclosures: { sid: string; input: { nowMs: number } }[] = [];
  queue: Array<DisclosureResult | Error | { hold: HeldPromise<DisclosureResult> }> = [];

  create(): never {
    throw new Error("not called by disclosure");
  }

  markDisclosure(sid: string, input: { nowMs: number }): Promise<DisclosureResult> {
    this.disclosures.push({ sid, input });
    const next = this.queue.shift();
    if (next === undefined) {
      return Promise.resolve({ outcome: "logged", traceId: "trace-abc" });
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    if ("hold" in next) {
      return next.hold.promise;
    }
    return Promise.resolve(next);
  }

  get(): Promise<SessionDoc | null> {
    throw new Error("not called by disclosure");
  }
}

interface Harness {
  deps: VoiceContextDeps;
  sessions: SessionsStub;
  lines: string[];
  firePending(): void;
  timerMs(): number[];
  call(body: unknown, options?: { unsigned?: boolean }): Promise<Response>;
  lastLog(): Record<string, unknown>;
}

function makeHarness(options: { publicKey?: string | null } = {}): Harness {
  const clock = createClockFake(T0);
  const keyPair = createTestKeyPair();
  const sessions = new SessionsStub();
  const lines: string[] = [];
  const secrets: SecretsDep = {
    get: (handle) =>
      Promise.resolve(
        handle === "TELNYX_PUBLIC_KEY"
          ? options.publicKey === undefined
            ? keyPair.publicKeyBase64
            : options.publicKey
          : null,
      ),
    getKey: () => Promise.resolve(null),
  };
  interface Entry {
    ms: number;
    fired: boolean;
    settled: boolean;
    fire(): void;
  }
  const entries: Entry[] = [];
  const timeout: TimeoutRunner = <T>(fn: () => Promise<T>, ms: number) =>
    new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
      let done = false;
      const entry: Entry = {
        ms,
        fired: false,
        settled: false,
        fire() {
          if (!done) {
            done = true;
            this.fired = true;
            resolve(TIMED_OUT);
          }
        },
      };
      entries.push(entry);
      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            if (!done) {
              done = true;
              entry.settled = true;
              resolve(value);
            }
          },
          (error: unknown) => {
            if (!done) {
              done = true;
              entry.settled = true;
              reject(error);
            }
          },
        );
    });

  const log = createLogger(
    "voice-context",
    (line) => {
      lines.push(line);
    },
    clock.now,
  );
  const deps: VoiceContextDeps = {
    now: clock.now,
    // The route never touches KV, mock-crm or the account actor: fakes record any violation.
    kv: createKvFake(clock.now),
    crm: {
      lookupByPhone: () => {
        throw new Error("crm must not be called by disclosure");
      },
    },
    accounts: {
      recordCall: () => Promise.reject(new Error("accounts must not be called by disclosure")),
      snapshot: () => Promise.reject(new Error("accounts must not be called by disclosure")),
    },
    sessions,
    caches: {
      areas: { get: () => undefined, peekAt: () => undefined, has: () => false, set: () => {} },
      crm: { get: () => undefined, peekAt: () => undefined, has: () => false, set: () => {} },
    },
    // The route never reads the flags: any use fails the test.
    flagsValue: {
      get: () => Promise.reject(new Error("flagsValue must not be read by disclosure")),
      start: () => {
        throw new Error("flagsValue must not be started by disclosure");
      },
    },
    secrets,
    log,
    random: (n) => new Uint8Array(n),
    timeout,
  };
  return {
    deps,
    sessions,
    lines,
    firePending() {
      for (const entry of entries.filter((e) => !e.fired && !e.settled)) {
        entry.fire();
      }
    },
    timerMs() {
      return entries.map((e) => e.ms);
    },
    async call(body, options = {}) {
      const request = options.unsigned
        ? makeUnsignedRequest({ body, path: "/tools/disclosure" })
        : makeSignedRequest({
            keyPair,
            body,
            path: "/tools/disclosure",
            timestampSec: Math.floor(clock.now() / 1000),
          });
      return handleDisclosure(request, deps);
    },
    lastLog() {
      if (lines.length === 0) {
        throw new Error("no log lines captured");
      }
      return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    },
  };
}

describe("handleDisclosure auth", () => {
  it("rejects an unsigned request 403 with no actor call", async () => {
    const h = makeHarness();
    const res = await h.call({ session_id: VALID_SID }, { unsigned: true });
    expect(res.status).toBe(403);
    expect(h.sessions.disclosures).toEqual([]);
    expect(h.lastLog()).toMatchObject({
      event: "auth_failed",
      route: "disclosure",
      reason: "missing_headers",
      status: 403,
    });
  });

  it("fails closed with 403 no_key when the public key cannot be read", async () => {
    const h = makeHarness({ publicKey: null });
    const res = await h.call({ session_id: VALID_SID });
    expect(res.status).toBe(403);
    expect(h.sessions.disclosures).toEqual([]);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", reason: "no_key" });
  });
});

describe("handleDisclosure outcomes", () => {
  it("a logged outcome answers { logged: true } and carries the result's trace id", async () => {
    const h = makeHarness();
    h.sessions.queue.push({ outcome: "logged", traceId: "v3:trace-1" });
    const res = await h.call({ session_id: VALID_SID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logged: true });
    expect(h.sessions.disclosures).toEqual([{ sid: VALID_SID, input: { nowMs: T0 } }]);
    expect(h.lastLog()).toMatchObject({
      event: "disclosure",
      node: "route_call",
      outcome: "logged",
      logged: true,
      trace_id: "v3:trace-1",
      status: 200,
    });
    expect(h.timerMs()).toEqual([1_000, 1_000]);
  });

  it("an unchanged outcome answers { logged: true }", async () => {
    const h = makeHarness();
    h.sessions.queue.push({ outcome: "unchanged", traceId: "v3:trace-2" });
    const res = await h.call({ session_id: VALID_SID });
    expect(await res.json()).toEqual({ logged: true });
    expect(h.lastLog()).toMatchObject({ outcome: "unchanged", logged: true, trace_id: "v3:trace-2" });
  });

  it("a missing session answers { logged: false } with a null trace id", async () => {
    const h = makeHarness();
    h.sessions.queue.push({ outcome: "missing", traceId: null });
    const res = await h.call({ session_id: VALID_SID });
    expect(await res.json()).toEqual({ logged: false });
    expect(h.lastLog()).toMatchObject({ outcome: "missing", logged: false, trace_id: null });
  });

  it.each([
    ["a non-hex sid", "not-a-sid"],
    ["uppercase hex", VALID_SID.toUpperCase()],
    ["31 hex characters", VALID_SID.slice(1)],
    ["session<sid> style", `session/${VALID_SID}`],
  ])("answers { logged: false } without an actor call for %s", async (_label, sid) => {
    const h = makeHarness();
    const res = await h.call({ session_id: sid });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logged: false });
    expect(h.sessions.disclosures).toEqual([]);
    expect(h.lastLog()).toMatchObject({ outcome: "invalid_sid", logged: false });
  });

  it.each([
    ["non-JSON body", "{not json"],
    ["missing session_id", {}],
    ["a numeric session_id", { session_id: 42 }],
    ["an array body", [VALID_SID]],
  ])("answers 200 { logged: false } with outcome bad_request for %s", async (_label, body) => {
    const h = makeHarness();
    const res = await h.call(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logged: false });
    expect(h.sessions.disclosures).toEqual([]);
    expect(h.lastLog()).toMatchObject({
      event: "disclosure",
      outcome: "bad_request",
      logged: false,
      trace_id: null,
      status: 200,
    });
  });

  it("an actor timeout answers { logged: false } with outcome timeout and no trace id", async () => {
    const h = makeHarness();
    const held = hold<DisclosureResult>();
    h.sessions.queue.push({ hold: held });
    const pending = h.call({ session_id: VALID_SID });
    await tick();
    expect(h.timerMs()).toEqual([1_000, 1_000]);
    h.firePending();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logged: false });
    expect(h.lastLog()).toMatchObject({ outcome: "timeout", logged: false, trace_id: null });

    held.resolve({ outcome: "logged", traceId: "v3:late" });
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"disclosure"'))).toHaveLength(1);
  });

  it("an actor error answers { logged: false } with outcome error", async () => {
    const h = makeHarness();
    h.sessions.queue.push(new Error("actor down"));
    const res = await h.call({ session_id: VALID_SID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logged: false });
    expect(h.lastLog()).toMatchObject({ outcome: "error", logged: false });
  });
});
