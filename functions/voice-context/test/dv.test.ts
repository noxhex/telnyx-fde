import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createLogger,
  createMemoryCache,
  createRefreshingValue,
  decryptForTests,
  kvKeys,
  parseKey,
  sessionIdFromCallControlId,
  verifySessionToken,
} from "@duinvezel/shared";
import type {
  CreateSessionInput,
  CreateSessionResult,
  DisclosureResult,
  SessionDoc,
} from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import type { ClockFake } from "../../../packages/shared/test/fakes/clock.js";
import { createKvFake } from "../../../packages/shared/test/fakes/kv.js";
import type { KvFake } from "../../../packages/shared/test/fakes/kv.js";

import type { AccountsClient, RecordCallOutcome } from "../src/clients/accounts.js";
import { createCrmClient } from "../src/clients/crm.js";
import type { CrmCallResult, CrmClient } from "../src/clients/crm.js";
import type { SessionsClient } from "../src/clients/sessions.js";
import { createSecretStore } from "../src/index.js";
import type { SecretStore } from "../src/index.js";
import { DEFAULT_FLAGS, parseFlags, TIMED_OUT } from "../src/config.js";
import type { AreaStatusDoc, CrmAnswer, DvFlags, TimeoutRunner } from "../src/config.js";
import type { CachesDep, SecretsDep, VoiceContextDeps } from "../src/deps.js";
import { handleDv } from "../src/routes/dv.js";

import {
  createTestKeyPair,
  makeDvBody,
  makeSignedRequest,
  makeUnsignedRequest,
} from "./helpers/signed-request.js";
import type { TestKeyPair } from "./helpers/signed-request.js";

// ---------- shared constants (keys generated per run, never committed) ----------

const T0 = 1_600_000_000_000;
const CALLER = "+32491244713";
const CALLER_DIGITS = "32491244713";
const CALL_CONTROL_ID = "v3:6A0bCdEf1:2026-10-10T09:00:00Z";
const SID = sessionIdFromCallControlId(CALL_CONTROL_ID);
const TOKEN_KEY_RAW = randomBytes(32).toString("base64url");
const ENC_KEY_RAW = randomBytes(32).toString("base64url");
const INTERNAL_KEY = randomBytes(16).toString("hex");

const CUSTOMER = {
  accountNumber: "DV-100002",
  firstName: "Marie",
  postcode: "8630",
  areaName: "Veurne",
  lineId: "LN-000002",
};


// ---------- held promises and manual timers ----------

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

