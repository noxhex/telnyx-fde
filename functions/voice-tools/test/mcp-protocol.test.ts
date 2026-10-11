import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ActorNamespace } from "@telnyx/edge-runtime";

import { mintSessionToken, parseKey } from "@duinvezel/shared";
import type { CreateSessionInput, CreateSessionResult, SessionDoc } from "@duinvezel/shared";

import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import type { ClockFake } from "../../../packages/shared/test/fakes/clock.js";

import { TIMED_OUT } from "../src/config.js";
import type { TimeoutRunner } from "../src/config.js";
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
    callerPhone: "+32491244713",
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
}

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
  const caches: CachesDep = { areas: createMemoryCache(10_000, clock.now) };
  const log = createLogger(
    "voice-tools",
    (line) => {
      lines.push(line);
    },
    clock.now,
  );
  const crm: CrmClient = { testLine: () => Promise.resolve({ ok: false }) };
  const deps: VoiceToolsDeps = {
    now: clock.now,
    kv: undefined,
    sessions,
    crm,
    caches,
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

  it("invalid parameters are error -32602 (bad postcode)", async () => {
    const h = makeHarness();
    const res = await h.post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "check_area_status", arguments: { postcode: "86a0" } },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: -32602,
        message:
          "MCP error -32602: Invalid arguments for check_area_status: postcode must be exactly four digits",
      },
    });
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
  it("returns the two tools in the card's order with input schemas", async () => {
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
      "check_area_status",
      "run_line_diagnostics",
    ]);
    const [area, diagnostics] = body.result.tools;
    // Written for a voice model: each description says when to use the tool.
    expect(area?.description).toContain("whenever the caller asks about an outage");
    expect(diagnostics?.description).toContain("internet is down, slow or unstable");
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
