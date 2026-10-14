/**
 * Tests for card T11: a first run against an empty account and a second run
 * against what the first run created, plus the payload assertions on the
 * bodies the script sends. The fake API answers with the S2 read-back
 * decorations (nodes in another order, a `position` per node, the resolved
 * `tool` on tool nodes, nulls for unsent fields, no `tool_ids` field).
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildConversationFlow } from "../../assistant/flow.ts";
import { loadInstructions } from "../../assistant/instructions.ts";
import { ManualTimeouts } from "./manual-timeout.ts";
import {
  API_KEY,
  BASE_IDS_FILE,
  FakeApi,
  PHONE_NUMBER,
  TRANSFER_TO,
  makeDeps,
} from "./fake-api.ts";
import { provision } from "../provision/run.ts";

const WORKFLOW_MD = readFileSync(new URL("../../docs/WORKFLOW.md", import.meta.url), "utf8");

/** The Default column of the variable contract table in docs/WORKFLOW.md. */
function contractDefaults(): Record<string, string> {
  const start = WORKFLOW_MD.indexOf("## Variable contract");
  const rest = WORKFLOW_MD.slice(start);
  const section = rest.slice(0, rest.indexOf("\n## ", 1));
  const defaults: Record<string, string> = {};
  for (const line of section.split("\n")) {
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 3) {
      continue;
    }
    const name = /^`([a-z_]+)`$/.exec(cells[0]?.trim() ?? "")?.[1];
    const value = /^`"(.*)"`$/.exec(cells[2]?.trim() ?? "")?.[1];
    if (name !== undefined && value !== undefined) {
      defaults[name] = value;
    }
  }
  return defaults;
}

const VOICE_CONTEXT_URL = "https://voice-context-00d2df1a-d.telnyxcompute.com";
const VOICE_TOOLS_URL = "https://voice-tools-11c54a81-0.telnyxcompute.com";

function sequence(api: FakeApi): string[] {
  return api.requests.map((r) => `${r.method} ${r.path}`);
}

describe("a first run against an empty account", () => {
  it("checks the secret, creates the tools, the MCP server and the assistant in order, attaches the number and writes the ids", async () => {
    const api = new FakeApi();
    const timeouts = new ManualTimeouts();
    const deps = makeDeps({ api, timeoutRunner: timeouts.runner });

    await provision(deps);

    expect(sequence(api)).toEqual([
      "GET /integration_secrets",
      "GET /ai/tools",
      "POST /ai/tools",
      "POST /ai/tools",
      "POST /ai/tools",
      "GET /ai/mcp_servers",
      "POST /ai/mcp_servers",
      "GET /ai/assistants",
      "POST /ai/assistants",
      "GET /phone_numbers",
      "PATCH /phone_numbers/pn-0001",
    ]);

    const creates = api.requests.filter((r) => r.method === "POST" && r.path === "/ai/tools");
    expect(creates.map((r) => (r.body as Record<string, unknown>)["display_name"])).toEqual([
      "duinvezel-log-disclosure",
      "duinvezel-transfer",
      "duinvezel-hangup",
    ]);

    expect(deps.lines).toEqual([
      "secret mcp_enc_key: present",
      "tool duinvezel-log-disclosure (tool-0001-uuid): created",
      "tool duinvezel-transfer (tool-0002-uuid): created",
      "tool duinvezel-hangup (tool-0003-uuid): created",
      "mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): created",
      "assistant Duinvezel Support (assistant-0001-uuid): created",
      "phone_number ...0143 (pn-0001): updated (connection_id); the number needs a few minutes before calls go through",
      "ids infra/ids.json: written",
    ]);

    expect(deps.written).toHaveLength(1);
    const written = deps.written[0] ?? "";
    expect(written.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed).toEqual({
      ...BASE_IDS_FILE,
      assistant: {
        id: "assistant-0001-uuid",
        name: "Duinvezel Support",
        texmlAppId: "app-for-assistant-0001-uuid",
      },
      mcpServer: { id: "mcp-server-0001-uuid", name: "duinvezel-voice-tools" },
      tools: {
        logDisclosure: { id: "tool-0001-uuid", name: "duinvezel-log-disclosure" },
        transfer: { id: "tool-0002-uuid", name: "duinvezel-transfer" },
        hangup: { id: "tool-0003-uuid", name: "duinvezel-hangup" },
      },
      phoneNumber: { id: "pn-0001" },
    });
    /* The file holds no phone number. */
    expect(written).not.toContain(PHONE_NUMBER);
    expect(written).not.toContain("0143");

    /* The number moved from spike-routing's application to the assistant's. */
    expect(api.phoneNumbers[0]?.connection_id).toBe("app-for-assistant-0001-uuid");
  });
});

