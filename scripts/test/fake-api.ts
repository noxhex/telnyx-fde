/**
 * `scripts/test/fake-api.ts` — a fake of the Telnyx API for the provisioning
 * tests. It records every request and answers the way the API does, including
 * the S2 read-back decorations the comparison must ignore: nodes in another
 * order, a `position` on every node, a resolved `tool` on tool nodes, nulls
 * for unsent fields, and no `tool_ids` field on the assistant. Phone numbers
 * and the API key are fake test values. Unowned spike resources are seeded
 * per test.
 */

import type { FetchInit, FetchResult } from "../provision/client.ts";
import { createClient } from "../provision/client.ts";
import type { TimeoutRunner } from "../provision/client.ts";
import type { ProvisionDeps } from "../provision/run.ts";
import { loadInstructions } from "../../assistant/instructions.ts";

/** Fake values only — never a real key or number. */
export const API_KEY = "fake-api-key-0001";
export const PHONE_NUMBER = "+12025550143";
export const TRANSFER_TO = "+32470001122";

export const BASE_IDS_FILE: Record<string, unknown> = {
  kvNamespaceId: "504d09fa-a57f-4d70-b134-6b97ea537ae1",
  functions: {
    "voice-context": {
      name: "voice-context",
      funcId: "00d2df1a-d987-43f8-a35d-f08c80d2c534",
      invokeUrl: "https://voice-context-00d2df1a-d.telnyxcompute.com",
    },
    "voice-tools": {
      name: "voice-tools",
      funcId: "11c54a81-062d-4412-bfe6-bf93c10cbe32",
      invokeUrl: "https://voice-tools-11c54a81-0.telnyxcompute.com",
    },
    "mock-crm": {
      name: "mock-crm",
      funcId: "26584f2f-d158-40b5-98ce-72f84c4e6690",
      invokeUrl: "https://mock-crm-26584f2f-d.telnyxcompute.com",
    },
  },
};

export type RecordedRequest = {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string | undefined;
  aborted: boolean;
};

type StoredTool = { id: string; body: Record<string, unknown> };
type StoredServer = { id: string; body: Record<string, unknown> };
type StoredAssistant = {
  id: string;
  managed: Record<string, unknown>;
  telephony_settings: Record<string, unknown>;
  attachments: Record<string, unknown>[];
};
export type StoredPhoneNumber = { id: string; phone_number: string; connection_id: string | null };

function toolReadForm(stored: StoredTool): Record<string, unknown> {
  const body = stored.body;
  const type = typeof body["type"] === "string" ? body["type"] : "";
  return {
    id: stored.id,
    type,
    display_name: body["display_name"],
    tool_definition: body[type],
    timeout_ms: body["timeout_ms"],
    created_at: "2026-10-12T13:00:00.000Z",
  };
}

function serverReadForm(stored: StoredServer): Record<string, unknown> {
  return { id: stored.id, ...stored.body, created_at: "2026-10-12T13:00:00.000Z" };
}

export class FakeApi {
  readonly requests: RecordedRequest[] = [];
  secrets: string[];
  tools: StoredTool[] = [];
  servers: StoredServer[] = [];
  assistants: StoredAssistant[] = [];
  phoneNumbers: StoredPhoneNumber[];
  mcpListForm: "bare" | "page";
  decorateAssistantReads: boolean;
  /** When set, the paged lists answer at most this many items per page whatever `page[size]` says, with full `meta`. */
  private readonly listPageSize: number | undefined;
  /** When true, the phone number lookup answers every number on the account, as an API ignoring the filter would. */
  private readonly ignorePhoneNumberFilter: boolean;
  private counters = { tool: 0, "mcp-server": 0, assistant: 0 };
  private failures: { method: string; pathPrefix: string; status: number; body: unknown }[] = [];
  private holdNext = false;
  private heldResolve: ((result: FetchResult) => void) | undefined;

