import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { KvNamespace } from "@telnyx/edge-runtime";

import { AREAS, createLogger, kvKeys, parseKey } from "@duinvezel/shared";
import type {
  CreateSessionInput,
  CreateSessionResult,
  SetVerifiedResult,
  VerifyFailureResult,
} from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import type { ClockFake } from "../../../packages/shared/test/fakes/clock.js";

import type { AreaReportInput, AreaResetInput } from "../src/actors/area-incident.js";
import type { AccountsClient } from "../src/clients/accounts.js";
import type { AreasClient } from "../src/clients/areas.js";
import type { CrmClient } from "../src/clients/crm.js";
import type { SessionsClient } from "../src/clients/sessions.js";
import { TIMED_OUT } from "../src/config.js";
import type { TimeoutRunner } from "../src/config.js";
import type { CachesDep, SecretsDep, VoiceToolsDeps } from "../src/deps.js";
import type { CreateTicketResult, VerifyResult } from "../src/domain/customer-account.js";
import type { ReportResult, ResetResult } from "../src/domain/area-incident.js";
import { createFlagsValue } from "../src/flags.js";
import { createMemoryCache } from "@duinvezel/shared";
import {
  handleDemoFlagsGet,
  handleDemoFlagsPut,
  handleDemoReports,
  handleDemoReset,
} from "../src/routes/internal-demo.js";

// ---------- shared constants (keys generated per run, never committed) ----------

const T0 = 1_600_000_000_000;
/** The request-time stamp the reporter ids and trace ids carry. */
const STAMP = T0.toString(36);
const INTERNAL_KEY = randomBytes(16).toString("hex");
const OTHER_INTERNAL_KEY = randomBytes(16).toString("hex");

const FLAG_KEY = kvKeys.flags();

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

/**
 * A KV the test fully controls: the `flags/global` document as JSON text,
 * recorded calls, and calls the test can fail or hold. Stands in for the
 * real binding, so the harness needs no fake at all.
 */
class DemoKv {
  readonly calls: { method: "get" | "put"; key?: string }[] = [];
  doc: string | null = null;
  failGet = false;
  failPut = false;
  heldGet: HeldPromise<unknown> | null = null;
  heldPut: HeldPromise<void> | null = null;

  get(key: string): Promise<unknown> {
    this.calls.push({ method: "get", key });
    if (this.heldGet !== null) {
      return this.heldGet.promise;
    }
    if (this.failGet) {
      return Promise.reject(new Error("kv down"));
    }
    return Promise.resolve(this.doc === null ? null : (JSON.parse(this.doc) as unknown));
  }

  put(key: string, value: string): Promise<void> {
    this.calls.push({ method: "put", key });
    if (this.heldPut !== null) {
      return this.heldPut.promise;
    }
    if (this.failPut) {
      return Promise.reject(new Error("kv down"));
    }
    this.doc = value;
    return Promise.resolve();
  }

  puts(): { method: "get" | "put"; key?: string }[] {
    return this.calls.filter((c) => c.method === "put");
  }
}

class AccountsStub implements AccountsClient {
  readonly resets: { accountNumber: string; traceId: string }[] = [];
  failOn: string | null = null;
  heldOn = new Map<string, HeldPromise<void>>();

  verify(): Promise<VerifyResult> {
    return Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.verify"));
  }

  createTicket(): Promise<CreateTicketResult> {
    return Promise.reject(new Error("unexpected CUSTOMER_ACCOUNT.createTicket"));
  }

  reset(accountNumber: string, traceId: string): Promise<void> {
    this.resets.push({ accountNumber, traceId });
    const held = this.heldOn.get(accountNumber);
    if (held !== undefined) {
      return held.promise;
    }
    return accountNumber === this.failOn
      ? Promise.reject(new Error("actor sidecar down"))
      : Promise.resolve();
  }
}

