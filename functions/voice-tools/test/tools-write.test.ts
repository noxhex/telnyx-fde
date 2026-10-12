import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createLogger, createMemoryCache, kvKeys, mintSessionToken, parseKey, startTimings } from "@duinvezel/shared";
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

import { nextWorkingDayWindow } from "../src/actors/customer-account.js";
import type { NewTicketInput } from "../src/actors/customer-account.js";
import type { RecordVerifyFailureInput, SetVerifiedInput } from "../src/actors/session.js";
import type { AccountsClient } from "../src/clients/accounts.js";
import type { AreasClient } from "../src/clients/areas.js";
import type { AreaReportInput } from "../src/actors/area-incident.js";
import type { CrmAccount, CrmClient, GetAccountOutcome } from "../src/clients/crm.js";
import type { SessionsClient } from "../src/clients/sessions.js";
import type { CreateTicketResult, VerifyInput, VerifyResult } from "../src/domain/customer-account.js";
import type { ReportResult } from "../src/domain/area-incident.js";
import { FLAG_CACHE_TTL_MS, TIMED_OUT } from "../src/config.js";
import type { TimeoutRunner } from "../src/config.js";
import type { CachesDep, SecretsDep, VoiceToolsDeps } from "../src/deps.js";
import { createFlagsValue } from "../src/flags.js";
import { callbackTicketId, handleCreateTicket } from "../src/mcp/tools/create-ticket.js";
import { handleMcp } from "../src/routes/mcp.js";

// ---------- shared constants (keys generated per run, never committed) ----------

const T0 = 1_600_000_000_000; // 2020-09-13 06:40 UTC, a Sunday morning in Brussels
const TOKEN_KEY_RAW = randomBytes(32).toString("base64url");
const TOKEN_KEY = parseKey(TOKEN_KEY_RAW);
const SID = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRACE_ID = "trace-write";

/** T0 is a Sunday in Europe/Brussels, so the window is Monday the 14th. */
const T0_WINDOW = "2020-09-14 08:00-12:00";

const OUTAGE_DOC = {
  state: "outage",
  incidentId: "INC-8630-2026101008",
  eta: "by 18:00 today",
  version: 2,
  updatedAt: T0 - 60_000,
};

/** Mock-crm's DV-100003 fixture shape: the account verify_account fetches. */
const ACCOUNT_DOC: CrmAccount = {
  accountNumber: "DV-100003",
  firstName: "Jan",
  postcode: "8630",
  lineId: "LN-000003",
};

/** mock-crm's DV-100001 fixture shape. */
const ACCOUNT_100001: CrmAccount = {
  accountNumber: "DV-100001",
  firstName: "Thiago",
  postcode: "8630",
  lineId: "LN-000001",
};

function makeSession(overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    v: 1,
    sid: SID,
    traceId: TRACE_ID,
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
  readonly verified: { sid: string; input: SetVerifiedInput; traceId: string }[] = [];
  readonly failures: { sid: string; input: RecordVerifyFailureInput; traceId: string }[] = [];
  verifiedResult: SetVerifiedResult = { outcome: "verified", lockedUntil: null };
  failureResult: VerifyFailureResult = { outcome: "counted", attemptsLeft: 2, lockedUntil: null };
  heldVerified: HeldPromise<SetVerifiedResult> | null = null;
  heldFailure: HeldPromise<VerifyFailureResult> | null = null;

  constructor(public doc: SessionDoc | null) {}

  create(_sid: string, input: CreateSessionInput): Promise<CreateSessionResult> {
    throw new Error(`unexpected SESSION.create (${input.traceId})`);
  }

  get(sid: string, _input: { nowMs: number }): Promise<SessionDoc | null> {
    this.gets.push(sid);
    return Promise.resolve(this.doc);
  }

  setVerified(sid: string, input: SetVerifiedInput, traceId: string): Promise<SetVerifiedResult> {
    this.verified.push({ sid, input, traceId });
    return this.heldVerified !== null ? this.heldVerified.promise : Promise.resolve(this.verifiedResult);
  }

  recordVerifyFailure(
    sid: string,
    input: RecordVerifyFailureInput,
    traceId: string,
  ): Promise<VerifyFailureResult> {
    this.failures.push({ sid, input, traceId });
    return this.heldFailure !== null ? this.heldFailure.promise : Promise.resolve(this.failureResult);
  }
}

class CrmStub implements CrmClient {
  readonly accountCalls: string[] = [];
  accountOutcome: GetAccountOutcome = { kind: "found", account: ACCOUNT_DOC };
  heldAccount: HeldPromise<GetAccountOutcome> | null = null;

  testLine(): Promise<never> {
    throw new Error("unexpected mock-crm line test");
  }

  getAccount(accountNumber: string): Promise<GetAccountOutcome> {
    this.accountCalls.push(accountNumber);
    return this.heldAccount !== null
      ? this.heldAccount.promise
      : Promise.resolve(this.accountOutcome);
  }
}

interface VerifyCall {
  accountNumber: string;
  input: VerifyInput;
  traceId: string;
}

class AccountsStub implements AccountsClient {
  readonly verifies: VerifyCall[] = [];
  readonly tickets: { accountNumber: string; input: NewTicketInput; traceId: string }[] = [];
  verifyResult: VerifyResult = { outcome: "ok", attemptsLeft: 3, lockedUntil: null };
  ticketResult: CreateTicketResult = { ticketId: "T-4242", created: true, window: T0_WINDOW };
  heldVerify: HeldPromise<VerifyResult> | null = null;
  heldTicket: HeldPromise<CreateTicketResult> | null = null;
  failVerify: Error | null = null;

  verify(accountNumber: string, input: VerifyInput, traceId: string): Promise<VerifyResult> {
    this.verifies.push({ accountNumber, input, traceId });
    if (this.heldVerify !== null) {
      return this.heldVerify.promise;
    }
    if (this.failVerify !== null) {
      return Promise.reject(this.failVerify);
    }
    return Promise.resolve(this.verifyResult);
  }

  createTicket(
    accountNumber: string,
    input: NewTicketInput,
    traceId: string,
  ): Promise<CreateTicketResult> {
    this.tickets.push({ accountNumber, input, traceId });
    return this.heldTicket !== null
      ? this.heldTicket.promise
      : Promise.resolve(this.ticketResult);
  }
}

class AreasStub implements AreasClient {
  readonly reports: { postcode: string; input: AreaReportInput }[] = [];
  reportResult: ReportResult = {
    reportsInWindow: 2,
    threshold: 3,
    counted: true,
    incidentDeclared: false,
    incidentId: null,
    eta: null,
  };
  heldReport: HeldPromise<ReportResult> | null = null;
  failReport: Error | null = null;

