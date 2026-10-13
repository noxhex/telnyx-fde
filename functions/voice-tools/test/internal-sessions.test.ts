import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createLogger,
  createMemoryCache,
  parseKey,
  verifySessionToken,
} from "@duinvezel/shared";
import type {
  CreateSessionInput,
  CreateSessionResult,
  SessionDoc,
  SetVerifiedResult,
  VerifyFailureResult,
} from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import type { ClockFake } from "../../../packages/shared/test/fakes/clock.js";

import type { AccountsClient } from "../src/clients/accounts.js";
import type { AreasClient } from "../src/clients/areas.js";
import type { CrmClient } from "../src/clients/crm.js";
import type { SessionsClient } from "../src/clients/sessions.js";
import { TIMED_OUT } from "../src/config.js";
import type { TimeoutRunner } from "../src/config.js";
import type { CachesDep, SecretsDep, VoiceToolsDeps } from "../src/deps.js";
import { handleInternalSessions } from "../src/routes/internal-sessions.js";

// ---------- shared constants (keys generated per run, never committed) ----------

const T0 = 1_600_000_000_000;
const TOKEN_KEY_RAW = randomBytes(32).toString("base64url");
const TOKEN_KEY = parseKey(TOKEN_KEY_RAW);
const INTERNAL_KEY = randomBytes(16).toString("hex");
const OTHER_INTERNAL_KEY = randomBytes(16).toString("hex");
/** Pinned randomness: 16 bytes, so the sid is 32 lowercase hex characters. */
const PINNED_SID = (() => {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = 0xa0 + i;
  }
  return Buffer.from(bytes).toString("hex");
})();

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

/** A TimeoutRunner whose timers only fire when the test says so; fns start immediately. Late settlements are handled no-ops. */
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
}

// ---------- stubs ----------

class SessionsStub implements SessionsClient {
  readonly creates: { sid: string; input: CreateSessionInput }[] = [];
  heldCreate: HeldPromise<CreateSessionResult> | null = null;
  failCreate: Error | null = null;

  create(sid: string, input: CreateSessionInput): Promise<CreateSessionResult> {
    this.creates.push({ sid, input });
    if (this.heldCreate !== null) {
      return this.heldCreate.promise;
    }
    if (this.failCreate !== null) {
      return Promise.reject(this.failCreate);
    }
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
      expiresAt: input.nowMs + (input.ttlMs ?? 7_200_000),
      disclosedAt: null,
      verify: { failures: 0, lockedUntil: null },
    };
    return Promise.resolve({ created: true, session });
  }

  get(_sid: string, _input: { nowMs: number }): Promise<SessionDoc | null> {
    throw new Error("unexpected SESSION.get");
  }

  setVerified(): Promise<SetVerifiedResult> {
    throw new Error("unexpected SESSION.setVerified");
  }

  recordVerifyFailure(): Promise<VerifyFailureResult> {
    throw new Error("unexpected SESSION.recordVerifyFailure");
  }
}

/** The internal-sessions route never reaches these; any call is a bug. */
const accountsNever: AccountsClient = {
  verify: () => Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.verify")),
  createTicket: () => Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.createTicket")),
  reset: () => Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.reset")),
};

const areasNever: AreasClient = {
  report: () => Promise.reject(new Error("unexpected AREA_INCIDENT.report")),
  reset: () => Promise.reject(new Error("unexpected AREA_INCIDENT.reset")),
};

class SecretsStub implements SecretsDep {
  readonly reads: string[] = [];
  readonly held = new Map<string, HeldPromise<string | null>>();

  constructor(readonly values: Record<string, string | null>) {}

  hold(handle: string): HeldPromise<string | null> {
    const held = hold<string | null>();
    this.held.set(handle, held);
    return held;
  }

  get(handle: string): Promise<string | null> {
    this.reads.push(handle);
    return this.held.get(handle)?.promise ?? Promise.resolve(this.values[handle] ?? null);
  }

  getKey(handle: string): Promise<Uint8Array | null> {
    this.reads.push(handle);
    const raw = this.values[handle];
    if (raw === undefined || raw === null) {
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(parseKey(raw));
    } catch {
      return Promise.resolve(null);
    }
  }
}

// ---------- harness ----------