/** Flushes the microtask queue so a handler awaiting stubbed promises can advance. */
async function tick(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

interface TimerEntry {
  ms: number;
  fired: boolean;
  settled: boolean;
  fire(): void;
}

/** A TimeoutRunner whose timers only fire when the test says so; fns start immediately. */
class ManualTimers {
  readonly entries: TimerEntry[] = [];

  readonly runner: TimeoutRunner = <T>(fn: () => Promise<T>, ms: number) =>
    new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
      let done = false;
      const entry: TimerEntry = {
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
      this.entries.push(entry);
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

  pending(): TimerEntry[] {
    return this.entries.filter((e) => !e.fired && !e.settled);
  }

  fireAllPending(): void {
    for (const entry of this.pending()) {
      entry.fire();
    }
  }
}

// ---------- scriptable stubs ----------

type QueueEntry<T> = T | Error | { hold: HeldPromise<T> };

function dequeue<T>(queue: QueueEntry<T>[], fallback: T): Promise<T> {
  const next = queue.shift();
  if (next === undefined) {
    return Promise.resolve(fallback);
  }
  if (next instanceof Error) {
    return Promise.reject(next);
  }
  if (typeof next === "object" && next !== null && "hold" in next) {
    return next.hold.promise;
  }
  return Promise.resolve(next);
}

class CrmStub implements CrmClient {
  readonly calls: string[] = [];
  readonly queue: QueueEntry<CrmCallResult>[] = [];
  defaultResult: CrmCallResult = { ok: true, answer: { kind: "not_found" } };

  lookupByPhone(digits: string): Promise<CrmCallResult> {
    this.calls.push(digits);
    return dequeue(this.queue, this.defaultResult);
  }
}

class AccountsStub implements AccountsClient {
  readonly recordCalls: {
    accountNumber: string;
    input: { callId: string; nowMs: number };
    traceId: string;
  }[] = [];
  readonly snapshots: string[] = [];
  readonly queue: QueueEntry<RecordCallOutcome>[] = [];
  defaultResult: RecordCallOutcome = { repeatCaller: false };

  recordCall(
    accountNumber: string,
    input: { callId: string; nowMs: number },
    traceId: string,
  ): Promise<RecordCallOutcome> {
    this.recordCalls.push({ accountNumber, input, traceId });
    return dequeue(this.queue, this.defaultResult);
  }

  snapshot(accountNumber: string): Promise<unknown> {
    this.snapshots.push(accountNumber);
    return Promise.resolve({});
  }
}

function createdSession(input: CreateSessionInput, sid: string): CreateSessionResult {
  const session: SessionDoc = {
    v: 1,
    sid,
    traceId: input.traceId,
    identity: input.identity,
    accountNumber: input.accountNumber ?? null,
    postcode: input.postcode ?? null,
    lineId: input.lineId ?? null,
    callerPhone: input.callerPhone ?? null,
    createdAt: input.nowMs,
    expiresAt: input.nowMs + 7_200_000,
    disclosedAt: null,
    verify: { failures: 0, lockedUntil: null },
  };
  return { created: true, session };
}

class SessionsStub implements SessionsClient {
  readonly creates: { sid: string; input: CreateSessionInput }[] = [];
  readonly disclosures: { sid: string; input: { nowMs: number } }[] = [];
  readonly gets: { sid: string; input: { nowMs: number } }[] = [];
  readonly createQueue: QueueEntry<CreateSessionResult>[] = [];
  readonly disclosureQueue: QueueEntry<DisclosureResult>[] = [];
  readonly getQueue: QueueEntry<SessionDoc | null>[] = [];

  create(sid: string, input: CreateSessionInput): Promise<CreateSessionResult> {
    this.creates.push({ sid, input });
    return dequeue(this.createQueue, createdSession(input, sid));
  }

  markDisclosure(sid: string, input: { nowMs: number }): Promise<DisclosureResult> {
    this.disclosures.push({ sid, input });
    return dequeue(this.disclosureQueue, { outcome: "logged", traceId: CALL_CONTROL_ID });
  }

  get(sid: string, input: { nowMs: number }): Promise<SessionDoc | null> {
    this.gets.push({ sid, input });
    return dequeue(this.getQueue, null);
  }
}

/**
 * The secrets double, backed by the function's own `createSecretStore` plus
 * a memoised `getKey` the way index.ts builds them for one container (T22):
 * a success is kept for the rest of the test, a failed or empty read is
 * not (the next use reads again), and waiters share a read in flight. So
 * route tests exercise the same keep-and-join behaviour the deployed
 * container has.
 */
class SecretsStub implements SecretsDep {
  readonly reads: string[] = [];
  /** Handles whose read never settles until the test settles it. */
  readonly held = new Map<string, HeldPromise<string | null>>();
  private readonly store: SecretStore;
  private readonly keys = new Map<string, Uint8Array>();

  constructor(readonly values: Record<string, string | null>) {
    this.store = createSecretStore((handle) => {
      this.reads.push(handle);
      return this.held.get(handle)?.promise ?? Promise.resolve(this.values[handle] ?? null);
    });
  }

  hold(handle: string): HeldPromise<string | null> {
    const held = hold<string | null>();
    this.held.set(handle, held);
    return held;
  }

  get(handle: string): Promise<string | null> {
    return this.store.read(handle);
  }

  async getKey(handle: string): Promise<Uint8Array | null> {
    const hit = this.keys.get(handle);
    if (hit !== undefined) {
      return hit;
    }
    const raw = await this.store.read(handle);
    if (raw === null) {
      return null;
    }
    try {
      const bytes = parseKey(raw);
      this.keys.set(handle, bytes);
      return bytes;
    } catch {
      return null;
    }
  }
}

// ---------- harness ----------

interface Harness {
  deps: VoiceContextDeps;
  clock: ClockFake;
  kv: KvFake;
  timers: ManualTimers;
  crm: CrmStub;
  accounts: AccountsStub;
  sessions: SessionsStub;
  secrets: SecretsStub;
  lines: string[];
  keyPair: TestKeyPair;
  /** Signs and POSTs a body to /dv. */
  call(
    body?: Record<string, unknown>,
    options?: { staleTimestamp?: boolean; unsigned?: boolean },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  lastLog(): Record<string, unknown>;
}

interface HarnessSeed {
  flagsDoc?: unknown;
  /** postcode → value stored under `area/<postcode>/status`. */
  areaDocs?: Record<string, unknown>;
  /** caller digits → raw JSON string stored under `crm/phone/<digits>`. */
  crmKvAnswers?: Record<string, string>;
  secrets?: Partial<Record<string, string | null>>;
}

function makeHarness(seed: HarnessSeed = {}): Harness {
  const clock = createClockFake(T0);
  const kv = createKvFake(clock.now);
  const timers = new ManualTimers();
  const crm = new CrmStub();
  const accounts = new AccountsStub();
  const sessions = new SessionsStub();
  const keyPair = createTestKeyPair();
  const secrets = new SecretsStub({
    TELNYX_PUBLIC_KEY: keyPair.publicKeyBase64,
    MCP_TOKEN_KEY: TOKEN_KEY_RAW,
    MCP_ENC_KEY: ENC_KEY_RAW,
    INTERNAL_KEY,
    ...seed.secrets,
  });
  const lines: string[] = [];
  const log = createLogger(
    "voice-context",
    (line) => {
      lines.push(line);
    },
    clock.now,
  );
  const caches: CachesDep = {
    areas: createMemoryCache<AreaStatusDoc | null>(10_000, clock.now),
    crm: createMemoryCache<CrmAnswer>(60_000, clock.now),
  };
  // The container's refreshing flags value, fresh per test, built the way
  // index.ts builds it for one container. The read and the timeout delegate
  // to deps, so a test can swap deps.kv or deps.timeout mid-flight.
  const flagsValue = createRefreshingValue<DvFlags>({
    read: async () => parseFlags(await deps.kv.get(kvKeys.flags(), { type: "json" })),
    lifetimeMs: 10_000,
    fallback: DEFAULT_FLAGS,
    now: clock.now,
    timeout: (fn, ms) => deps.timeout(fn, ms),
    onSettled: (outcome, durationMs) => {
      log.log("info", "flags_read", {
        outcome,
        latency_ms: { total: durationMs, kv: durationMs },
      });
    },
  });
  const deps: VoiceContextDeps = {
    now: clock.now,
    kv,
    crm,
    accounts,
    sessions,
    caches,
    flagsValue,
    secrets,
    log,
    random: (n) => randomBytes(n),
    timeout: timers.runner,
  };

  if (seed.flagsDoc !== undefined) {
    void kv.put(kvKeys.flags(), JSON.stringify(seed.flagsDoc));
  }
  for (const [postcode, doc] of Object.entries(seed.areaDocs ?? {})) {
    void kv.put(kvKeys.areaStatus(postcode), JSON.stringify(doc));
  }
  for (const [digits, raw] of Object.entries(seed.crmKvAnswers ?? {})) {
    void kv.put(kvKeys.crmPhone(digits), raw);
  }
  kv.reset();

  return {
    deps,
    clock,
    kv,
    timers,
    crm,
    accounts,
    sessions,
    secrets,
    lines,
    keyPair,
    async call(body, options = {}) {
      const payload = body ?? makeDvBody();
      const request = options.unsigned
        ? makeUnsignedRequest({ body: payload })
        : makeSignedRequest({
            keyPair,
            body: payload,
            timestampSec:
              Math.floor(clock.now() / 1000) - (options.staleTimestamp === true ? 600 : 0),
          });
      const res = await handleDv(request, deps);
      return {
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
      };
    },
    lastLog() {
      if (lines.length === 0) {
        throw new Error("no log lines captured");
      }
      return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    },
  };
}

// ---------- flags-read helpers (T20) ----------

/** Wraps deps.kv so every `flags/global` get is held by the test (and recorded); other keys go to the fake. */
function wrapFlagsKv(h: Harness, held: Promise<unknown>): void {
  const inner = h.deps.kv;
  h.deps.kv = {
    get: ((key: unknown, options: unknown) => {
      if (key === kvKeys.flags()) {
        h.kv.calls.push({ method: "get", key: kvKeys.flags(), options: { type: "json" } });
        return held;
      }
      return (inner.get as (k: never, o: never) => Promise<unknown>)(key as never, options as never);
    }),
    put: inner.put.bind(inner),
    delete: inner.delete.bind(inner),
    list: inner.list.bind(inner),
  } as unknown as KvFake;
}

function flagsGets(h: Harness): number {
  return h.kv.calls.filter((c) => c.method === "get" && c.key === kvKeys.flags()).length;
}

function flagsReadLines(h: Harness): Record<string, unknown>[] {
  return h.lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.event === "flags_read");
}

// ---------- auth ----------

describe("handleDv auth", () => {
  function expectNoStateAccess(h: Harness): void {
    expect(h.kv.calls).toEqual([]);
    expect(h.crm.calls).toEqual([]);
    expect(h.accounts.recordCalls).toEqual([]);
    expect(h.sessions.creates).toEqual([]);
    expect(h.sessions.disclosures).toEqual([]);
    expect(h.sessions.gets).toEqual([]);
  }

  it("rejects an unsigned request 403, before any KV or actor access", async () => {
    const h = makeHarness();
    const { status, body } = await h.call(makeDvBody(), { unsigned: true });
    expect(status).toBe(403);
    expect(body).toEqual({ error: "forbidden" });
    expectNoStateAccess(h);
    const log = h.lastLog();
    expect(log.event).toBe("auth_failed");
    expect(log.reason).toBe("missing_headers");
    expect(log.user_agent).toBe("Telnyx-Webhook/1.0");
  });

  it("rejects a stale timestamp 403, before any KV or actor access", async () => {
    const h = makeHarness();
    const { status } = await h.call(makeDvBody(), { staleTimestamp: true });
    expect(status).toBe(403);
    expectNoStateAccess(h);
    expect(h.lastLog().reason).toBe("stale_timestamp");
  });

  it("rejects a signature from the wrong key 403", async () => {
    const h = makeHarness();
    const wrong = createTestKeyPair();
    const res = await handleDv(
      makeSignedRequest({ keyPair: wrong, body: makeDvBody() }),
      h.deps,
    );
    expect(res.status).toBe(403);
    expectNoStateAccess(h);
    expect(h.lastLog().reason).toBe("invalid_signature");
  });

  it("fails closed 403 with reason no_key when TELNYX_PUBLIC_KEY cannot be read", async () => {
    const h = makeHarness({ secrets: { TELNYX_PUBLIC_KEY: null } });
    const { status } = await h.call(makeDvBody());
    expect(status).toBe(403);
    expectNoStateAccess(h);
    expect(h.lastLog().reason).toBe("no_key");
  });
});

// ---------- input validation ----------

describe("handleDv input", () => {
  it("rejects a wrong event_type with 400", async () => {
    const h = makeHarness();
    const { status } = await h.call({
      data: { event_type: "call.hangup", payload: {} },
    });
    expect(status).toBe(400);
    expect(h.kv.calls).toEqual([]);
    expect(h.sessions.creates).toEqual([]);
  });

  it("rejects malformed JSON with 400", async () => {
    const h = makeHarness();
    const res = await handleDv(
      makeSignedRequest({ keyPair: h.keyPair, body: "{not json" }),
      h.deps,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a payload missing telnyx_conversation_channel with 400", async () => {
    const h = makeHarness();
    const body = makeDvBody();
    delete (body.data as { payload: Record<string, unknown> }).payload
      .telnyx_conversation_channel;
    const { status } = await h.call(body);
    expect(status).toBe(400);
  });
});

// ---------- happy paths ----------

describe("handleDv happy paths", () => {
  it("answers a known attested caller with the full variable set, and every value is a string", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const { status, body } = await h.call(makeDvBody({ telnyx_end_user_target_verified: true }));
    expect(status).toBe(200);

    const dynamic = body.dynamic_variables as Record<string, unknown>;
    expect(dynamic).toBeDefined();
    for (const [name, value] of Object.entries(dynamic)) {
      expect(typeof value, `variable ${name} must be a string`).toBe("string");
    }
    // Nothing is answered flat: the platform silently ignores a flat object.
    expect(body.session_id).toBeUndefined();
    expect(dynamic).toEqual({
      session_ok: "true",
      session_id: SID,
      greeting_line: "Hi Marie",
      first_name: "Marie",
      caller_known: "true",
      identity_level: "attested",
      needs_verification: "false",
      verify_mode: "full",
      area_code: "8630",
      area_name: "Veurne",
      area_outage: "false",
      outage_eta: "as soon as possible",
      repeat_caller: "false",
      diagnostics_enabled: "true",
    });

    const log = h.lastLog();
    expect(log).toMatchObject({
      event: "dv",
      node: "init",
      trace_id: CALL_CONTROL_ID,
      caller: "+32…4713",
      account: "DV-…002",
      identity: "attested",
      area: "8630",
      area_outage: "false",
      repeat_caller: "false",
      cache: "miss",
      cache_write: "ok",
      outcome: "ok",
      reasons: [],
      status: 200,
    });
    expect((log.latency_ms as { total: number }).total).toBeGreaterThanOrEqual(0);
  });

  it("mints a token that decrypts under MCP_ENC_KEY and verifies under MCP_TOKEN_KEY with a two-hour exp", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const { body } = await h.call(makeDvBody());
    const encrypted = (body.encrypted_dynamic_variables as { mcp_token: string }).mcp_token;
    expect(typeof encrypted).toBe("string");

    const token = decryptForTests(encrypted, parseKey(ENC_KEY_RAW));
    const check = verifySessionToken(token, parseKey(TOKEN_KEY_RAW), h.clock.now());
    expect(check).toEqual({
      ok: true,
      claims: { v: 1, sid: SID, exp: T0 + 2 * 60 * 60 * 1000 },
    });
  });

  it("passes the trace id and sid to recordCall and the full session fields to SESSION.create", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    await h.call(makeDvBody({ telnyx_end_user_target_verified: true }));

    expect(h.accounts.recordCalls).toEqual([
      {
        accountNumber: "DV-100002",
        input: { callId: SID, nowMs: T0 },
        traceId: CALL_CONTROL_ID,
      },
    ]);
    expect(h.sessions.creates).toEqual([
      {
        sid: SID,
        input: {
          traceId: CALL_CONTROL_ID,
          identity: "attested",
          accountNumber: "DV-100002",
          postcode: "8630",
          lineId: "LN-000002",
          callerPhone: CALLER,
          nowMs: T0,
        },
      },
    ]);

    // The mock-crm answer is written back for other containers: 600 s TTL.
    const writes = h.kv.calls.filter((c) => c.method === "put");
    expect(writes).toEqual([
      {
        method: "put",
        key: kvKeys.crmPhone(CALLER_DIGITS),
        options: { expirationTtl: 600 },
      },
    ]);
    const written = await h.kv.get(kvKeys.crmPhone(CALLER_DIGITS), { type: "json" });
    expect(written).toEqual(CUSTOMER);
  });

  it("maps a number match (verified omitted) to verify_mode postcode and needs_verification true", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const { body } = await h.call(makeDvBody());
    const dynamic = body.dynamic_variables as Record<string, string>;
    expect(dynamic.identity_level).toBe("number_match");
    expect(dynamic.needs_verification).toBe("true");
    expect(dynamic.verify_mode).toBe("postcode");
    expect(dynamic.greeting_line).toBe("Hi Marie");
  });

  it("maps telnyx_end_user_target_verified false to number_match, not attested", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const { body } = await h.call(makeDvBody({ telnyx_end_user_target_verified: false }));
    expect((body.dynamic_variables as Record<string, string>).identity_level).toBe(
      "number_match",
    );
  });

  it("answers an unknown caller (mock-crm 404) as anonymous and caches the not-found marker", async () => {
    const h = makeHarness();
    const { status, body } = await h.call(makeDvBody());
    expect(status).toBe(200);
    expect(body.dynamic_variables).toMatchObject({
      session_ok: "true",
      session_id: SID,
      greeting_line: "Hello",
      first_name: "unknown",
      caller_known: "false",
      identity_level: "anonymous",
      needs_verification: "true",
      verify_mode: "full",
      area_code: "unknown",
      area_name: "your area",
      area_outage: "false",
      repeat_caller: "false",
    });

    // Anonymous: no recordCall, but the session still carries the trace and phone.
    expect(h.accounts.recordCalls).toEqual([]);
    expect(h.sessions.creates).toEqual([
      {
        sid: SID,
        input: {
          traceId: CALL_CONTROL_ID,
          identity: "anonymous",
          callerPhone: CALLER,
          nowMs: T0,
        },
      },
    ]);
    const written = await h.kv.get(kvKeys.crmPhone(CALLER_DIGITS), { type: "json" });
    expect(written).toEqual({ notFound: true });
    expect(h.lastLog()).toMatchObject({
      identity: "anonymous",
      outcome: "ok",
      reasons: [],
      cache: "miss",
      cache_write: "ok",
    });
  });

  it("treats a channel other than phone_call as an anonymous caller without any lookup", async () => {
    const h = makeHarness();
    const { status, body } = await h.call(
      makeDvBody({ telnyx_conversation_channel: "websocket" }),
    );
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).identity_level).toBe("anonymous");
    expect(h.crm.calls).toEqual([]);
    expect(h.accounts.recordCalls).toEqual([]);
    expect(h.sessions.creates[0]).toEqual({
      sid: SID,
      input: { traceId: CALL_CONTROL_ID, identity: "anonymous", nowMs: T0 },
    });
    // No CRM cache key was read or written for a caller that has no digits.
    const crmKeyOps = h.kv.calls.filter((c) => c.key?.startsWith("crm/"));
    expect(crmKeyOps).toEqual([]);
    expect(h.lastLog()).toMatchObject({
      caller: null,
      cache: "miss",
      outcome: "ok",
      channel: "websocket",
    });
  });

  it("logs telnyx_conversation_channel as received, cut to 32 characters (T22)", async () => {
    const h = makeHarness();
    const long = `webrtc-${"x".repeat(80)}`;
    const { status } = await h.call(
      makeDvBody({ telnyx_conversation_channel: long }),
    );
    expect(status).toBe(200);
    expect(h.lastLog().channel).toBe(long.slice(0, 32));
    expect((h.lastLog().channel as string).length).toBe(32);

    const second = makeHarness();
    await second.call(makeDvBody());
    expect(second.lastLog().channel).toBe("phone_call");
  });

  it("a caller with fewer than eight digits gets no lookup and no crm/phone key, anonymous like no phone (T22)", async () => {
    const h = makeHarness();
    // Seven digits, the way 13 October's browser test call arrived.
    const { status, body } = await h.call(
      makeDvBody({ telnyx_end_user_target: "+3249124" }),
    );
    expect(status).toBe(200);
    expect(body.dynamic_variables).toMatchObject({
      caller_known: "false",
      identity_level: "anonymous",
      greeting_line: "Hello",
    });
    // No mock-crm call, no CRM cache read or write, no 404 cached as
    // "not found" (DEBUGLOG issue 17).
    expect(h.crm.calls).toEqual([]);
    expect(h.kv.calls.filter((c) => c.key?.startsWith("crm/"))).toEqual([]);
    // Still a session with the caller's phone, and an untroubled log line.
    expect(h.sessions.creates[0]).toEqual({
      sid: SID,
      input: {
        traceId: CALL_CONTROL_ID,
        identity: "anonymous",
        callerPhone: "+3249124",
        nowMs: T0,
      },
    });
    expect(h.lastLog()).toMatchObject({
      identity: "anonymous",
      outcome: "ok",
      reasons: [],
      channel: "phone_call",
    });

    // The boundary: exactly eight digits do get a lookup.
    const second = makeHarness();
    await second.call(makeDvBody({ telnyx_end_user_target: "+32491244" }));
    expect(second.crm.calls).toEqual(["32491244"]);
    expect(
      second.kv.calls.some(
        (c) => c.method === "get" && c.key === kvKeys.crmPhone("32491244"),
      ),
    ).toBe(true);
  });

  it("reads repeat_caller true from recordCall", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    h.accounts.defaultResult = { repeatCaller: true };
    const { body } = await h.call(makeDvBody());
    expect((body.dynamic_variables as Record<string, string>).repeat_caller).toBe("true");
    expect(h.lastLog().repeat_caller).toBe("true");
  });

  it("gives every dependency call the card's own timeout", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    await h.call(makeDvBody());
    expect(h.timers.entries.map((e) => e.ms)).toEqual([
      1_000, // TELNYX_PUBLIC_KEY
      1_000, // flags/global
      1_000, // MCP_TOKEN_KEY
      1_000, // MCP_ENC_KEY
      2_000, // the CRM lookup race (T22: covers the key read and a cold mock-crm)
      2_000, 2_000, 2_000, 2_000, 2_000, // the five area statuses (T22)
      600, // recordCall
      1_000, // SESSION.create
      2_500, // the CRM cache write
    ]);
  });
});