class AreasStub implements AreasClient {
  readonly reports: { postcode: string; input: AreaReportInput }[] = [];
  readonly resets: { postcode: string; input: AreaResetInput }[] = [];
  reportResult: ReportResult = {
    reportsInWindow: 1,
    threshold: 3,
    counted: true,
    incidentDeclared: false,
    incidentId: null,
    eta: null,
  };
  /** The 1-based report call that fails or hangs, if any. */
  failOnCall: number | null = null;
  heldOnCall: number | null = null;
  heldReport: HeldPromise<ReportResult> | null = null;
  failResetOn: string | null = null;
  heldResetOn = new Map<string, HeldPromise<ResetResult>>();

  report(postcode: string, input: AreaReportInput): Promise<ReportResult> {
    this.reports.push({ postcode, input });
    const n = this.reports.length;
    if (this.heldOnCall === n && this.heldReport !== null) {
      return this.heldReport.promise;
    }
    if (this.failOnCall === n) {
      return Promise.reject(new Error("actor sidecar down"));
    }
    return Promise.resolve(this.reportResult);
  }

  reset(postcode: string, input: AreaResetInput): Promise<ResetResult> {
    this.resets.push({ postcode, input });
    const held = this.heldResetOn.get(postcode);
    if (held !== undefined) {
      return held.promise;
    }
    return postcode === this.failResetOn
      ? Promise.reject(new Error("actor sidecar down"))
      : Promise.resolve({ version: 1 });
  }
}

/** The demo routes never reach these; any call is a bug. */
const sessionsNever: SessionsClient = {
  create(_sid: string, _input: CreateSessionInput): Promise<CreateSessionResult> {
    return Promise.reject(new Error("unexpected SESSION.create"));
  },
  get(): Promise<never> {
    return Promise.reject(new Error("unexpected SESSION.get"));
  },
  setVerified(): Promise<SetVerifiedResult> {
    return Promise.reject(new Error("unexpected SESSION.setVerified"));
  },
  recordVerifyFailure(): Promise<VerifyFailureResult> {
    return Promise.reject(new Error("unexpected SESSION.recordVerifyFailure"));
  },
};

const crmNever: CrmClient = {
  testLine: () => Promise.reject(new Error("unexpected mock-crm line test")),
  getAccount: () => Promise.reject(new Error("unexpected mock-crm GET /accounts")),
};

class SecretsStub implements SecretsDep {
  readonly reads: string[] = [];

  constructor(readonly values: Record<string, string | null>) {}