  constructor(options?: {
    secrets?: string[];
    phoneNumbers?: StoredPhoneNumber[];
    mcpListForm?: "bare" | "page";
    decorateAssistantReads?: boolean;
    listPageSize?: number;
    ignorePhoneNumberFilter?: boolean;
  }) {
    this.secrets = options?.secrets ?? ["mcp_enc_key"];
    this.phoneNumbers = options?.phoneNumbers ?? [
      { id: "pn-0001", phone_number: PHONE_NUMBER, connection_id: "app-of-spike-routing" },
    ];
    this.mcpListForm = options?.mcpListForm ?? "bare";
    this.decorateAssistantReads = options?.decorateAssistantReads ?? true;
    this.listPageSize = options?.listPageSize;
    this.ignorePhoneNumberFilter = options?.ignorePhoneNumberFilter ?? false;
  }

  /** The next non-GET request stops answering until `settleHeld` resolves it. */
  holdNextRequest(): void {
    this.holdNext = true;
  }

  /** Resolves a held request late; nothing must be waiting on it by then. */
  settleHeld(result: FetchResult): void {
    const resolve = this.heldResolve;
    this.heldResolve = undefined;
    resolve?.(result);
  }

  /** Every request with this method and path prefix answers with the given status and body. */
  failOn(method: string, pathPrefix: string, status: number, body: unknown): void {
    this.failures.push({ method, pathPrefix, status, body });
  }

  readonly fetch = async (url: string, init: FetchInit): Promise<FetchResult> => {
    const parsed = new URL(url);
    const request: RecordedRequest = {
      method: init.method,
      url,
      path: parsed.pathname.replace(/^\/v2/, ""),
      query: parsed.searchParams,
      headers: init.headers,
      body: init.body !== undefined ? JSON.parse(init.body) : undefined,
      bodyText: init.body,
      aborted: false,
    };
    this.requests.push(request);
    init.signal?.addEventListener("abort", () => {
      request.aborted = true;
    });
    if (this.holdNext && init.method !== "GET") {
      this.holdNext = false;
      return new Promise<FetchResult>((resolve) => {
        this.heldResolve = resolve;
      });
    }
    return this.respond(request);
  };

  private respond(request: RecordedRequest): FetchResult {
    const failure = this.failures.find(
      (f) => f.method === request.method && request.path.startsWith(f.pathPrefix),
    );
    if (failure !== undefined) {
      return jsonResponse(failure.status, failure.body);
    }
    try {
      return jsonResponse(200, this.route(request));
    } catch (error) {
      return jsonResponse(404, {
        errors: [{ code: "404", title: "Not found", detail: error instanceof Error ? error.message : "" }],
      });
    }
  }

