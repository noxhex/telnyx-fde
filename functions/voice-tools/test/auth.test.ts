import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createLogger, createMemoryCache, mintSessionToken, parseKey } from "@duinvezel/shared";
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
import { handleMcp } from "../src/routes/mcp.js";

// ---------- shared constants (keys generated per run, never committed) ----------

const T0 = 1_600_000_000_000;
const TOKEN_KEY_RAW = randomBytes(32).toString("base64url");
const TOKEN_KEY = parseKey(TOKEN_KEY_RAW);
const OTHER_KEY = parseKey(randomBytes(32).toString("base64url"));
const SID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function liveSession(now: number): SessionDoc {
  return {
    v: 1,
    sid: SID,
    traceId: "trace-auth",
    identity: "attested",
    accountNumber: "DV-100002",
    postcode: "8630",
    lineId: "LN-000002",
    callerPhone: "+3258000110",
    createdAt: now,
    expiresAt: now + 7_200_000,
    disclosedAt: null,
    verify: { failures: 0, lockedUntil: null },
  };
}

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

/** Mirrors the actor's contract: get answers null for a missing or an expired session. */
class SessionsStub implements SessionsClient {
  readonly gets: string[] = [];
  doc: SessionDoc | null = null;
  heldGet: HeldPromise<SessionDoc | null> | null = null;
  failGet: Error | null = null;

  create(_sid: string, input: CreateSessionInput): Promise<CreateSessionResult> {
    throw new Error(`unexpected SESSION.create (${input.traceId})`);
  }

  get(sid: string, input: { nowMs: number }): Promise<SessionDoc | null> {
    this.gets.push(sid);
    if (this.heldGet !== null) {
      return this.heldGet.promise;
    }
    if (this.failGet !== null) {
      return Promise.reject(this.failGet);
    }
    const doc = this.doc;
    return Promise.resolve(doc !== null && input.nowMs < doc.expiresAt ? doc : null);
  }

  holdGet(): HeldPromise<SessionDoc | null> {
    this.heldGet = hold<SessionDoc | null>();
    return this.heldGet;
  }

  setVerified(): Promise<SetVerifiedResult> {
    throw new Error("unexpected SESSION.setVerified");
  }

  recordVerifyFailure(): Promise<VerifyFailureResult> {
    throw new Error("unexpected SESSION.recordVerifyFailure");
  }
}

/** Auth tests never reach a tool; any state-changing actor call is a bug. */
const accountsNever: AccountsClient = {
  verify: () => Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.verify")),
  createTicket: () => Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.createTicket")),
  reset: () => Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.reset")),
};

const areasNever: AreasClient = {
  report: () => Promise.reject(new Error("unexpected AREA_INCIDENT.report")),
  reset: () => Promise.reject(new Error("unexpected AREA_INCIDENT.reset")),
};

/** The stub's one key-parsing path, shared by immediate and held reads. */
function parseHeldKey(raw: string | null | undefined): Uint8Array | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  try {
    return parseKey(raw);
  } catch {
    return null;
  }
}

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
    // A held read resolves with whatever the test settles it with: the same
    // parsing as an immediate value, so a read that lands inside its bound
    // authenticates and a late read can deliver a real key.
    const heldRead = this.held.get(handle);
    if (heldRead !== undefined) {
      return heldRead.promise.then((raw) => parseHeldKey(raw));
    }
    return Promise.resolve(parseHeldKey(this.values[handle]));
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
  validToken: string;
  post(options: {
    authorization?: string | null;
    body?: string;
  }): Promise<{ status: number; body: unknown }>;
  lastLog(): Record<string, unknown>;
}

const VALID_BODY = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" });

function makeHarness(secretValues: Record<string, string | null> = {}): Harness {
  const clock = createClockFake(T0);
  const timers = new ManualTimers();
  const sessions = new SessionsStub();
  sessions.doc = liveSession(T0);
  const secrets = new SecretsStub({ MCP_TOKEN_KEY: TOKEN_KEY_RAW, ...secretValues });
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
    random: (n) => randomBytes(n),
    timeout: timers.runner,
  };
  const validToken = mintSessionToken({ sid: SID, exp: T0 + 7_200_000 }, TOKEN_KEY);
  return {
    deps,
    clock,
    timers,
    sessions,
    secrets,
    lines,
    validToken,
    async post({ authorization = `Bearer ${validToken}`, body = VALID_BODY }) {
      const headers = new Headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "auth-test-agent",
      });
      if (authorization !== null) {
        headers.set("authorization", authorization);
      }
      const res = await handleMcp(
        new Request("http://x.test/mcp", { method: "POST", headers, body }),
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

const UNAUTHORIZED = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32000, message: "unauthorized" },
};