  report(postcode: string, input: AreaReportInput): Promise<ReportResult> {
    this.reports.push({ postcode, input });
    if (this.heldReport !== null) {
      return this.heldReport.promise;
    }
    if (this.failReport !== null) {
      return Promise.reject(this.failReport);
    }
    return Promise.resolve(this.reportResult);
  }
}

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

// ---------- harness ----------

interface ToolAnswer {
  status: number;
  result: Record<string, unknown> | null;
  isErrorText: string | null;
  rpcError: { code: number; message: string } | null;
  logLine: Record<string, unknown>;
}

interface Harness {
  kv: KvFake | undefined;
  crm: CrmStub;
  accounts: AccountsStub;
  areas: AreasStub;
  sessions: SessionsStub;
  timers: ManualTimers;
  clock: ClockFake;
  deps: VoiceToolsDeps;
  /** Raw JSON log lines, one per tool call plus one `flags_read` per settled flags read. */
  lines: string[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
}

function makeHarness(seed: {
  session?: SessionDoc | null;
  areaDocs?: Record<string, unknown>;
  flagsDoc?: unknown;
  kvOff?: boolean;
  /** Overrides deps.now (a broken clock for the fail-closed paths); the logger and KV keep the real fake clock. */
  now?: () => number;
}): Harness {
  const clock = createClockFake(T0);
  const kv = seed.kvOff === true ? undefined : createKvFake(clock.now);
  const timers = new ManualTimers();
  const crm = new CrmStub();
  const accounts = new AccountsStub();
  const areas = new AreasStub();
  const sessions = new SessionsStub(seed.session === undefined ? makeSession() : seed.session);
  const lines: string[] = [];
  // Production lifetime, as a literal: area statuses live 10 s in memory.
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
  // The container's refreshing flags value, fresh per test, built the way
  // index.ts builds it for one container (undefined when there is no KV).
  const flagsValue =
    kv === undefined
      ? undefined
      : createFlagsValue({
          kv: () => kv,
          now: clock.now,
          timeout: timers.runner,
          onSettled: (outcome, durationMs) => {
            log.log("info", "flags_read", {
              outcome,
              latency_ms: { total: durationMs, kv: durationMs },
            });
          },
        });
  const deps: VoiceToolsDeps = {
    now: seed.now ?? clock.now,
    kv,
    sessions,
    crm,
    accounts,
    areas,
    caches,
    flagsValue,
    secrets: new SecretsStub({ MCP_TOKEN_KEY: TOKEN_KEY_RAW }),
    log,
    random: (n) => randomBytes(n),
    timeout: timers.runner,
  };
  if (kv !== undefined) {
    for (const [postcode, doc] of Object.entries(seed.areaDocs ?? {})) {
      void kv.put(kvKeys.areaStatus(postcode), JSON.stringify(doc));
    }
    if (seed.flagsDoc !== undefined) {
      void kv.put(kvKeys.flags(), JSON.stringify(seed.flagsDoc));
    }
    kv.reset();
  }
  const token = mintSessionToken({ sid: SID, exp: T0 + 7_200_000 }, TOKEN_KEY);
  return {
    kv,
    crm,
    accounts,
    areas,
    sessions,
    timers,
    clock,
    deps,
    lines,
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
        error?: { code: number; message: string };
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
        rpcError: body.error ?? null,
        logLine: JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>,
      };
    },
  };
}

/** KV calls against a live fake; the kvOff harness never gets asked. */
function kvCalls(h: Harness): NonNullable<KvFake["calls"]> {
  if (h.kv === undefined) {
    throw new Error("this harness has no KV fake");
  }
  return h.kv.calls;
}

function flagsGets(h: Harness): number {
  return kvCalls(h).filter((c) => c.method === "get" && c.key === kvKeys.flags()).length;
}

function areaGets(h: Harness): number {
  return kvCalls(h).filter((c) => c.method === "get" && c.key?.startsWith("area/")).length;
}

function callbackPuts(h: Harness) {
  return kvCalls(h).filter((c) => c.method === "put" && c.key?.startsWith("callback/"));
}

// ---------- verify_account ----------