// ---------- degraded CRM paths ----------

describe("handleDv degraded CRM", () => {
  it("answers anonymous and degraded with crm_timeout when both sides hang", async () => {
    const h = makeHarness();
    const heldCrm = hold<CrmCallResult>();
    h.crm.queue.push({ hold: heldCrm });
    const pending = h.call(makeDvBody());
    await tick();
    h.timers.fireAllPending();
    const { status, body } = await pending;

    expect(status).toBe(200);
    expect(body.dynamic_variables).toMatchObject({
      caller_known: "false",
      identity_level: "anonymous",
      greeting_line: "Hello",
    });
    expect(h.lastLog()).toMatchObject({
      outcome: "degraded",
      reasons: ["crm_timeout"],
      cache: "miss",
      identity: "anonymous",
    });
    // The session is still created, so the call keeps its trace and phone.
    expect(h.sessions.creates).toHaveLength(1);
    expect(h.accounts.recordCalls).toEqual([]);

    // A late mock-crm answer changes nothing, and the timeout is not cached.
    heldCrm.resolve({ ok: true, answer: { kind: "customer", customer: CUSTOMER } });
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"dv"'))).toHaveLength(1);
    expect(h.kv.calls.filter((c) => c.method === "put")).toEqual([]);
    h.kv.reset();
    await h.call();
    expect(h.kv.calls.some((c) => c.method === "get" && c.key === kvKeys.crmPhone(CALLER_DIGITS))).toBe(true);
  });

  it("answers anonymous and degraded with crm_error when both sides fail", async () => {
    const h = makeHarness();
    // Unparseable JSON under the crm key fails the KV read itself.
    await h.kv.put(kvKeys.crmPhone(CALLER_DIGITS), "{not json");
    h.kv.reset();
    h.crm.defaultResult = { ok: false };
    const { status, body } = await h.call(makeDvBody());
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).identity_level).toBe("anonymous");
    expect(h.lastLog()).toMatchObject({
      outcome: "degraded",
      reasons: ["crm_error"],
      cache: "miss",
    });
  });

  it("a KV hit wins while mock-crm is still pending: cache kv, no cache write", async () => {
    const h = makeHarness({ crmKvAnswers: { [CALLER_DIGITS]: JSON.stringify(CUSTOMER) } });
    const heldCrm = hold<CrmCallResult>();
    h.crm.queue.push({ hold: heldCrm });
    const pending = h.call(makeDvBody());
    await tick();
    const { status, body } = await pending;

    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).first_name).toBe("Marie");
    expect(h.accounts.recordCalls).toHaveLength(1);
    expect(h.kv.calls.filter((c) => c.method === "put")).toEqual([]);
    expect(h.lastLog()).toMatchObject({ cache: "kv", outcome: "ok", reasons: [] });
    expect(h.lastLog()).not.toHaveProperty("cache_write");

    // The pending mock-crm call can settle later without changing anything.
    heldCrm.resolve({ ok: false });
    await tick();
    expect(h.kv.calls.filter((c) => c.method === "put")).toEqual([]);
  });

  it("a mock-crm failure while the KV read is pending still ends with the KV hit", async () => {
    const h = makeHarness({ crmKvAnswers: { [CALLER_DIGITS]: JSON.stringify(CUSTOMER) } });
    h.crm.defaultResult = { ok: false };
    // Hold the KV read for the crm key so the failure lands first.
    const heldGet = hold<unknown>();
    const inner = h.deps.kv;
    h.deps.kv = {
      get: ((key: unknown, options: unknown) =>
        key === kvKeys.crmPhone(CALLER_DIGITS)
          ? heldGet.promise
          : (inner.get as (k: never, o: never) => Promise<unknown>)(key as never, options as never)),
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    } as unknown as KvFake;

    const pending = h.call(makeDvBody());
    await tick();
    expect(h.crm.calls).toEqual([CALLER_DIGITS]);
    heldGet.resolve(CUSTOMER);
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).first_name).toBe("Marie");
    expect(h.lastLog()).toMatchObject({ cache: "kv", outcome: "ok", reasons: [] });
  });

  it("a KV miss waits for mock-crm, then writes the KV cache", async () => {
    const h = makeHarness();
    const heldCrm = hold<CrmCallResult>();
    h.crm.queue.push({ hold: heldCrm });
    const pending = h.call(makeDvBody());
    await tick();
    expect(h.kv.calls.some((c) => c.method === "get" && c.key === kvKeys.crmPhone(CALLER_DIGITS))).toBe(true);
    expect(h.kv.calls.filter((c) => c.method === "put")).toEqual([]);

    heldCrm.resolve({ ok: true, answer: { kind: "customer", customer: CUSTOMER } });
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).first_name).toBe("Marie");

    const puts = h.kv.calls.filter((c) => c.method === "put");
    expect(puts).toEqual([
      {
        method: "put",
        key: kvKeys.crmPhone(CALLER_DIGITS),
        options: { expirationTtl: 600 },
      },
    ]);
    expect(h.lastLog()).toMatchObject({ cache: "miss", cache_write: "ok" });
  });
});

