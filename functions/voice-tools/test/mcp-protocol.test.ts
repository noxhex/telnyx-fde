import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ActorNamespace } from "@telnyx/edge-runtime";

import { mintSessionToken, parseKey } from "@duinvezel/shared";
import type {
  CreateSessionInput,
  CreateSessionResult,
  SessionDoc,
  SetVerifiedResult,
  VerifyFailureResult,
} from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import type { ClockFake } from "../../../packages/shared/test/fakes/clock.js";

import { TIMED_OUT } from "../src/config.js";
import type { TimeoutRunner } from "../src/config.js";
import type { AccountsClient } from "../src/clients/accounts.js";
import type { AreasClient } from "../src/clients/areas.js";
import type { SessionsClient } from "../src/clients/sessions.js";
import type { CrmClient } from "../src/clients/crm.js";
import type { CachesDep, SecretsDep, VoiceToolsDeps } from "../src/deps.js";
import handler from "../src/index.js";
import type { VoiceToolsEnv } from "../src/index.js";
import { handleMcp } from "../src/routes/mcp.js";
import { createLogger, createMemoryCache } from "@duinvezel/shared";

// ---------- shared constants (keys generated per run, never committed) ----------

const T0 = 1_600_000_000_000;
const TOKEN_KEY_RAW = randomBytes(32).toString("base64url");
const TOKEN_KEY = parseKey(TOKEN_KEY_RAW);
const SID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRACE_ID = "v3:test-trace:2026-10-10T09:00:00Z";

function liveSession(now: number): SessionDoc {
  return {
    v: 1,
    sid: SID,
    traceId: TRACE_ID,
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

// ---------- immediate timeout runner (nothing ever times out here) ----------

const immediateRunner: TimeoutRunner = <T>(fn: () => Promise<T>, _ms: number) =>
  Promise.resolve()
    .then(fn)
    .then(
      (value) => value,
      (error: unknown) => {
        throw error;
      },
    ) as Promise<T | typeof TIMED_OUT>;

// ---------- stubs ----------

class SessionsStub implements SessionsClient {
  readonly gets: string[] = [];
  session: SessionDoc | null = null;

  create(_sid: string, input: CreateSessionInput): Promise<CreateSessionResult> {
    throw new Error(`unexpected SESSION.create (${input.traceId})`);
  }

  get(sid: string, _input: { nowMs: number }): Promise<SessionDoc | null> {
    this.gets.push(sid);
    return Promise.resolve(this.session);
  }

  setVerified(): Promise<SetVerifiedResult> {
    throw new Error("unexpected SESSION.setVerified");
  }

  recordVerifyFailure(): Promise<VerifyFailureResult> {
    throw new Error("unexpected SESSION.recordVerifyFailure");
  }
}

/** Protocol tests run no state-changing tool logic; any call is a bug. */
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

interface Harness {
  deps: VoiceToolsDeps;
  clock: ClockFake;
  sessions: SessionsStub;
  secrets: SecretsStub;
  lines: string[];
  token: string;
  /** POSTs a JSON-RPC body to /mcp with a valid bearer token. */
  post(body: unknown, options?: { token?: string }): Promise<{ status: number; text: string }>;
  lastLog(): Record<string, unknown>;
}

function makeHarness(): Harness {
  const clock = createClockFake(T0);
  const sessions = new SessionsStub();
  sessions.session = liveSession(T0);
  const secrets = new SecretsStub({ MCP_TOKEN_KEY: TOKEN_KEY_RAW });
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
    timeout: immediateRunner,
  };
  const token = mintSessionToken({ sid: SID, exp: T0 + 7_200_000 }, TOKEN_KEY);
  return {
    deps,
    clock,
    sessions,
    secrets,
    lines,
    token,
    async post(body, options = {}) {
      const res = await handleMcp(
        new Request("http://x.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${options.token ?? token}`,
            "user-agent": "mcp-protocol-test",
          },
          body: JSON.stringify(body),
        }),
        deps,
      );
      return { status: res.status, text: await res.text() };
    },
    lastLog() {
      if (lines.length === 0) {
        throw new Error("no log lines captured");
      }
      return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    },
  };
}

function initializeBody(protocolVersion: string, id: number | string = 0): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    },
  };
}

// ---------- protocol negotiation ----------

describe("initialize version negotiation", () => {
  it.each(["2025-11-25", "2025-06-18", "2025-03-26"])(
    "echoes the supported version %s",
    async (version) => {
      const h = makeHarness();
      const res = await h.post(initializeBody(version));
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "voice-tools", version: "0.1.0" },
        },
        jsonrpc: "2.0",
        id: 0,
      });
    },
  );

  it.each(["2024-11-05", "9.9.9-future"])(
    "answers %s with the fallback 2025-06-18",
    async (version) => {
      const h = makeHarness();
      const res = await h.post(initializeBody(version));
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "voice-tools", version: "0.1.0" },
        },
        jsonrpc: "2.0",
        id: 0,
      });
    },
  );
});

