import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createLogger, createMemoryCache, kvKeys, mintSessionToken, parseKey } from "@duinvezel/shared";
import type {
  CreateSessionInput,
  CreateSessionResult,
  SessionDoc,
  SetVerifiedResult,
  VerifyFailureResult,
} from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import type { ClockFake } from "../../../packages/shared/test/fakes/clock.js";
import { createKvFake } from "../../../packages/shared/test/fakes/kv.js";
import type { KvFake } from "../../../packages/shared/test/fakes/kv.js";

import type { AccountsClient } from "../src/clients/accounts.js";
import type { AreasClient } from "../src/clients/areas.js";
import type { CrmClient, LineTestOutcome, LineTestResult } from "../src/clients/crm.js";
import type { SessionsClient } from "../src/clients/sessions.js";
import { AREA_CACHE_TTL_MS, TIMED_OUT } from "../src/config.js";
import type { TimeoutRunner } from "../src/config.js";
import type { CachesDep, SecretsDep, VoiceToolsDeps } from "../src/deps.js";
import { handleMcp } from "../src/routes/mcp.js";

// ---------- shared constants (keys generated per run, never committed) ----------

const T0 = 1_600_000_000_000;
const TOKEN_KEY_RAW = randomBytes(32).toString("base64url");
const TOKEN_KEY = parseKey(TOKEN_KEY_RAW);
const SID = "cccccccccccccccccccccccccccccccc";

const OUTAGE_DOC = {
  state: "outage",
  incidentId: "inc-2026-10-10-8630",
  eta: "Tuesday around 18:00",
  version: 3,
  updatedAt: 1_599_999_000_000,
};

const OK_DOC = { state: "ok", incidentId: null, eta: null, version: 1, updatedAt: 1_599_999_000_000 };

const LINE_RESULT: LineTestResult = {
  lineState: "degraded",
  signalDbm: -27,
  lastSeenMinutes: 4,
  suggestion: "The line is degraded. Book a repair visit so a technician can fix it.",
  nearbyOutageSuspected: false,
};