// ---------- the INTERNAL_KEY read inside the CRM bound (T22) ----------

describe("handleDv: the key read counts against the lookup's own bound (T22)", () => {
  /**
   * Wires the real CRM client into the harness: its `readInternalKey` and
   * its fetch are held by the test, so the key read and mock-crm's answer
   * land when the test says, measured on the fake clock.
   */
  function wireRealCrm(h: Harness): {
    heldKey: HeldPromise<string | null>;
    heldFetch: HeldPromise<Response>;
    fetchCalls: { url: string; init?: RequestInit }[];
  } {
    const heldKey = hold<string | null>();
    const heldFetch = hold<Response>();
    const fetchCalls: { url: string; init?: RequestInit }[] = [];
    h.deps.crm = createCrmClient({
      crmUrl: "http://mock-crm.test",
      readInternalKey: () => heldKey.promise,
      fetchImpl: ((url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init });
        return heldFetch.promise;
      }) as unknown as typeof fetch,
    });
    return { heldKey, heldFetch, fetchCalls };
  }

  it("identifies the caller when the key lands at 1,200 ms and mock-crm 600 ms later", async () => {
    const h = makeHarness();
    const { heldKey, heldFetch, fetchCalls } = wireRealCrm(h);
    const pending = h.call(makeDvBody());
    await tick();

    // The whole lookup race gets the card's 2,000 ms — the key read and
    // mock-crm's answer fit inside it one after another. Before T22 the key
    // read was cut at 1,000 ms and this exact scenario was `crm_error`
    // (DEBUGLOG issue 17, Thiago's call at 12:35).
    expect(h.timers.entries.map((e) => e.ms)).toEqual([
      1_000, 1_000, 1_000, 1_000, // public key, flags, two token keys
      2_000, // the lookup race: no separate 1,000 ms cut for INTERNAL_KEY
      2_000, 2_000, 2_000, 2_000, 2_000, // the five area statuses
    ]);

    h.clock.advance(1_200);
    heldKey.resolve(INTERNAL_KEY);
    await tick();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      `http://mock-crm.test/customers?phone=${CALLER_DIGITS}`,
    );
    expect(fetchCalls[0]?.init?.headers).toEqual({ "x-internal-key": INTERNAL_KEY });

    h.clock.advance(600);
    heldFetch.resolve(Response.json(CUSTOMER));
    const { status, body } = await pending;

    expect(status).toBe(200);
    const dynamic = body.dynamic_variables as Record<string, string>;
    expect(dynamic.first_name).toBe("Marie");
    expect(dynamic.identity_level).toBe("number_match");
    expect(h.timers.entries[4]?.fired).toBe(false);
    expect(h.lastLog()).toMatchObject({
      identity: "number_match",
      outcome: "ok",
      reasons: [],
      cache: "miss",
      cache_write: "ok",
    });
    const latency = h.lastLog().latency_ms as Record<string, unknown>;
    expect(latency.crm).toBe(1_800);
  });

  it("still identifies the caller at exactly 2,000 ms combined (key 1,200 + mock-crm 800)", async () => {
    const h = makeHarness();
    const { heldKey, heldFetch } = wireRealCrm(h);
    const pending = h.call(makeDvBody());
    await tick();

    h.clock.advance(1_200);
    heldKey.resolve(INTERNAL_KEY);
    await tick();
    h.clock.advance(800);
    heldFetch.resolve(Response.json(CUSTOMER));
    const { status, body } = await pending;

    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).first_name).toBe("Marie");
    expect(h.timers.entries[4]?.fired).toBe(false);
    expect(h.lastLog()).toMatchObject({ outcome: "ok", reasons: [] });
  });

  it("at 2,001 ms combined the race times out: anonymous with crm_timeout, and the late answer is absorbed", async () => {
    const h = makeHarness();
    const { heldKey, heldFetch } = wireRealCrm(h);
    const pending = h.call(makeDvBody());
    await tick();

    h.clock.advance(1_200);
    heldKey.resolve(INTERNAL_KEY);
    await tick();
    h.clock.advance(801);
    expect(h.timers.entries[4]?.ms).toBe(2_000);
    h.timers.entries[4]?.fire();
    const { status, body } = await pending;

    expect(status).toBe(200);
    expect(body.dynamic_variables).toMatchObject({
      caller_known: "false",
      identity_level: "anonymous",
    });
    expect(h.lastLog()).toMatchObject({
      outcome: "degraded",
      reasons: ["crm_timeout"],
      cache: "miss",
    });

    // mock-crm's answer lands after the timeout: absorbed quietly, never
    // cached, no second log line.
    heldFetch.resolve(Response.json(CUSTOMER));
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"dv"'))).toHaveLength(1);
    expect(h.kv.calls.filter((c) => c.method === "put")).toEqual([]);
  });
});