// ---------- framing ----------

describe("MCP framing", () => {
  it("a notification gets 202 with no body", async () => {
    const h = makeHarness();
    const res = await h.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(res.text).toBe("");
  });

  it("ping gets an empty result", async () => {
    const h = makeHarness();
    const res = await h.post({ jsonrpc: "2.0", id: 9, method: "ping" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ result: {}, jsonrpc: "2.0", id: 9 });
  });

  it("an unknown method is error -32601, and the log line carries outcome error", async () => {
    const h = makeHarness();
    const res = await h.post({ jsonrpc: "2.0", id: 1, method: "bogus/method" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
    // HTTP said 200, but an answer carrying an error member is not ok.
    expect(h.lastLog()).toMatchObject({
      level: "error",
      event: "mcp",
      method: "bogus/method",
      outcome: "error",
      status: 200,
    });
  });

  it("invalid arguments are an isError tool result naming the argument (bad postcode)", async () => {
    const h = makeHarness();
    const res = await h.post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "check_area_status", arguments: { postcode: "86a0" } },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      result: {
        content: [{ type: "text", text: "postcode must be exactly four digits." }],
        isError: true,
      },
      jsonrpc: "2.0",
      id: 3,
    });
    // An isError result keeps the mcp log line at outcome error.
    expect(h.lastLog()).toMatchObject({
      event: "mcp",
      method: "tools/call",
      tool: "check_area_status",
      outcome: "error",
      status: 200,
    });
  });

  it("an argument a tool does not take is an isError result naming it", async () => {
    const h = makeHarness();
    const res = await h.post({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "run_line_diagnostics", arguments: { line_id: "LN-000002" } },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      result: {
        content: [{ type: "text", text: "line_id is not an argument of run_line_diagnostics." }],
        isError: true,
      },
      jsonrpc: "2.0",
      id: 8,
    });
    expect(h.lastLog()).toMatchObject({ outcome: "error", tool: "run_line_diagnostics" });
  });

  it("an unknown tool is error -32602", async () => {
    const h = makeHarness();
    const res = await h.post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32602, message: "MCP error -32602: Unknown tool: nope" },
    });
  });

  it("a batch of two pings gets the SDK's answer, pinned", async () => {
    const h = makeHarness();
    const res = await h.post([
      { jsonrpc: "2.0", id: 0, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: "ping" },
    ]);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual([
      { result: {}, jsonrpc: "2.0", id: 0 },
      { result: {}, jsonrpc: "2.0", id: 1 },
    ]);
    // No element carries an error member: the outcome stays ok.
    expect(h.lastLog()).toMatchObject({ event: "mcp", outcome: "ok", status: 200, batch_size: 2 });
  });

  it("a batch of notifications only gets 202 with no body", async () => {
    const h = makeHarness();
    const res = await h.post([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    ]);
    expect(res.status).toBe(202);
    expect(res.text).toBe("");
  });
});

// ---------- tools/list ----------