  private route(request: RecordedRequest): unknown {
    const { method, path, body } = request;
    if (method === "GET" && path === "/integration_secrets") {
      const page = Number(request.query.get("page[number]") ?? "1");
      if (this.listPageSize === undefined) {
        return page === 1
          ? { data: this.secrets.map((identifier) => ({ identifier })), meta: { total_pages: 1 } }
          : { data: [], meta: { total_pages: 1 } };
      }
      const items = this.secrets
        .slice((page - 1) * this.listPageSize, page * this.listPageSize)
        .map((identifier) => ({ identifier }));
      return { data: items, meta: this.listMeta(this.secrets.length, page, this.listPageSize) };
    }
    if (method === "GET" && path === "/ai/tools") {
      const page = Number(request.query.get("page[number]") ?? "1");
      const size = this.listPageSize ?? Number(request.query.get("page[size]") ?? "100");
      const items = this.tools.slice((page - 1) * size, page * size).map(toolReadForm);
      return { data: items, meta: this.listMeta(this.tools.length, page, size) };
    }
    if (method === "POST" && path === "/ai/tools") {
      const stored: StoredTool = { id: this.newId("tool"), body: mustBody(body) };
      this.tools.push(stored);
      return toolReadForm(stored);
    }
    const toolMatch = /^\/ai\/tools\/(.+)$/.exec(path);
    if (toolMatch?.[1] !== undefined && method === "PATCH") {
      const stored = this.tools.find((tool) => tool.id === toolMatch[1]);
      if (stored === undefined) {
        throw new Error(`no such tool ${toolMatch[1]}`);
      }
      stored.body = mustBody(body);
      return toolReadForm(stored);
    }
    if (method === "GET" && path === "/ai/mcp_servers") {
      const page = Number(request.query.get("page[number]") ?? "1");
      const size = Number(request.query.get("page[size]") ?? "100");
      const items = this.servers.slice((page - 1) * size, page * size).map(serverReadForm);
      return this.mcpListForm === "bare" ? items : { data: items, meta: {} };
    }
    if (method === "POST" && path === "/ai/mcp_servers") {
      const stored: StoredServer = { id: this.newId("mcp-server"), body: mustBody(body) };
      this.servers.push(stored);
      return serverReadForm(stored);
    }
    const serverMatch = /^\/ai\/mcp_servers\/(.+)$/.exec(path);
    if (serverMatch?.[1] !== undefined && method === "PUT") {
      const stored = this.servers.find((server) => server.id === serverMatch[1]);
      if (stored === undefined) {
        throw new Error(`no such mcp server ${serverMatch[1]}`);
      }
      stored.body = mustBody(body);
      return serverReadForm(stored);
    }
    if (method === "GET" && path === "/ai/assistants") {
      return { data: this.assistants.map((a) => ({ id: a.id, name: a.managed["name"] })) };
    }
    if (method === "POST" && path === "/ai/assistants") {
      const stored: StoredAssistant = {
        id: this.newId("assistant"),
        managed: mustBody(body),
        telephony_settings: {},
        attachments: [],
      };
      stored.telephony_settings = this.defaultTelephonySettings(stored.id);
      stored.attachments = attachmentsOf(stored.managed);
      this.assistants.push(stored);
      return this.assistantReadForm(stored);
    }
    const assistantMatch = /^\/ai\/assistants\/(.+)$/.exec(path);
    if (assistantMatch?.[1] !== undefined && method === "GET") {
      return this.assistantReadForm(this.findAssistant(assistantMatch[1]));
    }
    if (assistantMatch?.[1] !== undefined && method === "POST") {
      const stored = this.findAssistant(assistantMatch[1]);
      const update = mustBody(body);
      const { telephony_settings, ...managed } = update;
      stored.managed = managed;
      if (telephony_settings !== undefined) {
        stored.telephony_settings = telephony_settings as Record<string, unknown>;
      }
      stored.attachments = attachmentsOf(update);
      return this.assistantReadForm(stored);
    }
    if (method === "GET" && path === "/phone_numbers") {
      const filter = request.query.get("filter[phone_number]");
      const data = this.phoneNumbers.filter(
        (entry) => this.ignorePhoneNumberFilter || filter === null || entry.phone_number === filter,
      );
      return { data, meta: {} };
    }
    const phoneMatch = /^\/phone_numbers\/(.+)$/.exec(path);
    if (phoneMatch?.[1] !== undefined && method === "PATCH") {
      const entry = this.phoneNumbers.find((candidate) => candidate.id === phoneMatch[1]);
      if (entry === undefined) {
        throw new Error(`no such phone number ${phoneMatch[1]}`);
      }
      const update = mustBody(body);
      if ("connection_id" in update) {
        entry.connection_id = update["connection_id"] as string | null;
      }
      return { data: entry };
    }
    throw new Error(`${method} ${path} is not routed by the fake`);
  }

  private findAssistant(id: string): StoredAssistant {
    const found = this.assistants.find((a) => a.id === id);
    if (found === undefined) {
      throw new Error(`no such assistant ${id}`);
    }
    return found;
  }

  /**
   * The `meta` of a paged answer. Without `listPageSize` the fake answers
   * full pages and an empty meta, the way the default runs do; with it the
   * fake answers short pages with `total_pages`, the way the API's v2 lists
   * read (DEBUGLOG, S2 read-back).
   */
  private listMeta(totalResults: number, pageNumber: number, pageSize: number): Record<string, unknown> {
    if (this.listPageSize === undefined) {
      return {};
    }
    return {
      page_number: pageNumber,
      page_size: pageSize,
      total_pages: Math.ceil(totalResults / this.listPageSize),
      total_results: totalResults,
    };
  }

  private newId(kind: "tool" | "mcp-server" | "assistant"): string {
    this.counters[kind] += 1;
    return `${kind}-${String(this.counters[kind]).padStart(4, "0")}-uuid`;
  }