interface Harness {
  deps: VoiceToolsDeps;
  clock: ClockFake;
  timers: ManualTimers;
  sessions: SessionsStub;
  secrets: SecretsStub;
  lines: string[];
  post(options: {
    key?: string | null;
    body?: string;
  }): Promise<{ status: number; body: unknown }>;
  lastLog(): Record<string, unknown>;
}

const DEFAULT_BODY = JSON.stringify({ identity: "anonymous" });

function makeHarness(secretValues: Record<string, string | null> = {}): Harness {
  const clock = createClockFake(T0);
  const timers = new ManualTimers();
  const sessions = new SessionsStub();
  const secrets = new SecretsStub({
    INTERNAL_KEY,
    MCP_TOKEN_KEY: TOKEN_KEY_RAW,
    ...secretValues,
  });
  const lines: string[] = [];
  const caches: CachesDep = {
    areas: createMemoryCache(10_000, clock.now),
  };
  const log = createLogger(
    "voice-tools",
    (line) => {
      lines.push(line);
    },
    clock.now,
  );
  const crm: CrmClient = {
    testLine: () => Promise.resolve({ ok: false }),
    getAccount: () => Promise.reject(new Error("unexpected mock-crm GET /accounts")),
  };
  const pinnedSidBytes = new Uint8Array(Buffer.from(PINNED_SID, "hex"));
  const deps: VoiceToolsDeps = {
    now: clock.now,
    kv: undefined,
    sessions,
    crm,
    accounts: accountsNever,
    areas: areasNever,
    caches,
    flagsValue: undefined, // no KV in this harness, so the flag defaults would apply
    secrets,
    log,
    random: () => pinnedSidBytes,
    timeout: timers.runner,
  };
  return {
    deps,
    clock,
    timers,
    sessions,
    secrets,
    lines,
    async post({ key = INTERNAL_KEY, body = DEFAULT_BODY }) {
      const headers = new Headers({ "content-type": "application/json" });
      if (key !== null) {
        headers.set("x-internal-key", key);
      }
      const res = await handleInternalSessions(
        new Request("http://x.test/internal/sessions", { method: "POST", headers, body }),
        deps,
      );
      return { status: res.status, body: await res.json() };
    },
    lastLog() {
      if (lines.length === 0) {
        throw new Error("no log lines captured");
      }
      return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    },
  };
}

// ---------- auth ----------

describe("POST /internal/sessions auth", () => {
  it("no key: 401 before any actor call or token-key read", async () => {
    const h = makeHarness();
    const res = await h.post({ key: null });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(h.sessions.creates).toEqual([]);
    expect(h.secrets.reads).toEqual(["INTERNAL_KEY"]);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", route: "internal_sessions", reason: "bad_key", status: 401 });
  });

  it("a wrong key: 401 before any actor call", async () => {
    const h = makeHarness();
    const res = await h.post({ key: OTHER_INTERNAL_KEY });
    expect(res.status).toBe(401);
    expect(h.sessions.creates).toEqual([]);
  });

  it("a wrong key with an invalid body: still 401, auth before anything else", async () => {
    const h = makeHarness();
    const res = await h.post({ key: OTHER_INTERNAL_KEY, body: "{broken" });
    expect(res.status).toBe(401);
    expect(h.sessions.creates).toEqual([]);
  });

  it("an unreadable INTERNAL_KEY fails closed: 401 no_key", async () => {
    const h = makeHarness({ INTERNAL_KEY: null });
    const res = await h.post({});
    expect(res.status).toBe(401);
    expect(h.sessions.creates).toEqual([]);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", reason: "no_key", status: 401 });
  });
});

// ---------- validation ----------