describe("a second run against what the first run created", () => {
  it("sends no create and no update, prints unchanged for every resource and writes no file", async () => {
    const api = new FakeApi();
    const first = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(first);
    expect(first.written).toHaveLength(1);
    const requestsBefore = api.requests.length;

    const second = makeDeps({
      api,
      timeoutRunner: new ManualTimeouts().runner,
      overrides: { idsFile: JSON.parse(first.written[0] ?? "{}") as Record<string, unknown> },
    });
    await provision(second);

    const requests = api.requests.slice(requestsBefore);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(sequence(api).slice(requestsBefore)).toEqual([
      "GET /integration_secrets",
      "GET /ai/tools",
      "GET /ai/mcp_servers",
      "GET /ai/assistants",
      "GET /ai/assistants/assistant-0001-uuid",
      "GET /phone_numbers",
    ]);
    expect(second.lines).toEqual([
      "secret mcp_enc_key: present",
      "tool duinvezel-log-disclosure (tool-0001-uuid): unchanged",
      "tool duinvezel-transfer (tool-0002-uuid): unchanged",
      "tool duinvezel-hangup (tool-0003-uuid): unchanged",
      "mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): unchanged",
      "assistant Duinvezel Support (assistant-0001-uuid): unchanged",
      "phone_number ...0143 (pn-0001): unchanged",
      "ids infra/ids.json: unchanged",
    ]);
    expect(second.written).toHaveLength(0);
  });

  it("survives the MCP server list as a page instead of a bare array", async () => {
    const api = new FakeApi({ mcpListForm: "page" });
    const first = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(first);
    const second = makeDeps({
      api,
      timeoutRunner: new ManualTimeouts().runner,
      overrides: { idsFile: JSON.parse(first.written[0] ?? "{}") as Record<string, unknown> },
    });
    await provision(second);
    expect(second.lines.filter((line) => line.includes("mcp_server"))).toEqual([
      "mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): unchanged",
    ]);
  });

  it("reads every page of the MCP server list to find ours among more than a page of others", async () => {
    const api = new FakeApi();
    for (let index = 0; index < 110; index += 1) {
      api.servers.push({
        id: `other-server-${index}`,
        body: { name: `other-server-${index}`, type: "http", url: "https://example.com" },
      });
    }
    const api2 = api;
    const first = makeDeps({ api: api2, timeoutRunner: new ManualTimeouts().runner });
    await provision(first);
    const lists = api.requests.filter((r) => r.method === "GET" && r.path === "/ai/mcp_servers");
    expect(lists.length).toBe(2);
    expect(lists[0]?.query.get("page[number]")).toBe("1");
    expect(lists[0]?.query.get("page[size]")).toBe("100");
    expect(lists[1]?.query.get("page[number]")).toBe("2");
    const creates = api.requests.filter((r) => r.method === "POST" && r.path === "/ai/mcp_servers");
    expect(creates).toHaveLength(1);
  });

  it("reads pages until meta.total_pages when the API answers shorter pages than page[size]", async () => {
    const api = new FakeApi({ listPageSize: 20 });
    for (let index = 0; index < 20; index += 1) {
      api.tools.push({
        id: `other-tool-${index}`,
        body: {
          display_name: `other-tool-${index}`,
          type: "webhook",
          timeout_ms: 5000,
          webhook: { name: `other_${index}` },
        },
      });
    }
    /* A first run against a page of 20 others: total_pages is 1, so the run stops there and creates our three on page 2. */
    await provision(makeDeps({ api, timeoutRunner: new ManualTimeouts().runner }));
    expect(api.tools).toHaveLength(23);

    /* The second run: page 1 is short (20 < 100) but meta.total_pages is 2, and our tools are on page 2. */
    const before = api.requests.length;
    const second = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(second);
    const requests = api.requests.slice(before);

    const toolsLists = requests.filter((r) => r.method === "GET" && r.path === "/ai/tools");
    expect(toolsLists.map((r) => r.query.get("page[number]"))).toEqual(["1", "2"]);
    expect(toolsLists.every((r) => r.query.get("page[size]") === "100")).toBe(true);
    expect(requests.filter((r) => r.method === "POST" && r.path === "/ai/tools")).toHaveLength(0);
    expect(api.tools).toHaveLength(23);
    expect(second.lines).toContain("tool duinvezel-log-disclosure (tool-0001-uuid): unchanged");
    expect(second.lines).toContain("tool duinvezel-transfer (tool-0002-uuid): unchanged");
    expect(second.lines).toContain("tool duinvezel-hangup (tool-0003-uuid): unchanged");
  });
});