  private defaultTelephonySettings(assistantId: string): Record<string, unknown> {
    return {
      default_texml_app_id: `app-for-${assistantId}`,
      recording_settings: { enabled: true, channels: "dual", format: "mp3", stop_on_conversation_end: true },
    };
  }

  /**
   * The API's read-back of an assistant (DEBUGLOG, S2): ids and nulls the
   * script never sent, the merged `tools` attachments list instead of
   * `tool_ids`, the TeXML settings, and — when `decorateAssistantReads` is
   * on — nodes in another order, a `position` per node, the resolved `tool`
   * on tool nodes and `message: null` where the script sent none.
   */
  private assistantReadForm(stored: StoredAssistant): Record<string, unknown> {
    const managed = stored.managed;
    return {
      id: stored.id,
      name: managed["name"],
      created_at: "2026-10-12T13:00:00.000Z",
      description: null,
      llm_api_key_ref: null,
      model: managed["model"],
      instructions: managed["instructions"],
      greeting: managed["greeting"],
      enabled_features: managed["enabled_features"],
      voice_settings: managed["voice_settings"],
      dynamic_variables: managed["dynamic_variables"],
      dynamic_variables_webhook_url: managed["dynamic_variables_webhook_url"],
      dynamic_variables_webhook_timeout_ms: managed["dynamic_variables_webhook_timeout_ms"],
      mcp_servers: managed["mcp_servers"],
      tools: stored.attachments,
      telephony_settings: stored.telephony_settings,
      conversation_flow: this.decorateAssistantReads
        ? decorateFlow(managed["conversation_flow"])
        : managed["conversation_flow"],
    };
  }
}

function jsonResponse(status: number, body: unknown): FetchResult {
  return { status, text: () => Promise.resolve(JSON.stringify(body)) };
}

function mustBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("request without a JSON object body");
  }
  return body as Record<string, unknown>;
}

/** The assistant's attached shared tools, the way the API's merged `tools` list reads (S2). */
function attachmentsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const ids = body["tool_ids"];
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids.filter((id): id is string => typeof id === "string").map((tool_id) => ({ shared: true, tool_id }));
}

/**
 * The S2 read-back decorations the comparison must survive: nodes in another
 * order, a `position` on every node, a resolved `tool` on tool nodes,
 * `message: null` where the script sent none, and `shared_tool_ids` /
 * `tools_mode` / `tools` on prompt nodes.
 */
export function decorateFlow(flow: unknown): unknown {
  if (typeof flow !== "object" || flow === null) {
    return flow;
  }
  const source = flow as Record<string, unknown>;
  const nodes = Array.isArray(source["nodes"]) ? [...source["nodes"]] : [];
  const decoratedNodes = nodes.reverse().map((node) => {
    const original = node as Record<string, unknown>;
    const decorated: Record<string, unknown> = { position: { x: 100, y: 100 }, ...original };
    if (original["type"] === "tool") {
      decorated["tool"] = { type: "webhook", webhook: { name: "resolved-by-the-api" } };
      if (!("message" in original)) {
        decorated["message"] = null;
      }
    }
    if (original["type"] === "prompt") {
      decorated["shared_tool_ids"] = null;
      decorated["tools_mode"] = "replace";
      decorated["tools"] = [];
    }
    return decorated;
  });
  return { ...source, nodes: decoratedNodes };
}

/** Builds the deps `provision` takes, on the fake fetch and the base ids file. */
export function makeDeps(input: {
  api: FakeApi;
  timeoutRunner: TimeoutRunner;
  overrides?: Partial<ProvisionDeps>;
}): ProvisionDeps & { lines: string[]; written: string[] } {
  const lines: string[] = [];
  const written: string[] = [];
  return {
    client: createClient({ fetchImpl: input.api.fetch, timeoutRunner: input.timeoutRunner, apiKey: API_KEY }),
    idsFile: structuredClone(BASE_IDS_FILE),
    writeIds: (serialised) => {
      written.push(serialised);
    },
    instructions: loadInstructions(),
    transferTo: TRANSFER_TO,
    phoneNumber: PHONE_NUMBER,
    dryRun: false,
    print: (line) => {
      lines.push(line);
    },
    ...input.overrides,
    lines,
    written,
  };
}