function makeSession(overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    v: 1,
    sid: SID,
    traceId: "trace-tools",
    identity: "attested",
    accountNumber: "DV-100002",
    postcode: "8630",
    lineId: "LN-000002",
    callerPhone: "+32491244713",
    createdAt: T0,
    expiresAt: T0 + 7_200_000,
    disclosedAt: null,
    verify: { failures: 0, lockedUntil: null },
    ...overrides,
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

class SessionsStub implements SessionsClient {
  readonly gets: string[] = [];
  constructor(public doc: SessionDoc | null) {}

  create(_sid: string, input: CreateSessionInput): Promise<CreateSessionResult> {
    throw new Error(`unexpected SESSION.create (${input.traceId})`);
  }

  get(sid: string, _input: { nowMs: number }): Promise<SessionDoc | null> {
    this.gets.push(sid);
    return Promise.resolve(this.doc);
  }

  setVerified(): Promise<SetVerifiedResult> {
    throw new Error("unexpected SESSION.setVerified");
  }

  recordVerifyFailure(): Promise<VerifyFailureResult> {
    throw new Error("unexpected SESSION.recordVerifyFailure");
  }
}

/** The state-changing tools are not under test here; any call is a bug. */
const accountsNever: AccountsClient = {
  verify: () => Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.verify")),
  createTicket: () => Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.createTicket")),
};

const areasNever: AreasClient = {
  report: () => Promise.reject(new Error("unexpected AREA_INCIDENT.report")),
};

class SecretsStub implements SecretsDep {
  constructor(readonly values: Record<string, string | null>) {}

  get(handle: string): Promise<string | null> {
    return Promise.resolve(this.values[handle] ?? null);
  }

  getKey(handle: string): Promise<Uint8Array | null> {
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

class CrmStub implements CrmClient {
  readonly calls: string[] = [];
  held: HeldPromise<LineTestOutcome> | null = null;
  result: LineTestOutcome = { ok: true, result: LINE_RESULT };

  testLine(lineId: string): Promise<LineTestOutcome> {
    this.calls.push(lineId);
    if (this.held !== null) {
      return this.held.promise;
    }
    return Promise.resolve(this.result);
  }

  getAccount(): Promise<never> {
    throw new Error("unexpected mock-crm GET /accounts");
  }
}

// ---------- harness ----------

interface ToolAnswer {
  status: number;
  result: Record<string, unknown> | null;
  isErrorText: string | null;
  logLine: Record<string, unknown>;
}

interface Harness {
  kv: KvFake;
  crm: CrmStub;
  timers: ManualTimers;
  clock: ClockFake;
  sessions: SessionsStub;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
}

function makeHarness(seed: {
  session?: SessionDoc | null;
  areaDocs?: Record<string, unknown>;
}): Harness {
  const clock = createClockFake(T0);
  const kv = createKvFake(clock.now);
  const timers = new ManualTimers();
  const crm = new CrmStub();
  const sessions = new SessionsStub(seed.session === undefined ? makeSession() : seed.session);
  const lines: string[] = [];
  // Production lifetimes, as literals: area statuses and flags live 10 s in memory.
  const caches: CachesDep = {
    areas: createMemoryCache(10_000, clock.now),
    flags: createMemoryCache(10_000, clock.now),
  };
  const log = createLogger(
    "voice-tools",
    (line) => {
      lines.push(line);
    },
    clock.now,
  );
  const deps: VoiceToolsDeps = {
    now: clock.now,
    kv,
    sessions,
    crm,
    accounts: accountsNever,
    areas: areasNever,
    caches,
    secrets: new SecretsStub({ MCP_TOKEN_KEY: TOKEN_KEY_RAW }),
    log,
    random: (n) => randomBytes(n),
    timeout: timers.runner,
  };
  for (const [postcode, doc] of Object.entries(seed.areaDocs ?? {})) {
    void kv.put(kvKeys.areaStatus(postcode), JSON.stringify(doc));
  }
  kv.reset();
  const token = mintSessionToken({ sid: SID, exp: T0 + 7_200_000 }, TOKEN_KEY);
  return {
    kv,
    crm,
    timers,
    clock,
    sessions,
    async callTool(name, args) {
      const res = await handleMcp(
        new Request("http://x.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        deps,
      );
      const body = (await res.json()) as {
        result?: { content?: { type: string; text?: string }[]; isError?: boolean };
      };
      const content = body.result?.content?.[0];
      const text = content?.text ?? null;
      let result: Record<string, unknown> | null = null;
      if (body.result?.isError !== true && text !== null) {
        result = JSON.parse(text) as Record<string, unknown>;
      }
      if (lines.length === 0) {
        throw new Error("no log lines captured");
      }
      return {
        status: res.status,
        result,
        isErrorText: body.result?.isError === true ? text : null,
        logLine: JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>,
      };
    },
  };
}

function areaGets(h: Harness): number {
  return h.kv.calls.filter((c) => c.method === "get" && c.key?.startsWith("area/")).length;
}

// ---------- check_area_status ----------

describe("check_area_status", () => {
  it("an outage area answers area_name, state outage and the eta", async () => {
    const h = makeHarness({ areaDocs: { "8630": OUTAGE_DOC } });
    const answer = await h.callTool("check_area_status", { postcode: "8630" });
    expect(answer.status).toBe(200);
    expect(answer.result).toEqual({
      area_name: "Veurne",
      state: "outage",
      eta: "Tuesday around 18:00",
    });
    expect(areaGets(h)).toBe(1);
    expect(answer.logLine).toMatchObject({ tool: "check_area_status", node: "verify_account", outcome: "ok" });
  });

  it("a quiet area answers ok with a null eta", async () => {
    const h = makeHarness({ areaDocs: { "8620": OK_DOC } });
    const answer = await h.callTool("check_area_status", { postcode: "8620" });
    expect(answer.result).toEqual({ area_name: "Nieuwpoort", state: "ok", eta: null });
  });

  it("a missing key is an answer, and it means ok", async () => {
    const h = makeHarness({});
    const answer = await h.callTool("check_area_status", { postcode: "8660" });
    expect(answer.result).toEqual({ area_name: "De Panne", state: "ok", eta: null });
    expect(areaGets(h)).toBe(1);
  });

  it("a postcode outside the five areas answers unknown without a KV read", async () => {
    const h = makeHarness({});
    const answer = await h.callTool("check_area_status", { postcode: "9999" });
    expect(answer.result).toEqual({ area_name: null, state: "unknown" });
    expect(h.kv.calls).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "ok", status: 200 });
  });

  it("a failed read is one sayable sentence with isError, and no area answer", async () => {
    const h = makeHarness({});
    // Poison the key with a value the parser rejects, so the read "fails"
    // without a network error; the next case covers a thrown read.
    await h.kv.put(kvKeys.areaStatus("8630"), JSON.stringify({ nope: 1 }));
    const answer = await h.callTool("check_area_status", { postcode: "8630" });
    expect(answer.isErrorText).toBe("The area status system is not responding right now.");
    expect(answer.result).toBeNull();
    expect(answer.logLine).toMatchObject({ outcome: "error", tool: "check_area_status" });
  });

  it("a thrown KV read is the same sayable sentence", async () => {
    const h = makeHarness({});
    const realGet = h.kv.get.bind(h.kv);
    h.kv.get = ((key: string, options: unknown) => {
      if (typeof key === "string" && key.startsWith("area/")) {
        return Promise.reject(new Error("kv api 500"));
      }
      return (realGet as (k: string, o: unknown) => Promise<unknown>)(key, options);
    }) as KvFake["get"];
    const answer = await h.callTool("check_area_status", { postcode: "8630" });
    expect(answer.isErrorText).toBe("The area status system is not responding right now.");
  });

  it("a held KV read times out at exactly 1,500 ms; the late answer is absorbed and not cached", async () => {
    const h = makeHarness({});
    const held = hold<unknown>();
    const realGet = h.kv.get.bind(h.kv);
    h.kv.get = ((key: string, options: unknown) => {
      if (typeof key === "string" && key.startsWith("area/")) {
        h.kv.calls.push({ method: "get", key });
        return held.promise;
      }
      return (realGet as (k: string, o: unknown) => Promise<unknown>)(key, options);
    }) as KvFake["get"];

    const pending = h.callTool("check_area_status", { postcode: "8630" });
    await tick();
    const kvTimer = h.timers.pending().find((e) => e.ms === 1_500);
    expect(kvTimer).toBeDefined();
    kvTimer?.fire();
    const answer = await pending;
    expect(answer.isErrorText).toBe("The area status system is not responding right now.");
    expect(areaGets(h)).toBe(1);
    // The KV answer arrives after the timeout fired: absorbed quietly.
    held.resolve(OUTAGE_DOC);
    await tick();
    // A timeout is not an answer, so nothing was cached: the next call for
    // the same postcode reads KV again, even one millisecond later.
    h.kv.get = realGet;
    await h.kv.put(kvKeys.areaStatus("8630"), JSON.stringify(OUTAGE_DOC));
    const recovered = await h.callTool("check_area_status", { postcode: "8630" });
    expect(recovered.result).toEqual({
      area_name: "Veurne",
      state: "outage",
      eta: "Tuesday around 18:00",
    });
    expect(areaGets(h)).toBe(2);
  });
});

// ---------- JSON numbers (T10 follow-up) ----------

describe("check_area_status JSON numbers", () => {
  it("the number 8630 answers what the string answers", async () => {
    const h = makeHarness({ areaDocs: { "8630": OUTAGE_DOC } });
    const numeric = await h.callTool("check_area_status", { postcode: 8630 });
    const stringy = await h.callTool("check_area_status", { postcode: "8630" });

    expect(numeric.result).toEqual({
      area_name: "Veurne",
      state: "outage",
      eta: "Tuesday around 18:00",
    });
    expect(numeric.result).toEqual(stringy.result);
  });

  it("8630.5 takes the string path: it fails the four-digit check exactly as the text does", async () => {
    const h = makeHarness({});
    // check_area_status has no spoken-form cleaning: "8630.5" fails the
    // four-digit regex, with isError naming the argument.
    const answer = await h.callTool("check_area_status", { postcode: 8630.5 });
    expect(answer.isErrorText).toBe("postcode must be exactly four digits.");
    expect(h.kv.calls).toEqual([]);
  });

  it("the number 86300 answers isError with a sentence that names postcode", async () => {
    const h = makeHarness({});
    const answer = await h.callTool("check_area_status", { postcode: 86300 });
    expect(answer.isErrorText).toBe("postcode must be exactly four digits.");
    expect(answer.result).toBeNull();
    expect(h.kv.calls).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "error", tool: "check_area_status" });
  });

  it.each([true, null])(
    "postcode %s still answers isError \"postcode must be a string.\"",
    async (value) => {
      const h = makeHarness({});
      const answer = await h.callTool("check_area_status", { postcode: value });
      expect(answer.isErrorText).toBe("postcode must be a string.");
      expect(answer.result).toBeNull();
      expect(h.kv.calls).toEqual([]);
      expect(answer.logLine).toMatchObject({ outcome: "error", tool: "check_area_status" });
    },
  );
});