describe("verify_account", () => {
  it("full mode verifies the account the caller read out and promotes the session to it", async () => {
    // The session matched DV-100002 by caller ID; the caller reads out
    // DV-100003 instead. Only DV-100003 is ever looked up, checked and
    // written — the session's own account is never touched, and no other
    // account can be reached but the proven one.
    const h = makeHarness({
      session: makeSession({ identity: "number_match" }),
      areaDocs: { "8630": OUTAGE_DOC },
    });
    const answer = await h.callTool("verify_account", {
      postcode: "8630",
      account_number: "DV-100003",
    });
    expect(answer.result).toEqual({
      verified: true,
      first_name: "Jan",
      area_name: "Veurne",
      area_outage: true,
      outage_eta: "by 18:00 today",
    });
    expect(h.crm.accountCalls).toEqual(["DV-100003"]);
    expect(h.accounts.verifies).toEqual([
      {
        accountNumber: "DV-100003",
        input: {
          mode: "full",
          submitted: { postcode: "8630", accountNumber: "DV-100003" },
          expected: { postcode: "8630", accountNumber: "DV-100003" },
          nowMs: T0,
        },
        traceId: TRACE_ID,
      },
    ]);
    expect(h.sessions.verified).toEqual([
      {
        sid: SID,
        input: {
          accountNumber: "DV-100003",
          postcode: "8630",
          lineId: "LN-000003",
          nowMs: T0,
        },
        traceId: TRACE_ID,
      },
    ]);
    expect(answer.logLine).toMatchObject({
      tool: "verify_account",
      node: "verify_account",
      outcome: "ok",
    });
  });

  it("postcode mode verifies the session's matched account on the postcode alone", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "number_match" }),
    });
    h.crm.accountOutcome = {
      kind: "found",
      account: {
        accountNumber: "DV-100002",
        firstName: "Marie",
        postcode: "8630",
        lineId: "LN-000002",
      },
    };
    const answer = await h.callTool("verify_account", { postcode: "8630" });
    expect(answer.result).toEqual({
      verified: true,
      first_name: "Marie",
      area_name: "Veurne",
      area_outage: false,
      outage_eta: null,
    });
    expect(h.crm.accountCalls).toEqual(["DV-100002"]);
    expect(h.accounts.verifies[0]).toMatchObject({
      accountNumber: "DV-100002",
      traceId: TRACE_ID,
    });
    expect(h.accounts.verifies[0]?.input).toEqual({
      mode: "postcode",
      submitted: { postcode: "8630" },
      expected: { postcode: "8630", accountNumber: "DV-100002" },
      nowMs: T0,
    });
  });

  it("wrong details answer attempts_left and the session is not promoted", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    h.accounts.verifyResult = { outcome: "wrong", attemptsLeft: 2, lockedUntil: null };
    const answer = await h.callTool("verify_account", { postcode: "8600" });
    expect(answer.result).toEqual({ verified: false, attempts_left: 2 });
    expect(h.sessions.verified).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "ok" });
  });

  it("wrong details in full mode answer attempts_left too, checked on the account the caller named", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    h.accounts.verifyResult = { outcome: "wrong", attemptsLeft: 1, lockedUntil: null };
    const answer = await h.callTool("verify_account", {
      postcode: "8600",
      account_number: "DV-100003",
    });
    expect(answer.result).toEqual({ verified: false, attempts_left: 1 });
    expect(h.accounts.verifies[0]?.input.mode).toBe("full");
    // The account exists (the CRM answered), so the failure lives on the
    // account's actor, never on the session.
    expect(h.sessions.failures).toEqual([]);
  });

  it("a failed area read never fails a verification that succeeded: the area fields just degrade", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    // Poison the status key so the read fails after setVerified succeeded.
    await (h.kv as KvFake).put(kvKeys.areaStatus("8630"), JSON.stringify({ nope: 1 }));
    const answer = await h.callTool("verify_account", { postcode: "8630" });
    expect(answer.result).toEqual({
      verified: true,
      first_name: "Jan",
      area_name: "Veurne",
      area_outage: false,
      outage_eta: null,
    });
    expect(answer.isErrorText).toBeNull();
  });

  it("an account that does not exist is counted on the session and creates no CustomerAccount actor", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    h.crm.accountOutcome = { kind: "not_found" };
    const answer = await h.callTool("verify_account", {
      postcode: "8630",
      account_number: "DV-199999",
    });
    expect(answer.result).toEqual({ verified: false, attempts_left: 2 });
    expect(h.crm.accountCalls).toEqual(["DV-199999"]);
    expect(h.accounts.verifies).toEqual([]);
    expect(h.sessions.failures).toEqual([
      { sid: SID, input: { nowMs: T0 }, traceId: TRACE_ID },
    ]);
    expect(answer.logLine).toMatchObject({ outcome: "ok" });
  });

  it("the missing-account guess that trips the lock answers locked with minutes rounded up", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    h.crm.accountOutcome = { kind: "not_found" };
    // 14 minutes and 59.999 s left on the new lock: 15 whole minutes.
    h.sessions.failureResult = {
      outcome: "locked",
      attemptsLeft: 0,
      lockedUntil: T0 + 899_999,
    };
    const answer = await h.callTool("verify_account", {
      postcode: "8630",
      account_number: "DV-199999",
    });
    expect(answer.result).toEqual({ verified: false, locked: true, locked_minutes: 15 });
  });

  it("the session's verify lock refuses before any CRM or actor call", async () => {
    const h = makeHarness({
      session: makeSession({ verify: { failures: 0, lockedUntil: T0 + 840_000 } }),
    });
    const answer = await h.callTool("verify_account", { postcode: "8630" });
    // Exactly 14 minutes left: no rounding up beyond it.
    expect(answer.result).toEqual({ verified: false, locked: true, locked_minutes: 14 });
    expect(h.crm.accountCalls).toEqual([]);
    expect(h.accounts.verifies).toEqual([]);
    expect(h.sessions.failures).toEqual([]);
    expect(kvCalls(h)).toEqual([]);
  });

  it("a session lock expiring exactly now no longer locks", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "number_match", verify: { failures: 0, lockedUntil: T0 } }),
    });
    const answer = await h.callTool("verify_account", { postcode: "8630" });
    expect(answer.result).toMatchObject({ verified: true });
    expect(h.crm.accountCalls).toEqual(["DV-100002"]);
  });

  it("without an account_number and without a matched account the tool asks for one, counting nothing", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    const answer = await h.callTool("verify_account", { postcode: "8630" });
    expect(answer.result).toEqual({ verified: false, account_number_needed: true });
    expect(h.crm.accountCalls).toEqual([]);
    expect(h.accounts.verifies).toEqual([]);
    expect(h.sessions.failures).toEqual([]);
    expect(kvCalls(h)).toEqual([]);
  });

  it("an account lockout answers locked with the minutes rounded up", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    // 61 seconds left: one whole minute rounds up to two.
    h.accounts.verifyResult = { outcome: "locked", attemptsLeft: 0, lockedUntil: T0 + 61_000 };
    const answer = await h.callTool("verify_account", { postcode: "8600" });
    expect(answer.result).toEqual({ verified: false, locked: true, locked_minutes: 2 });
    expect(h.sessions.verified).toEqual([]);
  });

  it("setVerified answering locked wins over the account's ok", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    h.sessions.verifiedResult = { outcome: "locked", lockedUntil: T0 + 540_000 };
    const answer = await h.callTool("verify_account", { postcode: "8630" });
    expect(answer.result).toEqual({ verified: false, locked: true, locked_minutes: 9 });
  });

  it("an account outside the five areas still verifies, with a null area name and no area read", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    h.crm.accountOutcome = {
      kind: "found",
      account: { accountNumber: "DV-100002", firstName: "Marie", postcode: "9999", lineId: "LN-000002" },
    };
    const answer = await h.callTool("verify_account", { postcode: "9999" });
    expect(answer.result).toEqual({
      verified: true,
      first_name: "Marie",
      area_name: null,
      area_outage: false,
      outage_eta: null,
    });
    expect(areaGets(h)).toBe(0);
  });

  it("a failed CRM call is one sayable sentence with isError", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    h.crm.accountOutcome = { kind: "failed" };
    const answer = await h.callTool("verify_account", { postcode: "8630" });
    expect(answer.isErrorText).toBe("The verification system is not responding right now.");
    expect(answer.result).toBeNull();
    expect(h.accounts.verifies).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "error", tool: "verify_account" });
  });
});