describe("POST /internal/sessions validation", () => {
  it("a body that is not valid JSON answers 400", async () => {
    const h = makeHarness();
    const res = await h.post({ body: "{broken" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad_request" });
    expect(h.sessions.creates).toEqual([]);
  });

  it("a missing identity answers 400", async () => {
    const h = makeHarness();
    const res = await h.post({ body: JSON.stringify({ accountNumber: "DV-100002" }) });
    expect(res.status).toBe(400);
    expect(h.sessions.creates).toEqual([]);
  });

  it("identity verified is not allowed to be minted by hand: 400", async () => {
    const h = makeHarness();
    const res = await h.post({ body: JSON.stringify({ identity: "verified" }) });
    expect(res.status).toBe(400);
    expect(h.sessions.creates).toEqual([]);
  });

  it("a non-string optional field answers 400", async () => {
    const h = makeHarness();
    const res = await h.post({ body: JSON.stringify({ identity: "attested", postcode: 8630 }) });
    expect(res.status).toBe(400);
    expect(h.sessions.creates).toEqual([]);
  });
});

// ---------- the happy path ----------

describe("POST /internal/sessions happy path", () => {
  it("a valid body creates the session on the pinned random sid with traceId internal-<sid>", async () => {
    const h = makeHarness();
    const res = await h.post({ body: JSON.stringify({ identity: "attested", accountNumber: "DV-100002", postcode: "8630", lineId: "LN-000002", callerPhone: "+32491244713" }) });
    expect(res.status).toBe(200);
    expect(PINNED_SID).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body).toMatchObject({ sid: PINNED_SID });
    expect(h.sessions.creates).toHaveLength(1);
    expect(h.sessions.creates[0]).toEqual({
      sid: PINNED_SID,
      input: {
        traceId: `internal-${PINNED_SID}`,
        identity: "attested",
        accountNumber: "DV-100002",
        postcode: "8630",
        lineId: "LN-000002",
        callerPhone: "+32491244713",
        nowMs: T0,
      },
    });
    expect(h.lastLog()).toMatchObject({
      event: "internal_sessions",
      outcome: "ok",
      status: 200,
      trace_id: `internal-${PINNED_SID}`,
    });
  });

  it("all optional fields omitted create a bare session of the given identity", async () => {
    const h = makeHarness();
    const res = await h.post({ body: JSON.stringify({ identity: "number_match" }) });
    expect(res.status).toBe(200);
    expect(h.sessions.creates[0]?.input).toEqual({
      traceId: `internal-${PINNED_SID}`,
      identity: "number_match",
      nowMs: T0,
    });
  });

  it("the returned token verifies under MCP_TOKEN_KEY for the sid, expiring two hours ahead", async () => {
    const h = makeHarness();
    const res = await h.post({ body: JSON.stringify({ identity: "anonymous" }) });
    expect(res.status).toBe(200);
    const token = (res.body as { token: string }).token;
    const check = verifySessionToken(token, TOKEN_KEY, T0);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.claims.sid).toBe(PINNED_SID);
      expect(check.claims.exp - T0).toBe(2 * 60 * 60 * 1000);
    }
    // The token is still good one millisecond before its expiry and dead at it.
    expect(verifySessionToken(token, TOKEN_KEY, T0 + 7_200_000 - 1).ok).toBe(true);
    expect(verifySessionToken(token, TOKEN_KEY, T0 + 7_200_000).ok).toBe(false);
  });
});

// ---------- failures ----------

describe("POST /internal/sessions failures", () => {
  const UNAVAILABLE = { error: "unavailable" };

  it("an unreadable MCP_TOKEN_KEY answers 503 before any actor call, with a plain error body", async () => {
    const h = makeHarness({ MCP_TOKEN_KEY: null });
    const res = await h.post({});
    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);
    expect(h.sessions.creates).toEqual([]);
    expect(h.lastLog()).toMatchObject({ event: "internal_sessions", outcome: "secret_error", status: 503 });
  });

  it("a failing SESSION.create answers 503 with a plain error body and the trace id", async () => {
    const h = makeHarness();
    h.sessions.failCreate = new Error("actor sidecar down");
    const res = await h.post({});
    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);
    expect(h.lastLog()).toMatchObject({
      event: "internal_sessions",
      outcome: "session_error",
      status: 503,
      trace_id: `internal-${PINNED_SID}`,
    });
  });

  it("a held SESSION.create times out at exactly 1,000 ms: 503 with a plain error body, and the late answer is absorbed", async () => {
    const h = makeHarness();
    h.sessions.heldCreate = hold<CreateSessionResult>();
    const pending = h.post({});
    await tick();
    // The key reads settled; the pending timer is the 1,000 ms session create.
    const createTimer = h.timers.pending().find((e) => e.ms === 1_000);
    expect(createTimer).toBeDefined();
    createTimer?.fire();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);
    expect(h.sessions.creates).toHaveLength(1);
    expect(h.lastLog()).toMatchObject({
      event: "internal_sessions",
      outcome: "session_unavailable",
      status: 503,
      trace_id: `internal-${PINNED_SID}`,
    });
    // The create answers after the timeout fired: absorbed quietly.
    h.sessions.heldCreate.resolve({
      created: true,
      session: {} as SessionDoc,
    });
    await tick();
  });
});