// ---------- the 10-second memory cache ----------

describe("check_area_status memory cache", () => {
  it("the production cache lifetime is exactly 10 seconds", () => {
    // The caches above are built with the literal 10_000; this pins the
    // production constant to that same literal, so a changed production
    // lifetime fails here instead of passing silently.
    expect(AREA_CACHE_TTL_MS).toBe(10_000);
  });

  it("reads KV at most once per 10 seconds per container, boundary included", async () => {
    const h = makeHarness({ areaDocs: { "8630": OUTAGE_DOC } });
    await h.callTool("check_area_status", { postcode: "8630" });
    expect(areaGets(h)).toBe(1);

    // 9,999 ms later: still fresh, no KV read.
    h.clock.advance(9_999);
    const warm = await h.callTool("check_area_status", { postcode: "8630" });
    expect(warm.result).toEqual({
      area_name: "Veurne",
      state: "outage",
      eta: "Tuesday around 18:00",
    });
    expect(areaGets(h)).toBe(1);

    // Exactly 10,000 ms after the write: expired — one more KV read.
    h.clock.advance(1);
    await h.callTool("check_area_status", { postcode: "8630" });
    expect(areaGets(h)).toBe(2);
  });

  it("caches the missing-key ok answer too", async () => {
    const h = makeHarness({});
    await h.callTool("check_area_status", { postcode: "8630" });
    h.clock.advance(5);
    const warm = await h.callTool("check_area_status", { postcode: "8630" });
    expect(warm.result).toEqual({ area_name: "Veurne", state: "ok", eta: null });
    expect(areaGets(h)).toBe(1);
  });

  it("a failed read is not cached: the next call reads KV again", async () => {
    const h = makeHarness({});
    await h.kv.put(kvKeys.areaStatus("8630"), JSON.stringify({ nope: 1 }));
    const failed = await h.callTool("check_area_status", { postcode: "8630" });
    expect(failed.isErrorText).not.toBeNull();

    // Fixed upstream: the very next call answers from KV, not from memory.
    await h.kv.put(kvKeys.areaStatus("8630"), JSON.stringify(OUTAGE_DOC));
    const recovered = await h.callTool("check_area_status", { postcode: "8630" });
    expect(recovered.result).toEqual({
      area_name: "Veurne",
      state: "outage",
      eta: "Tuesday around 18:00",
    });
    expect(areaGets(h)).toBe(2);
  });
});