describe("the payloads the script sends", () => {
  it("sends the tool shapes of the card, with from the assistant's number and to the transfer number", async () => {
    const api = new FakeApi();
    await provision(makeDeps({ api, timeoutRunner: new ManualTimeouts().runner }));
    const creates = api.requests.filter((r) => r.method === "POST" && r.path === "/ai/tools");

    expect(creates[0]?.body).toEqual({
      display_name: "duinvezel-log-disclosure",
      type: "webhook",
      timeout_ms: 5000,
      webhook: {
        name: "log_disclosure",
        description: "Records that the disclosure was played on this call.",
        url: `${VOICE_CONTEXT_URL}/tools/disclosure`,
        method: "POST",
        async: false,
        body_parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        preset_body_fields: { session_id: "{{session_id}}" },
      },
    });
    expect(creates[1]?.body).toEqual({
      display_name: "duinvezel-transfer",
      type: "transfer",
      timeout_ms: 5000,
      transfer: {
        targets: [{ name: "Duinvezel support engineer", to: TRANSFER_TO }],
        from: PHONE_NUMBER,
      },
    });
    expect(creates[2]?.body).toEqual({
      display_name: "duinvezel-hangup",
      type: "hangup",
      timeout_ms: 5000,
      hangup: { description: "Ends the call after the goodbye line." },
    });
  });

  it("sends the MCP server and assistant bodies of the card", async () => {
    const api = new FakeApi();
    await provision(makeDeps({ api, timeoutRunner: new ManualTimeouts().runner }));

    const serverCreate = api.requests.find((r) => r.method === "POST" && r.path === "/ai/mcp_servers");
    expect(serverCreate?.body).toEqual({
      name: "duinvezel-voice-tools",
      type: "http",
      url: `${VOICE_TOOLS_URL}/mcp`,
      api_key_ref: "{{mcp_token | mcp_enc_key}}",
      allowed_tools: [
        "verify_account",
        "check_area_status",
        "run_line_diagnostics",
        "report_outage",
        "create_ticket",
      ],
    });

    const assistantCreate = api.requests.find((r) => r.method === "POST" && r.path === "/ai/assistants");
    const body = assistantCreate?.body as Record<string, unknown>;
    expect(body["name"]).toBe("Duinvezel Support");
    expect(body["model"]).toBe("moonshotai/Kimi-K2.6");
    expect(body["instructions"]).toBe(loadInstructions().base);
    expect(body["enabled_features"]).toEqual(["telephony"]);
    /* T23: the greeting is empty, so the call hears only the Disclosure node's line (DEBUGLOG issue 18). */
    expect(body["greeting"]).toBe("");
    expect(body["voice_settings"]).toEqual({
      voice: "Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02",
      voice_speed: 1,
      similarity_boost: 0.5,
      style: 0,
      use_speaker_boost: true,
      language_boost: "English",
      expressive_mode: true,
      background_audio: { type: "predefined_media", value: "silence", volume: 0.5 },
    });
    expect(body["dynamic_variables"]).toEqual(contractDefaults());
    expect(Object.keys(body["dynamic_variables"] as Record<string, unknown>).sort()).toEqual(
      Object.keys(contractDefaults()).sort(),
    );
    expect(body["dynamic_variables_webhook_url"]).toBe(`${VOICE_CONTEXT_URL}/dv`);
    expect(body["dynamic_variables_webhook_timeout_ms"]).toBe(4000);
    expect(body["mcp_servers"]).toEqual([
      {
        id: "mcp-server-0001-uuid",
        allowed_tools: [
          "verify_account",
          "check_area_status",
          "run_line_diagnostics",
          "report_outage",
          "create_ticket",
        ],
      },
    ]);
    expect(body["tool_ids"]).toEqual([]);
    expect(body["conversation_flow"]).toEqual(
      buildConversationFlow({
        toolIds: {
          logDisclosure: "tool-0001-uuid",
          transfer: "tool-0002-uuid",
          hangup: "tool-0003-uuid",
        },
        instructions: loadInstructions(),
      }),
    );
    /* A create sends no telephony_settings: the API default switches recording on. */
    expect("telephony_settings" in body).toBe(false);
  });

  it("sends the api key only in the Authorization header, and prints no secret values", async () => {
    const api = new FakeApi();
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(deps);
    for (const request of api.requests) {
      expect(request.headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
      expect(request.url).not.toContain(API_KEY);
      expect(request.bodyText ?? "").not.toContain(API_KEY);
    }
    const output = deps.lines.join("\n");
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain(TRANSFER_TO);
    expect(output).not.toContain(PHONE_NUMBER);
  });
});