describe("verify_account timeouts", () => {
  it("a held CRM call times out at exactly 1,500 ms; the late answer is absorbed", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    h.crm.heldAccount = hold<GetAccountOutcome>();
    const pending = h.callTool("verify_account", { postcode: "8630" });
    await tick();
    const timer = h.timers.pending().find((e) => e.ms === 1_500);
    expect(timer).toBeDefined();
    timer?.fire();
    const answer = await pending;
    expect(answer.isErrorText).toBe("The verification system is not responding right now.");
    expect(h.accounts.verifies).toEqual([]);
    // The CRM answers after the timeout fired: absorbed quietly.
    h.crm.heldAccount.resolve({ kind: "found", account: ACCOUNT_DOC });
    await tick();
  });

  it("a held CUSTOMER_ACCOUNT.verify times out at exactly 1,000 ms; the late answer is absorbed", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    h.accounts.heldVerify = hold<VerifyResult>();
    const pending = h.callTool("verify_account", { postcode: "8630" });
    await tick();
    const timer = h.timers.pending().find((e) => e.ms === 1_000);
    expect(timer).toBeDefined();
    timer?.fire();
    const answer = await pending;
    expect(answer.isErrorText).toBe("The verification system is not responding right now.");
    expect(h.sessions.verified).toEqual([]);
    h.accounts.heldVerify.resolve({ outcome: "ok", attemptsLeft: 3, lockedUntil: null });
    await tick();
  });

  it("a held SESSION.setVerified times out at exactly 1,000 ms; the late answer is absorbed", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    h.sessions.heldVerified = hold<SetVerifiedResult>();
    const pending = h.callTool("verify_account", { postcode: "8630" });
    // Wait until the flow has actually called setVerified: the CRM lookup
    // and the account check have settled by then, so the only pending
    // 1,000 ms timer belongs to this call — never to CUSTOMER_ACCOUNT.verify.
    for (let i = 0; i < 100 && h.sessions.verified.length === 0; i++) {
      await tick();
    }
    expect(h.accounts.verifies).toHaveLength(1);
    expect(h.sessions.verified).toHaveLength(1);
    const timer = h.timers.pending().find((e) => e.ms === 1_000);
    expect(timer).toBeDefined();
    timer?.fire();
    const answer = await pending;
    expect(answer.isErrorText).toBe("The verification system is not responding right now.");
    h.sessions.heldVerified.resolve({ outcome: "verified", lockedUntil: null });
    await tick();
  });

  it("a held SESSION.recordVerifyFailure times out at exactly 1,000 ms; the late answer is absorbed", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    h.crm.accountOutcome = { kind: "not_found" };
    h.sessions.heldFailure = hold<VerifyFailureResult>();
    const pending = h.callTool("verify_account", {
      postcode: "8630",
      account_number: "DV-199999",
    });
    await tick();
    const timer = h.timers.pending().find((e) => e.ms === 1_000);
    expect(timer).toBeDefined();
    timer?.fire();
    const answer = await pending;
    expect(answer.isErrorText).toBe("The verification system is not responding right now.");
    h.sessions.heldFailure.resolve({ outcome: "counted", attemptsLeft: 2, lockedUntil: null });
    await tick();
  });
});

describe("verify_account: the attempt that locks the account", () => {
  it.each([
    { msLeft: 867_000, minutes: 15 }, // 14 minutes 27 s left on the new lock: 15 whole minutes.
    { msLeft: 200_000, minutes: 4 }, // 3 minutes 20 s left: the minutes come from the lock end, never an assumed 15.
  ])(
    "a wrong answer carrying a lock with $msLeft ms left answers locked_minutes $minutes",
    async ({ msLeft, minutes }) => {
      const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
      h.accounts.verifyResult = { outcome: "wrong", attemptsLeft: 0, lockedUntil: T0 + msLeft };
      const answer = await h.callTool("verify_account", { postcode: "8600" });
      expect(answer.result).toEqual({ verified: false, locked: true, locked_minutes: minutes });
      expect(h.sessions.verified).toEqual([]);
    },
  );

  it("a wrong answer below the limit, with no lock end, still answers attempts_left", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    h.accounts.verifyResult = { outcome: "wrong", attemptsLeft: 1, lockedUntil: null };
    const answer = await h.callTool("verify_account", { postcode: "8600" });
    expect(answer.result).toEqual({ verified: false, attempts_left: 1 });
  });
});

describe("verify_account spoken forms", () => {
  it.each(["dv-100001", "DV 100001", "DV100001", "DV.100.001", "100001"])(
    "the spoken form %s reaches the CRM, the actor and the session as DV-100001",
    async (spoken) => {
      const h = makeHarness({
        session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
      });
      h.crm.accountOutcome = { kind: "found", account: ACCOUNT_100001 };
      const answer = await h.callTool("verify_account", {
        postcode: "8630",
        account_number: spoken,
      });
      expect(answer.result).toEqual({
        verified: true,
        first_name: "Thiago",
        area_name: "Veurne",
        area_outage: false,
        outage_eta: null,
      });
      expect(h.crm.accountCalls).toEqual(["DV-100001"]);
      expect(h.accounts.verifies).toHaveLength(1);
      expect(h.accounts.verifies[0]?.accountNumber).toBe("DV-100001");
      expect(h.accounts.verifies[0]?.input.mode).toBe("full");
      expect(h.accounts.verifies[0]?.input.submitted).toEqual({
        postcode: "8630",
        accountNumber: "DV-100001",
      });
      expect(h.sessions.verified[0]?.input.accountNumber).toBe("DV-100001");
    },
  );

  it("a five-digit number answers account_number_unclear with no call and nothing counted", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    const answer = await h.callTool("verify_account", {
      postcode: "8630",
      account_number: "10001",
    });
    expect(answer.result).toEqual({ verified: false, account_number_unclear: true });
    expect(h.crm.accountCalls).toEqual([]);
    expect(h.accounts.verifies).toEqual([]);
    expect(h.sessions.failures).toEqual([]);
    expect(h.sessions.verified).toEqual([]);
    expect(kvCalls(h)).toEqual([]);
    // A normal result, not an error: the model asks the caller to repeat it.
    expect(answer.logLine).toMatchObject({ outcome: "ok" });
  });

  it.each(["10 50", "B-1050"])(
    "the spoken postcode %s reaches the actor and the session as 1050",
    async (spoken) => {
      const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
      h.crm.accountOutcome = {
        kind: "found",
        account: { accountNumber: "DV-100002", firstName: "Marie", postcode: "1050", lineId: "LN-000002" },
      };
      const answer = await h.callTool("verify_account", { postcode: spoken });
      expect(answer.result).toMatchObject({ verified: true });
      expect(h.accounts.verifies[0]?.input.mode).toBe("postcode");
      expect(h.accounts.verifies[0]?.input.submitted).toEqual({ postcode: "1050" });
      expect(h.sessions.verified[0]?.input.postcode).toBe("1050");
    },
  );

  it("a postcode that does not clean to four digits answers postcode_unclear with nothing counted", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    const answer = await h.callTool("verify_account", { postcode: "86 3" });
    expect(answer.result).toEqual({ verified: false, postcode_unclear: true });
    expect(h.crm.accountCalls).toEqual([]);
    expect(h.accounts.verifies).toEqual([]);
    expect(h.sessions.failures).toEqual([]);
    expect(kvCalls(h)).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "ok" });
  });

  it("the session lock still refuses before any cleaning, call or counting", async () => {
    const h = makeHarness({
      session: makeSession({ verify: { failures: 0, lockedUntil: T0 + 840_000 } }),
    });
    const answer = await h.callTool("verify_account", {
      postcode: "nonsense",
      account_number: "also nonsense",
    });
    expect(answer.result).toEqual({ verified: false, locked: true, locked_minutes: 14 });
    expect(h.crm.accountCalls).toEqual([]);
    expect(h.accounts.verifies).toEqual([]);
  });
});