// ---------- degraded actors, sessions, secrets, flags ----------

describe("handleDv degraded actors and sessions", () => {
  it("an actor failure means repeat_caller false and degraded with actor_error", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    h.accounts.queue.push(new Error("actor down"));
    const { status, body } = await h.call(makeDvBody());
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).repeat_caller).toBe("false");
    expect(h.lastLog()).toMatchObject({
      outcome: "degraded",
      reasons: ["actor_error"],
      repeat_caller: "false",
    });
    // The session and the cache write still ran.
    expect(h.sessions.creates).toHaveLength(1);
    expect(h.kv.calls.some((c) => c.method === "put")).toBe(true);
  });

  it("an actor timeout means repeat_caller false and degraded with actor_timeout, and a late answer changes nothing", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const held = hold<{ repeatCaller: boolean }>();
    h.accounts.queue.push({ hold: held });
    const pending = h.call(makeDvBody());
    await tick();
    // Entries: pubkey, flags, two token keys, crm race, five areas — recordCall is entry 10.
    expect(h.timers.entries[10]?.ms).toBe(600);
    h.timers.entries[10]?.fire();
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).repeat_caller).toBe("false");
    expect(h.lastLog()).toMatchObject({ outcome: "degraded", reasons: ["actor_timeout"] });

    held.resolve({ repeatCaller: true });
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"dv"'))).toHaveLength(1);
  });

  it("a SESSION.create failure still answers 200, degraded, with session_error", async () => {
    const h = makeHarness();
    h.sessions.createQueue.push(new Error("session store down"));
    const { status, body } = await h.call(makeDvBody());
    expect(status).toBe(200);
    expect(body.dynamic_variables).toMatchObject({
      session_ok: "true",
      identity_level: "anonymous",
    });
    expect(h.lastLog()).toMatchObject({ outcome: "degraded", reasons: ["session_error"] });
  });

  it("a SESSION.create timeout still answers 200, degraded, with session_timeout", async () => {
    const h = makeHarness();
    const heldCreate = hold<CreateSessionResult>();
    h.sessions.createQueue.push({ hold: heldCreate });
    const pending = h.call(makeDvBody());
    await tick();
    // Anonymous caller: no recordCall; session entry is index 10 (no cache write either).
    const sessionEntry = h.timers.entries[10];
    expect(sessionEntry?.ms).toBe(1_000);
    sessionEntry?.fire();
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).session_ok).toBe("true");
    expect(h.lastLog()).toMatchObject({ outcome: "degraded", reasons: ["session_timeout"] });
    heldCreate.reject(new Error("late failure"));
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"dv"'))).toHaveLength(1);
  });
});