const UNAVAILABLE = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32000, message: "service unavailable" },
};

// ---------- 401s ----------

describe("POST /mcp auth, 401s", () => {
  it("no request is exempt: initialize without a token answers 401 with no secret read and no session read", async () => {
    const h = makeHarness();
    const res = await h.post({
      authorization: null,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
    expect(h.secrets.reads).toEqual([]);
    expect(h.sessions.gets).toEqual([]);
  });

  it("no request is exempt: notifications/initialized without a token answers 401 the same way", async () => {
    const h = makeHarness();
    const res = await h.post({
      authorization: null,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(401);
    expect(h.secrets.reads).toEqual([]);
    expect(h.sessions.gets).toEqual([]);
  });

  it("a bare token without the Bearer scheme answers 401 with no reads at all", async () => {
    const h = makeHarness();
    const res = await h.post({ authorization: h.validToken });
    expect(res.status).toBe(401);
    expect(h.secrets.reads).toEqual([]);
    expect(h.sessions.gets).toEqual([]);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", reason: "missing_token", status: 401 });
  });

  it("a 401 never reads the request body", async () => {
    const h = makeHarness();
    const req = new Request("http://x.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    const res = await handleMcp(req, h.deps);
    expect(res.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
  });

  it("no Authorization header: 401 missing_token, no secret read, no session read", async () => {
    const h = makeHarness();
    const res = await h.post({ authorization: null });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
    expect(h.secrets.reads).toEqual([]);
    expect(h.sessions.gets).toEqual([]);
    expect(h.lastLog()).toMatchObject({
      level: "warn",
      event: "auth_failed",
      route: "mcp",
      reason: "missing_token",
      user_agent: "auth-test-agent",
      status: 401,
    });
  });

  it("a non-Bearer scheme: 401 missing_token with no reads at all", async () => {
    const h = makeHarness();
    const res = await h.post({ authorization: "Token abc" });
    expect(res.status).toBe(401);
    expect(h.secrets.reads).toEqual([]);
    expect(h.sessions.gets).toEqual([]);
  });

  it("a malformed token: 401, key read but no session read", async () => {
    const h = makeHarness();
    const res = await h.post({ authorization: "Bearer not-a-token" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
    expect(h.sessions.gets).toEqual([]);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", reason: "malformed", status: 401 });
  });

  it("a token under the wrong key: 401 bad_signature, no session read", async () => {
    const h = makeHarness();
    const forged = mintSessionToken({ sid: SID, exp: T0 + 7_200_000 }, OTHER_KEY);
    const res = await h.post({ authorization: `Bearer ${forged}` });
    expect(res.status).toBe(401);
    expect(h.sessions.gets).toEqual([]);
    expect(h.lastLog()).toMatchObject({
      event: "auth_failed",
      reason: "bad_signature",
      status: 401,
    });
  });

  it("an expired token: 401 expired, no session read", async () => {
    const h = makeHarness();
    // Boundary: exp at exactly now is expired (live means now < exp).
    const expired = mintSessionToken({ sid: SID, exp: T0 }, TOKEN_KEY);
    const res = await h.post({ authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    expect(h.sessions.gets).toEqual([]);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", reason: "expired", status: 401 });
  });

  it("a missing session: 401 after exactly one session read", async () => {
    const h = makeHarness();
    h.sessions.doc = null;
    const res = await h.post({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
    expect(h.sessions.gets).toEqual([SID]);
    expect(h.lastLog()).toMatchObject({
      event: "auth_failed",
      reason: "session_missing",
      status: 401,
    });
  });

  it("an expired session: 401 after exactly one session read", async () => {
    const h = makeHarness();
    // Boundary: expiresAt equal to now is expired (live means now < expiresAt).
    const expiredDoc = liveSession(T0);
    expiredDoc.expiresAt = T0;
    h.sessions.doc = expiredDoc;
    const res = await h.post({});
    expect(res.status).toBe(401);
    expect(h.sessions.gets).toEqual([SID]);
    expect(h.lastLog()).toMatchObject({
      event: "auth_failed",
      reason: "session_missing",
      status: 401,
    });
  });
});

// ---------- 503s ----------

describe("POST /mcp auth, 503s", () => {
  it("an unreadable MCP_TOKEN_KEY: 503 secret_error, no session read", async () => {
    const h = makeHarness({ MCP_TOKEN_KEY: null });
    const res = await h.post({});
    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);
    expect(h.sessions.gets).toEqual([]);
    expect(h.lastLog()).toMatchObject({
      event: "auth_failed",
      reason: "secret_error",
      status: 503,
    });
  });

  it("an MCP_TOKEN_KEY that is not a valid key: 503 secret_error", async () => {
    const h = makeHarness({ MCP_TOKEN_KEY: "!!not base64url!!" });
    const res = await h.post({});
    expect(res.status).toBe(503);
    expect(h.sessions.gets).toEqual([]);
  });

  it("a held MCP_TOKEN_KEY read times out at the 2,000 ms bound: 503 secret_error, and the late key changes nothing (T26)", async () => {
    const h = makeHarness();
    const heldKey = h.secrets.hold("MCP_TOKEN_KEY");
    const pending = h.post({});
    await tick();
    // Exactly one timer, for the card's 2,000 ms secret-read timeout.
    const timer = h.timers.pending().find((e) => e.ms === 2_000);
    expect(timer).toBeDefined();
    expect(h.sessions.gets).toEqual([]);
    timer?.fire();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);
    expect(h.sessions.gets).toEqual([]);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", reason: "secret_error", status: 503 });
    // A valid key arriving after the timeout fired changes nothing: the
    // request already answered 503 and no session is ever read.
    heldKey.resolve(TOKEN_KEY_RAW);
    await tick();
    expect(h.sessions.gets).toEqual([]);
  });

  it("a token key read that settles at the 2,000 ms bound authenticates (T26)", async () => {
    const h = makeHarness();
    const heldKey = h.secrets.hold("MCP_TOKEN_KEY");
    const pending = h.post({});
    await tick();
    // The 2,000 ms timer exists but has not fired: a read landing now is at
    // its bound, inside it, and auth proceeds.
    const timer = h.timers.pending().find((e) => e.ms === 2_000);
    expect(timer).toBeDefined();
    heldKey.resolve(TOKEN_KEY_RAW);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: {}, jsonrpc: "2.0", id: 0 });
    expect(h.sessions.gets).toEqual([SID]);
  });

  it("a session read that rejects: 503 session_unavailable", async () => {
    const h = makeHarness();
    h.sessions.failGet = new Error("actor sidecar down");
    const res = await h.post({});
    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);
    expect(h.lastLog()).toMatchObject({
      event: "auth_failed",
      reason: "session_unavailable",
      status: 503,
    });
  });

  it("a held session read times out at 1,000 ms: 503, and the late session is absorbed", async () => {
    const h = makeHarness();
    const held = h.sessions.holdGet();
    const pending = h.post({});
    await tick();
    // Two timers by then: the 2,000 ms key read (already settled) and the
    // 1,000 ms session read (held). The pending one is the session read.
    const pendingTimers = h.timers.pending();
    expect(pendingTimers).toHaveLength(1);
    expect(pendingTimers[0]?.ms).toBe(1_000);
    pendingTimers[0]?.fire();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);
    expect(h.sessions.gets).toEqual([SID]);
    expect(h.lastLog()).toMatchObject({
      event: "auth_failed",
      reason: "session_unavailable",
      status: 503,
    });
    // The session arrives after the timeout fired: absorbed quietly.
    held.resolve(liveSession(T0));
    await tick();
  });
});

// ---------- sanity ----------

describe("POST /mcp auth, control case", () => {
  it("a valid token and live session pass auth and reach the SDK (ping)", async () => {
    const h = makeHarness();
    const res = await h.post({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: {}, jsonrpc: "2.0", id: 0 });
    expect(h.sessions.gets).toEqual([SID]);
    expect(h.lastLog()).toMatchObject({ event: "mcp", method: "ping", outcome: "ok", status: 200 });
  });
});