// ---------- JSON numbers (T10 follow-up) ----------

describe("verify_account JSON numbers", () => {
  it("a number for the postcode answers what the string answers in postcode mode, and the actor receives the string", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "number_match" }),
    });
    h.crm.accountOutcome = {
      kind: "found",
      account: {
        accountNumber: "DV-100002",
        firstName: "Marie",
        postcode: "8630",
        lineId: "LN-000002",
      },
    };
    const answer = await h.callTool("verify_account", { postcode: 8630 });
    expect(answer.result).toEqual({
      verified: true,
      first_name: "Marie",
      area_name: "Veurne",
      area_outage: false,
      outage_eta: null,
    });
    expect(h.accounts.verifies[0]?.input).toEqual({
      mode: "postcode",
      submitted: { postcode: "8630" },
      expected: { postcode: "8630", accountNumber: "DV-100002" },
      nowMs: T0,
    });
  });

  it("a number for the postcode answers what the string answers in full mode, and the actor receives the string", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
      areaDocs: { "8630": OUTAGE_DOC },
    });
    const answer = await h.callTool("verify_account", {
      postcode: 8630,
      account_number: "DV-100003",
    });
    expect(answer.result).toEqual({
      verified: true,
      first_name: "Jan",
      area_name: "Veurne",
      area_outage: true,
      outage_eta: "by 18:00 today",
    });
    expect(h.accounts.verifies[0]?.input.mode).toBe("full");
    expect(h.accounts.verifies[0]?.input.submitted).toEqual({
      postcode: "8630",
      accountNumber: "DV-100003",
    });
  });

  it("a number for the account number reaches the CRM and the actor as DV-100001", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    h.crm.accountOutcome = { kind: "found", account: ACCOUNT_100001 };
    const answer = await h.callTool("verify_account", {
      postcode: "8630",
      account_number: 100001,
    });
    expect(answer.result).toMatchObject({ verified: true, first_name: "Thiago" });
    expect(h.crm.accountCalls).toEqual(["DV-100001"]);
    expect(h.accounts.verifies[0]?.input.submitted).toEqual({
      postcode: "8630",
      accountNumber: "DV-100001",
    });
    expect(h.sessions.verified[0]?.input.accountNumber).toBe("DV-100001");
  });

  it("a five-digit number answers account_number_unclear with no call and nothing counted", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    const answer = await h.callTool("verify_account", {
      postcode: "8630",
      account_number: 10001,
    });
    expect(answer.result).toEqual({ verified: false, account_number_unclear: true });
    expect(h.crm.accountCalls).toEqual([]);
    expect(h.accounts.verifies).toEqual([]);
    expect(h.sessions.failures).toEqual([]);
    expect(h.sessions.verified).toEqual([]);
    expect(kvCalls(h)).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "ok" });
  });

  it("8630.5 takes the string path: cleaned, it is not four digits, so postcode_unclear with nothing counted", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    const answer = await h.callTool("verify_account", { postcode: 8630.5 });
    expect(answer.result).toEqual({ verified: false, postcode_unclear: true });
    expect(h.crm.accountCalls).toEqual([]);
    expect(h.accounts.verifies).toEqual([]);
    expect(h.sessions.failures).toEqual([]);
    expect(kvCalls(h)).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "ok" });
  });
});

// ---------- invalid arguments (SEP-1303) ----------

describe("invalid arguments are isError results naming the argument", () => {
  it("verify_account: a 33-character postcode names postcode", async () => {
    const h = makeHarness({});
    const answer = await h.callTool("verify_account", { postcode: "8".repeat(33) });
    expect(answer.isErrorText).toBe("postcode must be at most 32 characters.");
    expect(answer.result).toBeNull();
    expect(answer.rpcError).toBeNull();
    expect(answer.logLine).toMatchObject({ outcome: "error", tool: "verify_account" });
    expect(h.crm.accountCalls).toEqual([]);
  });

  // Only a JSON number becomes a string (T10 follow-up); every other type
  // still answers "<argument> must be a string."
  it.each([
    [{ postcode: true }, "postcode"],
    [{ postcode: null }, "postcode"],
    [{ postcode: "8630", account_number: true }, "account_number"],
    [{ postcode: "8630", account_number: null }, "account_number"],
  ])("verify_account: %j answers isError naming %s", async (args, field) => {
    const h = makeHarness({});
    const answer = await h.callTool("verify_account", args);
    expect(answer.isErrorText).toBe(`${field} must be a string.`);
    expect(answer.result).toBeNull();
    expect(answer.rpcError).toBeNull();
    expect(answer.logLine).toMatchObject({ outcome: "error", tool: "verify_account" });
    expect(h.crm.accountCalls).toEqual([]);
    expect(h.accounts.verifies).toEqual([]);
  });

  it("report_outage: an unknown symptom names symptom, in the card's own words", async () => {
    const h = makeHarness({});
    const answer = await h.callTool("report_outage", { symptom: "on_fire" });
    expect(answer.isErrorText).toBe(
      "symptom must be one of no_connection, slow, intermittent or other.",
    );
    expect(answer.logLine).toMatchObject({ outcome: "error", tool: "report_outage" });
    expect(h.areas.reports).toEqual([]);
    expect(flagsGets(h)).toBe(0);
  });

  it("create_ticket: an unknown category names category", async () => {
    const h = makeHarness({ session: makeSession({ identity: "verified" }) });
    const answer = await h.callTool("create_ticket", { category: "urgent", summary: "Help." });
    expect(answer.isErrorText).toBe("category must be one of repair_visit, callback or other.");
    expect(answer.logLine).toMatchObject({ outcome: "error", tool: "create_ticket" });
    expect(h.accounts.tickets).toEqual([]);
  });
});

// ---------- report_outage ----------