describe("handleDv secrets and forced error", () => {
  it("a missing MCP_TOKEN_KEY answers 500 before anything changes state", async () => {
    const h = makeHarness({ secrets: { MCP_TOKEN_KEY: null } });
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const { status, body } = await h.call(makeDvBody());
    expect(status).toBe(500);
    expect(body).toEqual({ error: "secret_error" });
    expect(h.accounts.recordCalls).toEqual([]);
    expect(h.sessions.creates).toEqual([]);
    expect(h.kv.calls.filter((c) => c.method === "put")).toEqual([]);
    expect(h.lastLog()).toMatchObject({ outcome: "error", reasons: ["secret_error"], status: 500 });
  });

  it("a missing MCP_ENC_KEY answers 500 with no actor call", async () => {
    const h = makeHarness({ secrets: { MCP_ENC_KEY: null } });
    const { status } = await h.call(makeDvBody());
    expect(status).toBe(500);
    expect(h.accounts.recordCalls).toEqual([]);
    expect(h.sessions.creates).toEqual([]);
  });

  it("a token key read that never settles times out into the 500 secret_error, before any actor call", async () => {
    const h = makeHarness();
    const heldRead = h.secrets.hold("MCP_TOKEN_KEY");
    const pending = h.call(makeDvBody());
    await tick();
    // Entries 2 and 3 are the two token key reads; entry 2 (MCP_TOKEN_KEY) is pending.
    expect(h.timers.entries[2]?.ms).toBe(1_000);
    h.timers.entries[2]?.fire();
    const { status, body } = await pending;
    expect(status).toBe(500);
    expect(body).toEqual({ error: "secret_error" });
    expect(h.accounts.recordCalls).toEqual([]);
    expect(h.sessions.creates).toEqual([]);
    heldRead.resolve(TOKEN_KEY_RAW);
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"dv"'))).toHaveLength(1);

    // T22: the late success is kept for the container's life, so the very
    // next call mints its token without reading the secret again.
    const second = await h.call();
    expect(second.status).toBe(200);
    expect(h.secrets.reads.filter((r) => r === "MCP_TOKEN_KEY")).toHaveLength(1);
  });

  it("a public key read that never settles fails the signature check 403 no_key", async () => {
    const h = makeHarness();
    const heldRead = h.secrets.hold("TELNYX_PUBLIC_KEY");
    const pending = h.call(makeDvBody());
    await tick();
    expect(h.timers.entries[0]?.ms).toBe(1_000);
    h.timers.entries[0]?.fire();
    const { status } = await pending;
    expect(status).toBe(403);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", reason: "no_key" });
    expect(h.kv.calls).toEqual([]);
    heldRead.resolve("anything");
    await tick();
  });

  it("dv_force_error answers 500 with no actor call and no cache write (test path E)", async () => {
    const h = makeHarness({ flagsDoc: { dv_force_error: true } });
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const { status, body } = await h.call(makeDvBody());
    expect(status).toBe(500);
    expect(body).toEqual({ error: "dv_force_error" });
    expect(h.accounts.recordCalls).toEqual([]);
    expect(h.sessions.creates).toEqual([]);
    expect(h.kv.calls.filter((c) => c.method === "put")).toEqual([]);
    expect(h.lastLog()).toMatchObject({ outcome: "error", reasons: ["dv_force_error"], status: 500 });
  });
});

// ---------- areas ----------