// ---------- run_line_diagnostics ----------

describe("run_line_diagnostics", () => {
  it("attested with a line id runs the test on the session's line and returns the result", async () => {
    const h = makeHarness({ session: makeSession({ identity: "attested" }) });
    const answer = await h.callTool("run_line_diagnostics", {});
    expect(answer.result).toEqual(LINE_RESULT);
    expect(h.crm.calls).toEqual(["LN-000002"]);
    expect(answer.logLine).toMatchObject({ tool: "run_line_diagnostics", node: "diagnose", outcome: "ok" });
  });

  it("verified identity runs the test too", async () => {
    const h = makeHarness({ session: makeSession({ identity: "verified" }) });
    const answer = await h.callTool("run_line_diagnostics", {});
    expect(answer.result).toEqual(LINE_RESULT);
    expect(h.crm.calls).toEqual(["LN-000002"]);
  });

  it("number_match gets needs_verification and no CRM call", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    const answer = await h.callTool("run_line_diagnostics", {});
    expect(answer.result).toEqual({ needs_verification: true });
    expect(h.crm.calls).toEqual([]);
    // A normal business outcome, not an error.
    expect(answer.logLine).toMatchObject({ outcome: "ok" });
  });

  it("anonymous gets needs_verification and no CRM call", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, lineId: null }),
    });
    const answer = await h.callTool("run_line_diagnostics", {});
    expect(answer.result).toEqual({ needs_verification: true });
    expect(h.crm.calls).toEqual([]);
  });

  it("an attested session without a line id gets needs_verification", async () => {
    const h = makeHarness({ session: makeSession({ identity: "attested", lineId: null }) });
    const answer = await h.callTool("run_line_diagnostics", {});
    expect(answer.result).toEqual({ needs_verification: true });
    expect(h.crm.calls).toEqual([]);
  });

  it("a mock-crm failure is one sayable sentence with isError", async () => {
    const h = makeHarness({});
    h.crm.result = { ok: false };
    const answer = await h.callTool("run_line_diagnostics", {});
    expect(answer.isErrorText).toBe("The diagnostics system is not responding right now.");
    expect(answer.result).toBeNull();
    expect(answer.logLine).toMatchObject({ outcome: "error", tool: "run_line_diagnostics" });
  });

  it("a held mock-crm call times out at exactly 5,000 ms; the late answer is absorbed", async () => {
    const h = makeHarness({});
    const heldCrm = hold<LineTestOutcome>();
    h.crm.held = heldCrm;
    const pending = h.callTool("run_line_diagnostics", {});
    await tick();
    const crmTimer = h.timers.pending().find((e) => e.ms === 5_000);
    expect(crmTimer).toBeDefined();
    crmTimer?.fire();
    const answer = await pending;
    expect(answer.isErrorText).toBe("The diagnostics system is not responding right now.");
    expect(answer.logLine).toMatchObject({ outcome: "error" });
    // The line test answers after the timeout fired: absorbed quietly.
    heldCrm.resolve({ ok: true, result: LINE_RESULT });
    await tick();
  });
});