  get(handle: string): Promise<string | null> {
    this.reads.push(handle);
    return Promise.resolve(this.values[handle] ?? null);
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

interface Answer {
  status: number;
  body: unknown;
}

interface Harness {
  deps: VoiceToolsDeps;
  clock: ClockFake;
  timers: ManualTimers;
  kv: DemoKv;
  accounts: AccountsStub;
  areas: AreasStub;
  secrets: SecretsStub;
  lines: string[];
  getFlags(options?: { key?: string | null }): Promise<Answer>;
  putFlags(body: string, options?: { key?: string | null }): Promise<Answer>;
  postReports(body: unknown, options?: { key?: string | null }): Promise<Answer>;
  postReset(options?: { key?: string | null }): Promise<Answer>;
  lastLog(): Record<string, unknown>;
}

function makeHarness(): Harness {
  const clock = createClockFake(T0);
  const timers = new ManualTimers();
  const kv = new DemoKv();
  const accounts = new AccountsStub();
  const areas = new AreasStub();
  const secrets = new SecretsStub({ INTERNAL_KEY });
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
  // The container's refreshing flags value, fresh per test, over the
  // controllable KV — the reports route reads its incident inputs from it.
  const flagsValue = createFlagsValue({
    kv: () => kv as unknown as KvNamespace,
    now: clock.now,
    timeout: timers.runner,
  });
  const deps: VoiceToolsDeps = {
    now: clock.now,
    kv: kv as unknown as KvNamespace,
    sessions: sessionsNever,
    crm: crmNever,
    accounts,
    areas,
    caches,
    flagsValue,
    secrets,
    log,
    random: (n) => randomBytes(n),
    timeout: timers.runner,
  };

  async function call(
    handler: (req: Request, deps: VoiceToolsDeps) => Promise<Response>,
    method: string,
    path: string,
    options: { key?: string | null; body?: string },
  ): Promise<Answer> {
    const headers = new Headers();
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const key = options.key === undefined ? INTERNAL_KEY : options.key;
    if (key !== null) {
      headers.set("x-internal-key", key);
    }
    const res = await handler(
      new Request(`http://x.test${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
      }),
      deps,
    );
    return { status: res.status, body: await res.json() };
  }

  return {
    deps,
    clock,
    timers,
    kv,
    accounts,
    areas,
    secrets,
    lines,
    getFlags(options = {}) {
      return call(handleDemoFlagsGet, "GET", "/internal/demo/flags", options);
    },
    putFlags(body, options = {}) {
      return call(handleDemoFlagsPut, "PUT", "/internal/demo/flags", { ...options, body });
    },
    postReports(body, options = {}) {
      return call(handleDemoReports, "POST", "/internal/demo/reports", {
        ...options,
        body: JSON.stringify(body),
      });
    },
    postReset(options = {}) {
      return call(handleDemoReset, "POST", "/internal/demo/reset", options);
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

describe("/internal/demo auth", () => {
  const endpoints: { name: string; run: (h: Harness) => Promise<Answer> }[] = [
    { name: "GET flags", run: (h) => h.getFlags({ key: null }) },
    { name: "PUT flags", run: (h) => h.putFlags("{}", { key: null }) },
    { name: "POST reports", run: (h) => h.postReports({ postcode: "8670", count: 1 }, { key: null }) },
    { name: "POST reset", run: (h) => h.postReset({ key: null }) },
  ];

  for (const endpoint of endpoints) {
    it(`a missing key on ${endpoint.name}: 401 before any KV or actor access`, async () => {
      const h = makeHarness();
      const res = await endpoint.run(h);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "unauthorized" });
      expect(h.kv.calls).toEqual([]);
      expect(h.accounts.resets).toEqual([]);
      expect(h.areas.reports).toEqual([]);
      expect(h.areas.resets).toEqual([]);
      expect(h.secrets.reads).toEqual(["INTERNAL_KEY"]);
      expect(h.lastLog()).toMatchObject({
        event: "auth_failed",
        route: "internal_demo",
        reason: "bad_key",
        status: 401,
      });
    });
  }

  it("a wrong key: 401 before any KV or actor access", async () => {
    const h = makeHarness();
    const res = await h.postReset({ key: OTHER_INTERNAL_KEY });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(h.kv.calls).toEqual([]);
    expect(h.accounts.resets).toEqual([]);
  });

  it("an unreadable INTERNAL_KEY fails closed: 401 no_key", async () => {
    const h = makeHarness();
    h.secrets.values.INTERNAL_KEY = null;
    const res = await h.getFlags({});
    expect(res.status).toBe(401);
    expect(h.kv.calls).toEqual([]);
    expect(h.lastLog()).toMatchObject({ event: "auth_failed", reason: "no_key", status: 401 });
  });
});

// ---------- GET /internal/demo/flags ----------

describe("GET /internal/demo/flags", () => {
  it("answers {} when there is no stored document", async () => {
    const h = makeHarness();
    const res = await h.getFlags();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(h.kv.calls).toEqual([{ method: "get", key: FLAG_KEY }]);
    expect(h.lastLog()).toMatchObject({
      event: "internal_demo",
      route: "flags",
      outcome: "ok",
      status: 200,
    });
  });

  it("answers the stored document as-is", async () => {
    const h = makeHarness();
    h.kv.doc = JSON.stringify({ crm_fail: true, incident_threshold: 5 });
    const res = await h.getFlags();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ crm_fail: true, incident_threshold: 5 });
  });

  it("a failed read answers 503", async () => {
    const h = makeHarness();
    h.kv.failGet = true;
    const res = await h.getFlags();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "unavailable" });
    expect(h.lastLog()).toMatchObject({ outcome: "kv_error", status: 503 });
  });

  it("a held read is cut at exactly 5,000 ms with a 503, and the late answer is absorbed", async () => {
    const h = makeHarness();
    const held = hold<unknown>();
    h.kv.heldGet = held;
    const pending = h.getFlags();
    await tick();
    const timer = h.timers.pending().find((e) => e.ms === 5_000);
    expect(timer).toBeDefined();
    timer?.fire();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "unavailable" });
    held.resolve({ crm_fail: true });
    await tick();
  });
});

// ---------- PUT /internal/demo/flags ----------

describe("PUT /internal/demo/flags", () => {
  it("merges into the stored document, answers it and writes it back", async () => {
    const h = makeHarness();
    h.kv.doc = JSON.stringify({ crm_fail: true, incident_threshold: 3 });
    const res = await h.putFlags(JSON.stringify({ incident_threshold: 5 }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ crm_fail: true, incident_threshold: 5 });
    expect(JSON.parse(h.kv.doc as string)).toEqual({ crm_fail: true, incident_threshold: 5 });
    expect(h.lastLog()).toMatchObject({ outcome: "ok", status: 200, route: "flags" });
  });

  it("null removes a key, which brings back its default", async () => {
    const h = makeHarness();
    h.kv.doc = JSON.stringify({ crm_fail: true, diagnostics_enabled: false });
    const res = await h.putFlags(JSON.stringify({ crm_fail: null }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ diagnostics_enabled: false });
    expect(JSON.parse(h.kv.doc as string)).toEqual({ diagnostics_enabled: false });
  });

  it("sets a flag on an empty store", async () => {
    const h = makeHarness();
    const res = await h.putFlags(JSON.stringify({ diagnostics_enabled: false }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ diagnostics_enabled: false });
    expect(JSON.parse(h.kv.doc as string)).toEqual({ diagnostics_enabled: false });
  });

  it("a stored value that is not a JSON object counts as {}", async () => {
    const h = makeHarness();
    h.kv.doc = JSON.stringify("not an object");
    const res = await h.putFlags(JSON.stringify({ incident_threshold: 2 }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ incident_threshold: 2 });
  });

  it("accepts the boundaries: crm_delay_ms 0 and the integer flags 1", async () => {
    const h = makeHarness();
    const res = await h.putFlags(
      JSON.stringify({
        crm_delay_ms: 0,
        incident_threshold: 1,
        report_window_secs: 1,
        incident_eta_minutes: 1,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      crm_delay_ms: 0,
      incident_threshold: 1,
      report_window_secs: 1,
      incident_eta_minutes: 1,
    });
  });

  it.each([
    ["an unknown key", { dv_debug: true }],
    ["crm_delay_ms below 0", { crm_delay_ms: -1 }],
    ["a non-boolean toggle", { crm_fail: "yes" }],
    ["an integer flag of 0", { incident_threshold: 0 }],
    ["a non-integer threshold", { incident_threshold: 2.5 }],
    ["a non-number delay", { crm_delay_ms: "0" }],
  ])("%s answers 400 and writes nothing", async (_name, patch) => {
    const h = makeHarness();
    h.kv.doc = JSON.stringify({ crm_fail: true });
    const res = await h.putFlags(JSON.stringify(patch));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad_request" });
    expect(h.kv.puts()).toEqual([]);
    // The stored document is untouched.
    expect(JSON.parse(h.kv.doc as string)).toEqual({ crm_fail: true });
  });

  it("a body that is not a JSON object answers 400 and writes nothing", async () => {
    const h = makeHarness();
    const res = await h.putFlags("[1, 2]");
    expect(res.status).toBe(400);
    expect(h.kv.puts()).toEqual([]);
  });

  it("a failed read answers 503 and writes nothing", async () => {
    const h = makeHarness();
    h.kv.failGet = true;
    const res = await h.putFlags(JSON.stringify({ incident_threshold: 5 }));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "unavailable" });
    expect(h.kv.puts()).toEqual([]);
    expect(h.lastLog()).toMatchObject({ outcome: "kv_error", status: 503 });
  });

  it("a failed write answers 503", async () => {
    const h = makeHarness();
    h.kv.failPut = true;
    const res = await h.putFlags(JSON.stringify({ incident_threshold: 5 }));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "unavailable" });
  });

  it("a held write is cut at exactly 5,000 ms with a 503, and the late answer is absorbed", async () => {
    const h = makeHarness();
    const held = hold<void>();
    h.kv.heldPut = held;
    const pending = h.putFlags(JSON.stringify({ incident_threshold: 5 }));
    await tick();
    const timer = h.timers.pending().find((e) => e.ms === 5_000);
    expect(timer).toBeDefined();
    timer?.fire();
    const res = await pending;
    expect(res.status).toBe(503);
    held.resolve(undefined);
    await tick();
  });
});

// ---------- POST /internal/demo/reports ----------

describe("POST /internal/demo/reports", () => {
  it("count 1: one report as SIM-1-<time>, with the current flags' incident inputs and the default symptom", async () => {
    const h = makeHarness();
    h.kv.doc = JSON.stringify({
      incident_threshold: 5,
      report_window_secs: 60,
      incident_eta_minutes: 30,
    });
    const res = await h.postReports({ postcode: "8670", count: 1 });
    expect(res.status).toBe(200);
    expect(h.areas.reports).toEqual([
      {
        postcode: "8670",
        input: {
          accountId: `SIM-1-${STAMP}`,
          symptom: "no_connection",
          nowMs: T0,
          threshold: 5,
          windowMs: 60_000,
          etaMs: 30 * 60_000,
          traceId: `demo-${STAMP}`,
        },
      },
    ]);
    expect(res.body).toEqual({
      results: [
        {
          reports_in_window: 1,
          threshold: 3,
          counted: true,
          incident_declared: false,
          incident_id: null,
          eta: null,
        },
      ],
    });
    expect(h.lastLog()).toMatchObject({
      event: "internal_demo",
      route: "reports",
      outcome: "ok",
      status: 200,
      trace_id: `demo-${STAMP}`,
    });
  });

  it("count 10: ten reports in order, SIM-1 to SIM-10, with a set symptom and the results in order", async () => {
    const h = makeHarness();
    const res = await h.postReports({ postcode: "8670", count: 10, symptom: "slow" });
    expect(res.status).toBe(200);
    expect(h.areas.reports).toHaveLength(10);
    h.areas.reports.forEach((call, index) => {
      expect(call.input.accountId).toBe(`SIM-${String(index + 1)}-${STAMP}`);
      expect(call.input.symptom).toBe("slow");
      expect(call.input.traceId).toBe(`demo-${STAMP}`);
    });
    const body = res.body as { results: unknown[] };
    expect(body.results).toHaveLength(10);
  });

  it.each([0, 11])("count %s answers 400 before any actor call", async (count) => {
    const h = makeHarness();
    const res = await h.postReports({ postcode: "8670", count });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad_request" });
    expect(h.areas.reports).toEqual([]);
  });

  it.each(["9999", "1234", "867"])("postcode %s outside the five areas answers 400", async (postcode) => {
    const h = makeHarness();
    const res = await h.postReports({ postcode, count: 1 });
    expect(res.status).toBe(400);
    expect(h.areas.reports).toEqual([]);
  });

  it("reporter ids differ between two runs, so a second run is not deduped against the first", async () => {
    const h = makeHarness();
    const first = await h.postReports({ postcode: "8670", count: 1 });
    expect(first.status).toBe(200);
    h.clock.advance(1_000);
    const second = await h.postReports({ postcode: "8670", count: 1 });
    expect(second.status).toBe(200);
    const one = h.areas.reports[0]?.input.accountId;
    const two = h.areas.reports[1]?.input.accountId;
    expect(one).toBe(`SIM-1-${STAMP}`);
    expect(two).toBe(`SIM-1-${(T0 + 1_000).toString(36)}`);
    expect(two).not.toBe(one);
    expect(h.areas.reports[1]?.input.traceId).toBe(`demo-${(T0 + 1_000).toString(36)}`);
  });

  it("a failed report stops the run and answers 503 with the results so far", async () => {
    const h = makeHarness();
    h.areas.failOnCall = 2;
    const res = await h.postReports({ postcode: "8670", count: 3 });
    expect(res.status).toBe(503);
    expect(h.areas.reports).toHaveLength(2);
    const body = res.body as { results: unknown[] };
    expect(body.results).toHaveLength(1);
    expect(h.lastLog()).toMatchObject({ outcome: "report_error", status: 503 });
  });

  it("a held report is cut at exactly 2,000 ms: 503 with the results so far, the late answer absorbed", async () => {
    const h = makeHarness();
    const held = hold<ReportResult>();
    h.areas.heldOnCall = 2;
    h.areas.heldReport = held;
    const pending = h.postReports({ postcode: "8670", count: 2 });
    await tick();
    const timer = h.timers.pending().find((e) => e.ms === 2_000);
    expect(timer).toBeDefined();
    timer?.fire();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(h.areas.reports).toHaveLength(2);
    const body = res.body as { results: unknown[] };
    expect(body.results).toHaveLength(1);
    expect(h.lastLog()).toMatchObject({ outcome: "report_unavailable", status: 503 });
    held.resolve(h.areas.reportResult);
    await tick();
  });
});

// ---------- POST /internal/demo/reset ----------

const EIGHT_ACCOUNTS = Array.from({ length: 8 }, (_, i) => `DV-10000${String(i + 1)}`);

describe("POST /internal/demo/reset", () => {
  it("resets the eight fixture accounts and the five areas in parallel and answers 200", async () => {
    const h = makeHarness();
    const res = await h.postReset();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accounts: Object.fromEntries(EIGHT_ACCOUNTS.map((a) => [a, "ok"])),
      areas: Object.fromEntries(AREAS.map((area) => [area.postcode, "ok"])),
    });
    expect(h.accounts.resets.map((r) => r.accountNumber).sort()).toEqual(EIGHT_ACCOUNTS);
    for (const call of h.accounts.resets) {
      expect(call.traceId).toBe(`demo-${STAMP}`);
    }
    expect(h.areas.resets.map((r) => r.postcode).sort()).toEqual(
      AREAS.map((area) => area.postcode).sort(),
    );
    for (const call of h.areas.resets) {
      expect(call.input).toEqual({ nowMs: T0, traceId: `demo-${STAMP}` });
    }
    expect(h.lastLog()).toMatchObject({
      event: "internal_demo",
      route: "reset",
      outcome: "ok",
      status: 200,
      trace_id: `demo-${STAMP}`,
    });
  });

  it("carries on after one instance fails and answers 500 with error just for it", async () => {
    const h = makeHarness();
    h.accounts.failOn = "DV-100004";
    const res = await h.postReset();
    expect(res.status).toBe(500);
    const body = res.body as { accounts: Record<string, string>; areas: Record<string, string> };
    expect(body.accounts["DV-100004"]).toBe("error");
    for (const account of EIGHT_ACCOUNTS.filter((a) => a !== "DV-100004")) {
      expect(body.accounts[account]).toBe("ok");
    }
    for (const area of AREAS) {
      expect(body.areas[area.postcode]).toBe("ok");
    }
    // Every instance was still called: a failure does not stop the others.
    expect(h.accounts.resets).toHaveLength(8);
    expect(h.areas.resets).toHaveLength(5);
    expect(h.lastLog()).toMatchObject({ outcome: "error", status: 500 });
  });

  it("a failing area is an error just for it", async () => {
    const h = makeHarness();
    h.areas.failResetOn = "8670";
    const res = await h.postReset();
    expect(res.status).toBe(500);
    const body = res.body as { accounts: Record<string, string>; areas: Record<string, string> };
    expect(body.areas["8670"]).toBe("error");
    expect(Object.values(body.accounts).every((v) => v === "ok")).toBe(true);
  });

  it("a held reset is cut at exactly 2,000 ms: error for it, 500 overall, the late answer absorbed", async () => {
    const h = makeHarness();
    const held = hold<ResetResult>();
    h.areas.heldResetOn.set("8630", held);
    const pending = h.postReset();
    await tick();
    // The held call is the only pending timer; the twelve settled ones are done.
    const pendingTimers = h.timers.pending();
    expect(pendingTimers).toHaveLength(1);
    expect(pendingTimers[0]?.ms).toBe(2_000);
    pendingTimers[0]?.fire();
    const res = await pending;
    expect(res.status).toBe(500);
    const body = res.body as { accounts: Record<string, string>; areas: Record<string, string> };
    expect(body.areas["8630"]).toBe("error");
    expect(Object.values(body.accounts).every((v) => v === "ok")).toBe(true);
    expect(h.areas.resets).toHaveLength(5);
    held.resolve({ version: 2 });
    await tick();
  });
});