describe("report_outage", () => {
  it("a matched caller reports with the flags passed through and the session's trace id", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "number_match" }),
      flagsDoc: { incident_threshold: 5, report_window_secs: 900, incident_eta_minutes: 60 },
    });
    const answer = await h.callTool("report_outage", { symptom: "no_connection" });
    expect(answer.result).toEqual({
      reports_in_window: 2,
      threshold: 3,
      counted: true,
      incident_declared: false,
      incident_id: null,
      eta: null,
    });
    expect(h.areas.reports).toEqual([
      {
        postcode: "8630",
        input: {
          accountId: "DV-100002",
          symptom: "no_connection",
          nowMs: T0,
          threshold: 5,
          windowMs: 900_000,
          etaMs: 3_600_000,
          traceId: TRACE_ID,
        },
      },
    ]);
    expect(flagsGets(h)).toBe(1);
    expect(answer.logLine).toMatchObject({
      tool: "report_outage",
      node: "outage_help",
      outcome: "ok",
    });
  });

  it("without flags in KV the defaults apply: threshold 3, window 1,800 s, eta 240 min", async () => {
    const h = makeHarness({ session: makeSession({ identity: "verified" }) });
    const answer = await h.callTool("report_outage", { symptom: "slow" });
    expect(answer.result).toMatchObject({ reports_in_window: 2 });
    expect(h.areas.reports[0]?.input).toMatchObject({
      threshold: 3,
      windowMs: 1_800_000,
      etaMs: 14_400_000,
      accountId: "DV-100002",
      traceId: TRACE_ID,
    });
  });

  it("an anonymous caller gets needs_verification and nothing is read or called", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    const answer = await h.callTool("report_outage", { symptom: "other" });
    expect(answer.result).toEqual({ needs_verification: true });
    expect(h.areas.reports).toEqual([]);
    expect(kvCalls(h)).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "ok" });
  });

  it("an anonymous session holding an account and a postcode still gets needs_verification", async () => {
    // POST /internal/sessions can create exactly this session: the identity
    // gate, not the missing data, is what refuses the report.
    const h = makeHarness({ session: makeSession({ identity: "anonymous" }) });
    const answer = await h.callTool("report_outage", { symptom: "no_connection" });
    expect(answer.result).toEqual({ needs_verification: true });
    expect(h.areas.reports).toEqual([]);
    expect(flagsGets(h)).toBe(0);
  });

  it("a matched session without an account or a postcode gets needs_verification too", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "number_match", accountNumber: null, postcode: null, lineId: null }),
    });
    const answer = await h.callTool("report_outage", { symptom: "intermittent" });
    expect(answer.result).toEqual({ needs_verification: true });
    expect(h.areas.reports).toEqual([]);
    expect(flagsGets(h)).toBe(0);
  });

  it("an actor failure is one sayable sentence with isError", async () => {
    const h = makeHarness({});
    h.areas.failReport = new Error("actor sidecar down");
    const answer = await h.callTool("report_outage", { symptom: "no_connection" });
    expect(answer.isErrorText).toBe("The outage reporting system is not responding right now.");
    expect(answer.result).toBeNull();
    expect(answer.logLine).toMatchObject({ outcome: "error", tool: "report_outage" });
  });

  it("a held AREA_INCIDENT.report times out at exactly 3,000 ms; the late answer is absorbed", async () => {
    const h = makeHarness({});
    h.areas.heldReport = hold<ReportResult>();
    const pending = h.callTool("report_outage", { symptom: "no_connection" });
    await tick(60); // the refreshing flags value adds a few hops before the report starts
    // The flags read settled; the pending timer is the 3,000 ms report.
    const timer = h.timers.pending().find((e) => e.ms === 3_000);
    expect(timer).toBeDefined();
    timer?.fire();
    const answer = await pending;
    expect(answer.isErrorText).toBe("The outage reporting system is not responding right now.");
    h.areas.heldReport.resolve({
      reportsInWindow: 2,
      threshold: 3,
      counted: true,
      incidentDeclared: true,
      incidentId: "INC-8630-2020091308",
      eta: "by 12:40 today",
    });
    await tick();
  });

  it("a held flags read times out at exactly 1,000 ms: the defaults apply, and the late success applies to the next call (T20)", async () => {
    const h = makeHarness({});
    const held = hold<unknown>();
    const realGet = (h.kv as KvFake).get.bind(h.kv);
    (h.kv as KvFake).get = ((key: string, options: unknown) => {
      if (key === kvKeys.flags()) {
        (h.kv as KvFake).calls.push({ method: "get", key });
        return held.promise;
      }
      return (realGet as (k: string, o: unknown) => Promise<unknown>)(key, options);
    }) as KvFake["get"];

    const pending = h.callTool("report_outage", { symptom: "no_connection" });
    await tick();
    const timer = h.timers.pending().find((e) => e.ms === 1_000);
    expect(timer).toBeDefined();
    timer?.fire();
    const answer = await pending;
    expect(answer.result).toMatchObject({ reports_in_window: 2 });
    expect(h.areas.reports[0]?.input).toMatchObject({ threshold: 3, windowMs: 1_800_000 });
    // The flags document arrives after the wait gave up: its success
    // becomes the last good value, and the next call uses it without
    // reading KV again.
    held.resolve({ incident_threshold: 5 });
    await tick();
    expect(flagsGets(h)).toBe(1);
    (h.kv as KvFake).get = realGet;
    await h.callTool("report_outage", { symptom: "no_connection" });
    expect(h.areas.reports[1]?.input).toMatchObject({ threshold: 5 });
    expect(flagsGets(h)).toBe(1);
  });

  it("with a last good value a call never waits for KV, also while the refresh it started never settles (T20)", async () => {
    const h = makeHarness({
      flagsDoc: { incident_threshold: 5, report_window_secs: 900, incident_eta_minutes: 60 },
    });
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(1);

    // Exactly one lifetime later the flags read is held: the next call
    // starts a background refresh but answers at once from the last good
    // value — the answer comes back while the read is still pending.
    const held = hold<unknown>();
    const realGet = (h.kv as KvFake).get.bind(h.kv);
    (h.kv as KvFake).get = ((key: string, options: unknown) => {
      if (key === kvKeys.flags()) {
        (h.kv as KvFake).calls.push({ method: "get", key });
        return held.promise;
      }
      return (realGet as (k: string, o: unknown) => Promise<unknown>)(key, options);
    }) as KvFake["get"];
    h.clock.advance(10_000);
    const answer = await h.callTool("report_outage", { symptom: "slow" });
    expect(answer.result).toMatchObject({ reports_in_window: 2 });
    expect(h.areas.reports[1]?.input.threshold).toBe(5);
    expect(flagsGets(h)).toBe(2);
    // The refresh has not settled and the call never timed out.
    expect(h.timers.pending().filter((e) => e.ms === 1_000)).toEqual([]);

    // With the refresh still in flight, another call starts no new read.
    h.clock.advance(5_000);
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(2);
  });
});