describe("handleDv areas", () => {
  const OUTAGE = {
    state: "outage",
    incidentId: "INC-8630-202610101412",
    eta: "by 18:00 today",
    version: 3,
    updatedAt: T0 - 60_000,
  };

  it("a caller in an outage area hears area_outage true with the outage_eta", async () => {
    const h = makeHarness({ areaDocs: { "8630": OUTAGE } });
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const { status, body } = await h.call(makeDvBody());
    expect(status).toBe(200);
    expect(body.dynamic_variables).toMatchObject({
      area_code: "8630",
      area_name: "Veurne",
      area_outage: "true",
      outage_eta: "by 18:00 today",
    });
    expect(h.lastLog()).toMatchObject({ area: "8630", area_outage: "true", outcome: "ok" });
  });

  it("an outage in another area does not flag the caller's", async () => {
    const h = makeHarness({ areaDocs: { "8620": OUTAGE } });
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const { body } = await h.call(makeDvBody());
    expect((body.dynamic_variables as Record<string, string>).area_outage).toBe("false");
  });

  it("an area read that settles at exactly 2,000 ms (the T22 bound) is used for the caller's outage notice", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const heldGet = hold<unknown>();
    const inner = h.deps.kv;
    h.deps.kv = {
      get: ((key: unknown, options: unknown) =>
        key === kvKeys.areaStatus("8630")
          ? heldGet.promise
          : (inner.get as (k: never, o: never) => Promise<unknown>)(key as never, options as never)),
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    } as unknown as KvFake;

    const pending = h.call(makeDvBody());
    await tick();
    // The held read is the only pending 2,000 ms entry.
    const areaEntry = h.timers.pending().find((e) => e.ms === 2_000);
    expect(areaEntry).toBeDefined();
    h.clock.advance(2_000);
    heldGet.resolve(OUTAGE);
    const { status, body } = await pending;

    expect(status).toBe(200);
    expect(areaEntry?.fired).toBe(false);
    expect(body.dynamic_variables).toMatchObject({
      area_outage: "true",
      outage_eta: "by 18:00 today",
    });
    expect(h.lastLog()).toMatchObject({ area_outage: "true", outcome: "ok", reasons: [] });
  });

  it("an area read settling at 2,001 ms times out: area_outage false with area_unknown, and the late answer is absorbed", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const heldGet = hold<unknown>();
    const inner = h.deps.kv;
    h.deps.kv = {
      get: ((key: unknown, options: unknown) =>
        key === kvKeys.areaStatus("8630")
          ? heldGet.promise
          : (inner.get as (k: never, o: never) => Promise<unknown>)(key as never, options as never)),
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    } as unknown as KvFake;

    const pending = h.call(makeDvBody());
    await tick();
    const areaEntry = h.timers.pending().find((e) => e.ms === 2_000);
    expect(areaEntry).toBeDefined();
    h.clock.advance(2_001);
    areaEntry?.fire();
    const { status, body } = await pending;

    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).area_outage).toBe("false");
    expect(h.lastLog()).toMatchObject({
      outcome: "degraded",
      reasons: ["area_unknown"],
      area_outage: "false",
    });

    // The late answer is absorbed: not cached, and the next call reads the
    // area again.
    heldGet.resolve(OUTAGE);
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"dv"'))).toHaveLength(1);
    h.deps.kv = h.kv;
    h.kv.reset();
    await h.call(makeDvBody());
    const areaGets = h.kv.calls.filter((c) => c.method === "get" && c.key?.startsWith("area/"));
    expect(areaGets.map((c) => c.key)).toEqual([kvKeys.areaStatus("8630")]);
  });

  it("a failed read of the caller's own area answers area_outage false, degraded with area_unknown", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const heldGet = hold<unknown>();
    const inner = h.deps.kv;
    h.deps.kv = {
      get: ((key: unknown, options: unknown) =>
        key === kvKeys.areaStatus("8630")
          ? heldGet.promise
          : (inner.get as (k: never, o: never) => Promise<unknown>)(key as never, options as never)),
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    } as unknown as KvFake;

    const pending = h.call(makeDvBody());
    await tick();
    h.timers.fireAllPending();
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).area_outage).toBe("false");
    expect(h.lastLog()).toMatchObject({
      outcome: "degraded",
      reasons: ["area_unknown"],
      area_outage: "false",
    });
    // Not cached: the next request reads that area again while others are cached.
    heldGet.resolve(null);
    h.deps.kv = h.kv;
    h.kv.reset();
    await h.call(makeDvBody());
    const areaGets = h.kv.calls.filter((c) => c.method === "get" && c.key?.startsWith("area/"));
    expect(areaGets.map((c) => c.key)).toEqual([kvKeys.areaStatus("8630")]);
  });

  it("a customer outside the five postcodes gets area_outage false with no degraded reason", async () => {
    const h = makeHarness();
    h.crm.defaultResult = {
      ok: true,
      answer: { kind: "customer", customer: { ...CUSTOMER, postcode: "9000", areaName: "Gent" } },
    };
    const { status, body } = await h.call(makeDvBody());
    expect(status).toBe(200);
    expect(body.dynamic_variables).toMatchObject({ area_code: "9000", area_outage: "false" });
    expect(h.lastLog()).toMatchObject({ outcome: "ok", reasons: [], area_outage: "false" });
  });
});

// ---------- memory caches ----------

describe("handleDv memory caches", () => {
  function seededCustomer(h: Harness): void {
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
  }

  it("a second request within 10 s reads neither the flags nor the area statuses from KV again", async () => {
    const h = makeHarness({ flagsDoc: { diagnostics_enabled: false } });
    seededCustomer(h);
    await h.call(makeDvBody());
    expect(h.kv.calls.filter((c) => c.method === "get").map((c) => c.key)).toContain(
      kvKeys.flags(),
    );

    h.kv.reset();
    const { body } = await h.call();
    expect((body.dynamic_variables as Record<string, string>).diagnostics_enabled).toBe("false");
    const reads = h.kv.calls.filter((c) => c.method === "get");
    expect(reads).toEqual([]);
    expect(h.crm.calls).toHaveLength(1);

    // 9,999 ms later the caches still hold; at exactly 10,000 ms they are re-read.
    h.clock.advance(9_999);
    h.kv.reset();
    await h.call();
    expect(h.kv.calls.filter((c) => c.method === "get")).toEqual([]);

    h.clock.advance(1);
    h.kv.reset();
    await h.call();
    const reread = h.kv.calls.filter((c) => c.method === "get").map((c) => c.key);
    expect(reread).toContain(kvKeys.flags());
    for (const area of ["8620", "8630", "8660", "8670", "8600"]) {
      expect(reread).toContain(kvKeys.areaStatus(area));
    }
  });

  it("a caller looked up within 60 s comes from memory with no KV read and no mock-crm call, and re-reads at 60 s", async () => {
    const h = makeHarness();
    seededCustomer(h);
    await h.call(makeDvBody());
    expect(h.lastLog().cache).toBe("miss");

    // Well within 60 s (but past the 10 s flag/area caches with a jump): the
    // caller comes from memory whatever else is re-read.
    h.kv.reset();
    h.crm.calls.length = 0;
    h.clock.advance(20_000);
    await h.call();
    expect(h.lastLog().cache).toBe("memory");
    expect(h.crm.calls).toEqual([]);
    expect(h.kv.calls.some((c) => c.key?.startsWith("crm/"))).toBe(false);

    // 59,999 ms after the lookup the memory entry is still good; at exactly
    // 60,000 ms it expired. The re-read is won by the KV copy written on the
    // first call (mock-crm is still called, but its answer loses the race,
    // and nothing is written back).
    h.clock.advance(39_999);
    h.kv.reset();
    await h.call();
    expect(h.lastLog().cache).toBe("memory");
    expect(h.crm.calls).toEqual([]);

    h.clock.advance(1);
    h.kv.reset();
    await h.call();
    expect(h.lastLog().cache).toBe("kv");
    expect(h.kv.calls.some((c) => c.method === "get" && c.key === kvKeys.crmPhone(CALLER_DIGITS))).toBe(true);
    expect(h.kv.calls.filter((c) => c.method === "put")).toEqual([]);
  });

  it("a flags read the wait gave up on stays shared, and dv_force_error from its late success applies to the next call (T20)", async () => {
    const h = makeHarness();
    seededCustomer(h);
    const heldFlags = hold<unknown>();
    wrapFlagsKv(h, heldFlags.promise);

    // First /dv: the flags wait gives up; the defaults answer the call.
    const pending = h.call(makeDvBody());
    await tick();
    expect(h.timers.entries[1]?.ms).toBe(1_000);
    h.timers.entries[1]?.fire();
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).diagnostics_enabled).toBe("true");

    // The read is still in flight: the next /dv joins it instead of
    // reading KV again, and its late answer applies at once.
    const second = h.call();
    await tick();
    heldFlags.resolve({ dv_force_error: true });
    const secondRes = await second;
    expect(secondRes.status).toBe(500);
    expect(secondRes.body).toEqual({ error: "dv_force_error" });
    expect(flagsGets(h)).toBe(1);
  });

  it("a /dv with a last good flags value does not wait for KV, also while the refresh it started never settles (T20)", async () => {
    const h = makeHarness({ flagsDoc: { diagnostics_enabled: false } });
    seededCustomer(h);
    const first = await h.call(makeDvBody());
    expect((first.body.dynamic_variables as Record<string, string>).diagnostics_enabled).toBe("false");
    expect(flagsGets(h)).toBe(1);

    // Exactly one lifetime later the value is stale: the next /dv starts a
    // background refresh (held forever here) but answers at once from the
    // last good value, without any wait.
    const heldRefresh = hold<unknown>();
    wrapFlagsKv(h, heldRefresh.promise);
    h.clock.advance(10_000);
    const { status, body } = await h.call();
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).diagnostics_enabled).toBe("false");
    expect(flagsGets(h)).toBe(2);

    // The never-settling refresh keeps costing nothing: another /dv behind
    // it answers at once too, and starts no further read.
    h.clock.advance(5_000);
    const again = await h.call();
    expect(again.status).toBe(200);
    expect(flagsGets(h)).toBe(2);
  });

  it("the first /dv still gives its flags wait the card's 1,000 ms bound, cut against the soft budget (T20)", async () => {
    // The flags wait opens as the first step inside the 3,000 ms soft
    // budget, so its cut to what remains is the card's own 1,000 ms — as
    // before. (The cut mechanism itself is pinned by the soft-budget
    // describe below, where later calls get only what remains.)
    const h = makeHarness();
    const heldFlags = hold<unknown>();
    wrapFlagsKv(h, heldFlags.promise);

    const pending = h.call(makeDvBody());
    await tick();
    const flagsEntry = h.timers.entries[1];
    expect(flagsEntry?.ms).toBe(1_000);
    flagsEntry?.fire();
    const { status } = await pending;
    expect(status).toBe(200);
    heldFlags.resolve(null);
    await tick();
  });

  it("writes one flags_read line per settled flags read, and none while no read has run (T20)", async () => {
    const h = makeHarness({ flagsDoc: { diagnostics_enabled: false } });
    // No call yet: no read ever ran.
    expect(flagsReadLines(h)).toEqual([]);

    seededCustomer(h);
    await h.call(makeDvBody());
    expect(flagsReadLines(h)).toHaveLength(1);
    expect(flagsReadLines(h)[0]).toMatchObject({
      svc: "voice-context",
      event: "flags_read",
      outcome: "ok",
    });
    const latency = flagsReadLines(h)[0]?.latency_ms as Record<string, unknown>;
    expect(typeof latency.total).toBe("number");
    expect(latency.kv).toBe(latency.total);

    // Within the lifetime there is no new read, so no new line.
    await h.call();
    expect(flagsReadLines(h)).toHaveLength(1);
  });
});