describe("tools/list", () => {
  it("returns the five tools in the card's order with input schemas", async () => {
    const h = makeHarness();
    const res = await h.post({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as {
      result: {
        tools: {
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
        }[];
      };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "verify_account",
      "check_area_status",
      "run_line_diagnostics",
      "report_outage",
      "create_ticket",
    ]);
    const [verify, area, diagnostics, outage, ticket] = body.result.tools;
    // Written for a voice model: each description says when to use the tool.
    // verify_account's and report_outage's are pinned word for word (T26).
    expect(verify?.description).toBe(
      "Verifies the caller's identity before anything that touches their account, such as " +
        "diagnostics or a repair ticket. Call it only once the caller has given every answer it " +
        "needs. That is the four-digit postcode, and the account number as well when the caller " +
        "was not recognised by phone number. If an answer is missing, ask the caller for it " +
        "first. It answers whether the caller is verified, how many attempts remain, or how " +
        "many minutes verification is locked after too many wrong answers. If it answers " +
        "account_number_needed or postcode_needed, ask for that answer and try again. If it " +
        "answers account_number_unclear or postcode_unclear, ask the caller to repeat that " +
        "answer one character at a time and try again. Never read out full account details " +
        "yourself.",
    );
    expect(area?.description).toContain("whenever the caller asks about an outage");
    expect(diagnostics?.description).toContain("internet is down, slow or unstable");
    expect(outage?.description).toBe(
      "Reports that the caller's own internet is down completely, so the engineers can see that " +
        "their area is affected. Use it only when the caller says their service is down completely " +
        "and has agreed to report it as an outage. Never use it for slow or dropping internet. It " +
        "answers whether the report was counted, whether it declared an incident, and the estimated " +
        "fix time. Only a caller recognised by phone number or verified can report. If the result " +
        "says needs_verification, verify the caller first.",
    );
    expect(ticket?.description).toContain("needs a technician");
    expect(verify?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        postcode: { type: "string", maxLength: 32 },
        account_number: { type: "string", maxLength: 32 },
      },
      required: ["postcode"],
      additionalProperties: false,
    });
    // The schema checks no format, so a spoken form reaches the cleaning;
    // the descriptions give the expected format instead.
    expect((verify?.inputSchema.properties as Record<string, { description?: string }>)
      .postcode?.description).toContain("four digits");
    expect((verify?.inputSchema.properties as Record<string, { description?: string }>)
      .account_number?.description).toContain("DV-");
    expect(area?.inputSchema).toMatchObject({
      type: "object",
      properties: { postcode: { type: "string", pattern: "^\\d{4}$" } },
      required: ["postcode"],
      additionalProperties: false,
    });
    expect(diagnostics?.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(outage?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        symptom: { type: "string", enum: ["no_connection", "slow", "intermittent", "other"] },
      },
      required: ["symptom"],
      additionalProperties: false,
    });
    expect(ticket?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        category: { type: "string", enum: ["repair_visit", "callback", "other"] },
        summary: { type: "string", maxLength: 300 },
      },
      required: ["category", "summary"],
      additionalProperties: false,
    });
  });

  it("publishes the three string properties exactly, so they cannot gain a number type (T10 follow-up)", async () => {
    const h = makeHarness();
    const res = await h.post({ jsonrpc: "2.0", id: 6, method: "tools/list" });
    const body = JSON.parse(res.text) as {
      result: {
        tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
      };
    };
    const byName = new Map(body.result.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("verify_account")?.inputSchema.properties).toEqual({
      postcode: {
        type: "string",
        maxLength: 32,
        description:
          "The caller's postcode. Expected format: four digits; spoken forms such as \"86 30\" or \"B-8630\" are cleaned by the tool.",
      },
      account_number: {
        type: "string",
        maxLength: 32,
        description:
          "The caller's account number. Expected format: DV- followed by six digits; spoken forms such as \"dv 100001\" or the six digits alone are cleaned by the tool.",
      },
    });
    expect(byName.get("check_area_status")?.inputSchema.properties).toEqual({
      postcode: { type: "string", pattern: "^\\d{4}$" },
    });
  });

  it("tools/call dispatches against the caller's session (outage answer)", async () => {
    const h = makeHarness();
    // Postcode 9999 is outside the five areas: a fixed answer, no KV needed.
    const res = await h.post({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "check_area_status", arguments: { postcode: "9999" } },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      result: {
        content: [{ type: "text", text: '{"area_name":null,"state":"unknown"}' }],
      },
      jsonrpc: "2.0",
      id: 6,
    });
  });
});

// ---------- the mcp log line ----------

describe("the mcp log line", () => {
  it("logs method, tool, node, trace id and identity for a tools/call", async () => {
    const h = makeHarness();
    await h.post({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "check_area_status", arguments: { postcode: "9999" } },
    });
    const log = h.lastLog();
    expect(log).toMatchObject({
      level: "info",
      svc: "voice-tools",
      event: "mcp",
      method: "tools/call",
      tool: "check_area_status",
      node: "verify_account",
      trace_id: TRACE_ID,
      identity: "attested",
      outcome: "ok",
      status: 200,
    });
    expect(typeof (log.latency_ms as Record<string, unknown>).total).toBe("number");
  });
});

// ---------- routing-level protocol cases ----------

describe("GET /mcp and unknown paths", () => {
  function devLikeEnv(): VoiceToolsEnv {
    const actorNamespace = (): ActorNamespace =>
      ({
        idFromName: () => {
          throw new Error("actors must not be reached by this route");
        },
      }) as unknown as ActorNamespace;
    return {
      CUSTOMER_ACCOUNT: actorNamespace(),
      AREA_INCIDENT: actorNamespace(),
      SESSION: actorNamespace(),
    };
  }

  it("GET /mcp is a 405", async () => {
    const res = await handler.fetch(new Request("http://x.test/mcp"), devLikeEnv());
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  it("an unknown path is a 404", async () => {
    const res = await handler.fetch(new Request("http://x.test/elsewhere"), devLikeEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