// ---------- the flags 10-second lifetime (T20) ----------

describe("report_outage flags lifetime", () => {
  it("the production flags lifetime is exactly 10 seconds", () => {
    // The harness's area cache is built with the literal 10_000; this pins
    // the production constant to that same literal, so a changed production
    // lifetime fails here instead of passing silently.
    expect(FLAG_CACHE_TTL_MS).toBe(10_000);
  });

  it("flags are read from KV at most once per 10 seconds per container, boundary included", async () => {
    const h = makeHarness({
      flagsDoc: { incident_threshold: 5, report_window_secs: 900, incident_eta_minutes: 60 },
    });
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(1);
    expect(h.areas.reports[0]?.input.threshold).toBe(5);

    // 9,999 ms later: still fresh, no KV read.
    h.clock.advance(9_999);
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(1);
    expect(h.areas.reports[1]?.input.threshold).toBe(5);

    // Exactly 10,000 ms after the write: the value is stale — the call
    // answers from it at once and starts one background read.
    h.clock.advance(1);
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(2);
    expect(h.areas.reports[2]?.input.threshold).toBe(5);
  });

  it("a missing key is an answer: the defaults become the last good value, read again only after the lifetime (T20)", async () => {
    const h = makeHarness({});
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(1);
    expect(h.areas.reports[0]?.input.threshold).toBe(3);
    h.clock.advance(5);
    await h.callTool("report_outage", { symptom: "slow" });
    // The parsed defaults are the last good value now: no second read.
    expect(flagsGets(h)).toBe(1);

    // Once the lifetime passes, one background read runs.
    h.clock.advance(10_000);
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(2);
  });

  it("a stored non-document parses to the defaults and becomes the last good value (T20)", async () => {
    const h = makeHarness({ flagsDoc: 42 });
    await h.callTool("report_outage", { symptom: "slow" });
    expect(h.areas.reports[0]?.input.threshold).toBe(3);
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(1);
  });

  it("a stored flags array parses to the defaults and becomes the last good value too (T20)", async () => {
    const h = makeHarness({ flagsDoc: [3, 1800, 240] });
    await h.callTool("report_outage", { symptom: "slow" });
    expect(h.areas.reports[0]?.input).toMatchObject({ threshold: 3, windowMs: 1_800_000 });
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(1);
  });

  it("a single bad flag falls back on its own; the document is still an answer worth keeping", async () => {
    const h = makeHarness({
      flagsDoc: { incident_threshold: "many", report_window_secs: 600, incident_eta_minutes: 120 },
    });
    await h.callTool("report_outage", { symptom: "slow" });
    expect(h.areas.reports[0]?.input).toMatchObject({
      threshold: 3,
      windowMs: 600_000,
      etaMs: 7_200_000,
    });
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsGets(h)).toBe(1);
  });

  it("writes one flags_read line per settled flags read, and none while no read has run (T20)", async () => {
    const h = makeHarness({
      flagsDoc: { incident_threshold: 5, report_window_secs: 900, incident_eta_minutes: 60 },
    });
    const flagsReadLines = (): Record<string, unknown>[] =>
      h.lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.event === "flags_read");

    // No call yet: no read ever ran.
    expect(flagsReadLines()).toEqual([]);
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsReadLines()).toHaveLength(1);
    expect(flagsReadLines()[0]).toMatchObject({
      svc: "voice-tools",
      event: "flags_read",
      outcome: "ok",
    });
    const latency = flagsReadLines()[0]?.latency_ms as Record<string, unknown>;
    expect(typeof latency.total).toBe("number");
    expect(latency.kv).toBe(latency.total);

    // Within the lifetime there is no new read, so no new line.
    await h.callTool("report_outage", { symptom: "slow" });
    expect(flagsReadLines()).toHaveLength(1);
  });
});

// ---------- create_ticket ----------

describe("create_ticket", () => {
  it("a verified caller's repair visit goes to their own account's actor with the <sid>/<category> dedupe key", async () => {
    const h = makeHarness({ session: makeSession({ identity: "verified" }) });
    h.accounts.ticketResult = { ticketId: "T-4242", created: true, window: T0_WINDOW };
    const answer = await h.callTool("create_ticket", {
      category: "repair_visit",
      summary: "The fibre is cut in the garden.",
    });
    expect(answer.result).toEqual({ ticket_id: "T-4242", window: T0_WINDOW });
    // The actor reached is the session's account and nothing else: the tool
    // input has no account field, so one session can never reach another
    // account, whatever the model says.
    expect(h.accounts.tickets).toEqual([
      {
        accountNumber: "DV-100002",
        input: {
          dedupeKey: `${SID}/repair_visit`,
          category: "repair_visit",
          summary: "The fibre is cut in the garden.",
          nowMs: T0,
        },
        traceId: TRACE_ID,
      },
    ]);
    expect(callbackPuts(h)).toEqual([]);
    expect(answer.logLine).toMatchObject({
      tool: "create_ticket",
      node: "repair_ticket",
      outcome: "ok",
    });
  });

  it("an attested caller books a repair visit too", async () => {
    const h = makeHarness({ session: makeSession({ identity: "attested" }) });
    const answer = await h.callTool("create_ticket", {
      category: "repair_visit",
      summary: "Technician needed.",
    });
    expect(answer.result).toEqual({ ticket_id: "T-4242", window: T0_WINDOW });
    expect(h.accounts.tickets).toHaveLength(1);
  });

  it("a dedupe hit returns the existing ticket id and window unchanged", async () => {
    const h = makeHarness({ session: makeSession({ identity: "verified" }) });
    h.accounts.ticketResult = { ticketId: "T-0009", created: false, window: "2020-09-15 08:00-12:00" };
    const answer = await h.callTool("create_ticket", {
      category: "repair_visit",
      summary: "Same call, retried by the model.",
    });
    expect(answer.result).toEqual({ ticket_id: "T-0009", window: "2020-09-15 08:00-12:00" });
  });

  it("number_match gets needs_verification for a repair visit and no actor is created", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    const answer = await h.callTool("create_ticket", {
      category: "repair_visit",
      summary: "My internet is down.",
    });
    expect(answer.result).toEqual({ needs_verification: true });
    expect(h.accounts.tickets).toEqual([]);
    expect(kvCalls(h)).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "ok" });
  });

  it("anonymous gets needs_verification for an 'other' ticket", async () => {
    const h = makeHarness({
      session: makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null }),
    });
    const answer = await h.callTool("create_ticket", {
      category: "other",
      summary: "Billing question.",
    });
    expect(answer.result).toEqual({ needs_verification: true });
    expect(h.accounts.tickets).toEqual([]);
  });

  it("the summary boundary: exactly 300 characters runs, 301 is an isError result naming the argument", async () => {
    const h = makeHarness({ session: makeSession({ identity: "verified" }) });
    const atLimit = await h.callTool("create_ticket", {
      category: "repair_visit",
      summary: "x".repeat(300),
    });
    expect(atLimit.rpcError).toBeNull();
    expect(atLimit.result).toMatchObject({ ticket_id: "T-4242" });

    const pastLimit = await h.callTool("create_ticket", {
      category: "repair_visit",
      summary: "x".repeat(301),
    });
    expect(pastLimit.rpcError).toBeNull();
    expect(pastLimit.isErrorText).toBe("summary must be at most 300 characters.");
    expect(pastLimit.result).toBeNull();
    expect(pastLimit.logLine).toMatchObject({ outcome: "error", tool: "create_ticket" });
    expect(h.accounts.tickets).toHaveLength(1);
  });

  it("a held CUSTOMER_ACCOUNT.createTicket times out at exactly 1,000 ms; the late answer is absorbed", async () => {
    const h = makeHarness({ session: makeSession({ identity: "verified" }) });
    h.accounts.heldTicket = hold<CreateTicketResult>();
    const pending = h.callTool("create_ticket", {
      category: "repair_visit",
      summary: "The fibre is cut.",
    });
    await tick();
    const timer = h.timers.pending().find((e) => e.ms === 1_000);
    expect(timer).toBeDefined();
    timer?.fire();
    const answer = await pending;
    expect(answer.isErrorText).toBe("The ticket system is not responding right now.");
    h.accounts.heldTicket.resolve({ ticketId: "T-4242", created: true, window: T0_WINDOW });
    await tick();
  });

  it("a callback from a caller with an account is a ticket on that account, not a KV write", async () => {
    const h = makeHarness({ session: makeSession({ identity: "number_match" }) });
    const answer = await h.callTool("create_ticket", {
      category: "callback",
      summary: "Please call me back about the bill.",
    });
    expect(answer.result).toEqual({ ticket_id: "T-4242", window: T0_WINDOW });
    expect(h.accounts.tickets[0]?.input).toMatchObject({
      dedupeKey: `${SID}/callback`,
      category: "callback",
    });
    expect(callbackPuts(h)).toEqual([]);
  });
});