// ---------- soft budget ----------

describe("handleDv soft budget", () => {
  it("cuts each late call's timeout to what remains of the 3,000 ms and answers with what is known", async () => {
    const h = makeHarness();
    // Everything hangs: the flags read, the CRM race (KV miss + held crm),
    // SESSION.create. Areas answer normally.
    const heldFlags = hold<unknown>();
    const heldCrm = hold<CrmCallResult>();
    const heldCreate = hold<CreateSessionResult>();
    const inner = h.deps.kv;
    h.deps.kv = {
      get: ((key: unknown, options: unknown) =>
        key === kvKeys.flags()
          ? heldFlags.promise
          : (inner.get as (k: never, o: never) => Promise<unknown>)(key as never, options as never)),
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    } as unknown as KvFake;
    h.crm.queue.push({ hold: heldCrm });
    h.sessions.createQueue.push({ hold: heldCreate });

    const pending = h.call(makeDvBody());
    await tick();

    // 2,800 ms into the budget the flags read gives up; 200 ms remain.
    h.clock.advance(2_800);
    h.timers.entries[1]?.fire();
    await tick();
    h.timers.entries[4]?.fire();
    await tick();

    // SESSION.create starts with only 200 ms left of the budget.
    const sessionEntry = h.timers.entries[10];
    expect(sessionEntry?.ms).toBe(200);
    sessionEntry?.fire();
    const { status, body } = await pending;

    expect(status).toBe(200);
    expect(body.dynamic_variables).toMatchObject({
      session_ok: "true",
      identity_level: "anonymous",
      greeting_line: "Hello",
    });
    expect(h.lastLog()).toMatchObject({
      outcome: "degraded",
      reasons: expect.arrayContaining(["crm_timeout", "session_timeout"]),
      cache: "miss",
    });

    // Late settlements change nothing and are never unhandled.
    heldFlags.resolve(null);
    heldCrm.resolve({ ok: true, answer: { kind: "customer", customer: CUSTOMER } });
    heldCreate.resolve(createdForLateSettle);
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"dv"'))).toHaveLength(1);
  });

  it("a cache write that times out is reported as cache_write failed, and a late resolution does not flip it", async () => {
    const h = makeHarness();
    h.crm.defaultResult = { ok: true, answer: { kind: "customer", customer: CUSTOMER } };
    const heldPut = hold<void>();
    const inner = h.deps.kv;
    h.deps.kv = {
      get: inner.get.bind(inner) as never,
      put: ((key: unknown, value: unknown, options: unknown) =>
        key === kvKeys.crmPhone(CALLER_DIGITS)
          ? heldPut.promise
          : (inner.put as (k: never, v: never, o: never) => Promise<void>)(
              key as never,
              value as never,
              options as never,
            )) as never,
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    } as unknown as KvFake;

    const pending = h.call(makeDvBody());
    await tick();
    // Entry 12 is the cache write (recordCall 10, session 11, write 12).
    const writeEntry = h.timers.entries[12];
    expect(writeEntry?.ms).toBe(2_500);
    writeEntry?.fire();
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect((body.dynamic_variables as Record<string, string>).first_name).toBe("Marie");
    expect(h.lastLog()).toMatchObject({
      outcome: "ok",
      reasons: [],
      cache: "miss",
      cache_write: "failed",
    });

    heldPut.resolve(undefined);
    await tick();
    expect(h.lines.filter((l) => l.includes('"event":"dv"'))).toHaveLength(1);
  });
});

const createdForLateSettle: CreateSessionResult = {
  created: true,
  session: {
    v: 1,
    sid: SID,
    traceId: CALL_CONTROL_ID,
    identity: "anonymous",
    accountNumber: null,
    postcode: null,
    lineId: null,
    callerPhone: CALLER,
    createdAt: T0,
    expiresAt: T0 + 7_200_000,
    disclosedAt: null,
    verify: { failures: 0, lockedUntil: null },
  },
};