describe("create_ticket anonymous callback", () => {
  const anonSession = (): SessionDoc =>
    makeSession({ identity: "anonymous", accountNumber: null, postcode: null, lineId: null });

  it("writes callback/<sid> with the phone, summary, id and window, for seven days", async () => {
    const h = makeHarness({ session: anonSession() });
    const answer = await h.callTool("create_ticket", {
      category: "callback",
      summary: "Please call me back about moving my connection.",
    });
    // T- plus four digits derived from the sid: 0xEEEEEEEE % 10_000 = 6142.
    expect(callbackTicketId(SID)).toBe("T-6142");
    // The window helper is the actor's own: next working day 08:00-12:00.
    expect(nextWorkingDayWindow(T0)).toBe(T0_WINDOW);
    expect(answer.result).toEqual({ ticket_id: "T-6142", window: T0_WINDOW });

    const puts = callbackPuts(h);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe(`callback/${SID}`);
    expect(puts[0]?.options).toMatchObject({ expirationTtl: 604_800 });
    const stored = (await (h.kv as KvFake).get(`callback/${SID}`)) as string;
    expect(JSON.parse(stored)).toEqual({
      phone: "+32491244713",
      summary: "Please call me back about moving my connection.",
      ticketId: "T-6142",
      window: T0_WINDOW,
    });
    // A callback is a no-account path: no actor and no flags are touched.
    expect(h.accounts.tickets).toEqual([]);
    expect(h.areas.reports).toEqual([]);
    expect(answer.logLine).toMatchObject({ outcome: "ok", tool: "create_ticket" });
  });

  it("a repeat for the same call gives the same id and overwrites the same key, without a read", async () => {
    const h = makeHarness({ session: anonSession() });
    const first = await h.callTool("create_ticket", {
      category: "callback",
      summary: "Call me back.",
    });
    const second = await h.callTool("create_ticket", {
      category: "callback",
      summary: "Call me back.",
    });
    expect(first.result).toEqual(second.result);
    expect(callbackPuts(h).map((c) => c.key)).toEqual([`callback/${SID}`, `callback/${SID}`]);
    // Idempotent per sid without a read: the only KV traffic is the writes.
    expect(kvCalls(h).filter((c) => c.method === "get")).toEqual([]);
  });

  it("a held KV write times out at exactly 2,500 ms; the late write settles quietly", async () => {
    const h = makeHarness({ session: anonSession() });
    const held = hold<void>();
    const kv = h.kv as KvFake;
    const realPut = kv.put.bind(kv);
    kv.put = ((key: string, value: string, options?: unknown) => {
      if (key.startsWith("callback/")) {
        kv.calls.push({ method: "put", key, options: options as never });
        return held.promise;
      }
      return realPut(key, value, options as never);
    }) as KvFake["put"];

    const pending = h.callTool("create_ticket", {
      category: "callback",
      summary: "Call me back.",
    });
    await tick();
    const timer = h.timers.pending().find((e) => e.ms === 2_500);
    expect(timer).toBeDefined();
    timer?.fire();
    const answer = await pending;
    expect(answer.isErrorText).toBe("The ticket system is not responding right now.");
    expect(answer.logLine).toMatchObject({ outcome: "error" });
    held.resolve();
    await tick();
  });

  it("without a KV binding (telnyx-edge dev) the callback fails closed as a sayable sentence", async () => {
    const h = makeHarness({ session: anonSession(), kvOff: true });
    const answer = await h.callTool("create_ticket", {
      category: "callback",
      summary: "Call me back.",
    });
    expect(answer.isErrorText).toBe("The ticket system is not responding right now.");
    expect(h.accounts.tickets).toEqual([]);
  });

  it("a broken clock writes no broken window: the failure sentence with isError, and nothing stored", async () => {
    // Time inputs fail closed: a non-finite now() must never let a
    // "NaN-NaN-NaN 08:00-12:00" window into callback/<sid>. Called directly,
    // the way the actor tests drive a broken clock at one seam (a whole
    // MCP request never gets here — the token check fails closed first).
    const h = makeHarness({ session: anonSession(), now: () => Number.NaN });
    const session = anonSession();
    const res = await handleCreateTicket(
      { session, deps: h.deps, timings: startTimings(h.deps.now) },
      { category: "callback", summary: "Call me back." },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("The ticket system is not responding right now.");
    expect(callbackPuts(h)).toEqual([]);
    expect(h.accounts.tickets).toEqual([]);
  });
});
