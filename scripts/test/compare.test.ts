/**
 * Unit tests for the comparison rules of card T11: numbers match by value,
 * objects match as subsets, lists match in order with the two named
 * exceptions (flow nodes by `id` in any order, attached tools as a set), and
 * a shared tool's `<type>` object is compared with `tool_definition`.
 */

import { describe, expect, it } from "vitest";

import { buildConversationFlow } from "../../assistant/flow.ts";
import { loadInstructions } from "../../assistant/instructions.ts";
import {
  diffAssistant,
  diffMcpServer,
  diffTool,
  matchConversationFlow,
  matchGreeting,
  matchToolIds,
  matchValue,
  recordingIsOn,
  telephonySettingsWithRecordingOn,
} from "../provision/compare.ts";
import { sharedToolBodies } from "../provision/desired.ts";

const instructions = loadInstructions();
const toolIds = { logDisclosure: "t-1", transfer: "t-2", hangup: "t-3" };

/** The greeting T11 sent, which played alongside the speak node (DEBUGLOG issue 18). */
const OLD_DISCLOSURE_LINE =
  "{{greeting_line}}, you've reached Duinvezel fiber support. I'm an automated assistant, " +
  "and this call is recorded so we can improve our service.";

describe("matchValue", () => {
  it("matches numbers by value and nothing looser", () => {
    expect(matchValue(300, 300)).toBe(true);
    expect(matchValue(4000, 4000)).toBe(true);
    expect(matchValue(4000, 4000.0001)).toBe(false);
    expect(matchValue(300, "300")).toBe(false);
  });

  it("matches objects as subsets: keys the API adds are ignored", () => {
    expect(matchValue({ a: 1 }, { a: 1, b: 2, position: { x: 1, y: 2 } })).toBe(true);
    expect(matchValue({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(matchValue({ a: null }, { a: null })).toBe(true);
    expect(matchValue({ a: 1 }, null)).toBe(false);
    expect(matchValue({ a: 1 }, undefined)).toBe(false);
  });

  it("matches lists only in the same length and order", () => {
    expect(matchValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(matchValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(matchValue(["a"], ["a", "b"])).toBe(false);
    expect(matchValue(["a", "b"], ["a"])).toBe(false);
    expect(matchValue([], null)).toBe(false);
  });
});

describe("matchConversationFlow", () => {
  const flow = buildConversationFlow({ toolIds, instructions });

  it("matches nodes by id in any order", () => {
    const shuffled = { ...flow, nodes: [...flow.nodes].reverse() };
    expect(matchConversationFlow(flow, shuffled)).toBe(true);
  });

  it("keeps edges in their order, because that is their evaluation order", () => {
    const edges = [...flow.edges];
    const [first, second] = [edges[0], edges[1]];
    if (first === undefined || second === undefined) {
      throw new Error("the flow has fewer than two edges");
    }
    edges[0] = second;
    edges[1] = first;
    expect(matchConversationFlow(flow, { ...flow, edges })).toBe(false);
  });

  it("ignores the keys the API adds, like position and a resolved tool", () => {
    const nodes = flow.nodes.map((node) => ({
      ...node,
      position: { x: 10, y: 20 },
      ...(node.type === "tool"
        ? { tool: { type: "webhook" }, ...("message" in node ? {} : { message: null }) }
        : { shared_tool_ids: null, tools: [] }),
    }));
    expect(matchConversationFlow(flow, { ...flow, nodes })).toBe(true);
  });

  it("counts a changed instruction or message as a difference", () => {
    const nodes = flow.nodes.map((node) =>
      node.id === "n_triage" && node.type === "prompt" ? { ...node, instructions: "Changed." } : node,
    );
    expect(matchConversationFlow(flow, { ...flow, nodes })).toBe(false);
  });

  it("matches a number literal by value (the API's 300.0 reads back as 300)", () => {
    const edges = flow.edges.map((edge) => {
      if (edge.id !== "e_diagnose_time_guard" || edge.condition.type !== "expression") {
        return edge;
      }
      return {
        ...edge,
        condition: {
          ...edge.condition,
          expression: { ...edge.condition.expression, right: { type: "number_literal", value: 300.0 } },
        },
      };
    });
    expect(matchConversationFlow(flow, { ...flow, edges })).toBe(true);
  });

  it("fails on a missing or changed start node, a dropped node or a dropped edge", () => {
    expect(matchConversationFlow(flow, { ...flow, start_node_id: "n_route" })).toBe(false);
    expect(matchConversationFlow(flow, { ...flow, nodes: flow.nodes.slice(1) })).toBe(false);
    expect(matchConversationFlow(flow, { ...flow, edges: flow.edges.slice(1) })).toBe(false);
    expect(matchConversationFlow(flow, undefined)).toBe(false);
  });
});

describe("matchToolIds", () => {
  it("matches the tool_ids of the entries in the tools list as a set", () => {
    expect(matchToolIds([], [])).toBe(true);
    expect(matchToolIds([], undefined)).toBe(true);
    expect(matchToolIds([], [{ tool_id: "x-1" }])).toBe(false);
    expect(matchToolIds(["a-1", "b-2"], [{ tool_id: "b-2" }, { tool_id: "a-1" }])).toBe(true);
    expect(matchToolIds(["a-1"], [{ tool_id: "a-1" }, { tool_id: "b-2" }])).toBe(false);
  });
});

describe("diffTool", () => {
  const desired = {
    display_name: "duinvezel-transfer",
    type: "transfer",
    timeout_ms: 5000,
    transfer: { targets: [{ name: "Duinvezel support engineer", to: "+32470001122" }], from: "+12025550143" },
  };
  const asRead = {
    id: "tool-1",
    type: "transfer",
    display_name: "duinvezel-transfer",
    timeout_ms: 5000,
    created_at: "2026-10-12T13:00:00.000Z",
    tool_definition: desired.transfer,
  };

  it("compares the <type> object with the API's tool_definition and ignores added keys", () => {
    expect(diffTool(desired, asRead)).toEqual([]);
    expect(diffTool(desired, { ...asRead, tool_definition: { ...desired.transfer, from: "+12025550999" } })).toEqual(
      ["transfer"],
    );
    expect(diffTool(desired, { ...asRead, timeout_ms: 10000 })).toEqual(["timeout_ms"]);
    expect(diffTool(desired, { ...asRead, display_name: "other" })).toEqual(["display_name"]);
    expect(diffTool(desired, { ...asRead, tool_definition: undefined })).toEqual(["transfer"]);
  });
});

describe("diffTool on the disclosure tool", () => {
  const disclosure = sharedToolBodies({
    voiceContextUrl: "https://voice-context.example.com",
    transferTo: "+32470001122",
    phoneNumber: "+12025550143",
  }).find((tool) => tool.key === "logDisclosure");
  if (disclosure === undefined) {
    throw new Error("the disclosure tool body is missing");
  }
  const desired = disclosure.body;
  const webhook = desired["webhook"] as Record<string, unknown>;
  const asRead = {
    id: "t-1",
    display_name: "duinvezel-log-disclosure",
    type: "webhook",
    timeout_ms: 5000,
    created_at: "2026-10-12T13:00:00.000Z",
  };

  /* The shape the T11 run created: session_id in body_parameters and no preset (DEBUGLOG issue 19). */
  const oldDefinition = {
    name: "log_disclosure",
    description: "Records that the disclosure was played on this call.",
    url: "https://voice-context.example.com/tools/disclosure",
    method: "POST",
    async: false,
    body_parameters: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  };

  it("updates a read-back in the T11 shape, because the preset is missing", () => {
    expect(diffTool(desired, { ...asRead, tool_definition: oldDefinition })).toEqual(["webhook"]);
  });

  it("is unchanged on a read-back in the new shape, with keys the API adds ignored", () => {
    const newDefinition = {
      ...webhook,
      headers: { "Content-Type": "application/json" },
      preset_query_params: {},
    };
    expect(diffTool(desired, { ...asRead, tool_definition: newDefinition })).toEqual([]);
  });

  it("counts a changed or missing preset as a difference", () => {
    expect(
      diffTool(desired, {
        ...asRead,
        tool_definition: { ...webhook, preset_body_fields: { session_id: "{{other}}" } },
      }),
    ).toEqual(["webhook"]);
    const { preset_body_fields: _dropped, ...withoutPreset } = webhook;
    expect(diffTool(desired, { ...asRead, tool_definition: withoutPreset })).toEqual(["webhook"]);
  });
});

describe("diffMcpServer", () => {
  const desired = {
    name: "duinvezel-voice-tools",
    type: "http",
    url: "https://voice-tools.example.com/mcp",
    api_key_ref: "{{mcp_token | mcp_enc_key}}",
    allowed_tools: ["verify_account", "check_area_status"],
  };

  it("counts every managed field, and allowed_tools keeps its order", () => {
    expect(diffMcpServer(desired, { id: "s-1", ...desired, created_at: "x" })).toEqual([]);
    expect(
      diffMcpServer(desired, { id: "s-1", ...desired, allowed_tools: ["check_area_status", "verify_account"] }),
    ).toEqual(["allowed_tools"]);
    expect(diffMcpServer(desired, { id: "s-1", ...desired, url: "https://other.example.com/mcp" })).toEqual(["url"]);
    expect(diffMcpServer(desired, { id: "s-1", ...desired, api_key_ref: null })).toEqual(["api_key_ref"]);
  });
});

describe("matchGreeting", () => {
  it("counts \"\", null or no greeting at all as equal to the empty greeting, and any other text as a difference", () => {
    expect(matchGreeting("", "")).toBe(true);
    expect(matchGreeting("", null)).toBe(true);
    expect(matchGreeting("", undefined)).toBe(true);
    expect(matchGreeting("", OLD_DISCLOSURE_LINE)).toBe(false);
    expect(matchGreeting("", "Hello")).toBe(false);
  });
});

describe("diffAssistant greeting", () => {
  const desired: Record<string, unknown> = {
    name: "Duinvezel Support",
    model: "moonshotai/Kimi-K2.6",
    instructions: "base",
    enabled_features: ["telephony"],
    greeting: "",
    voice_settings: { voice: "v" },
    dynamic_variables: { session_ok: "false" },
    dynamic_variables_webhook_url: "https://example.com/dv",
    dynamic_variables_webhook_timeout_ms: 4000,
    mcp_servers: [{ id: "s-1", allowed_tools: ["verify_account"] }],
    tool_ids: [],
    conversation_flow: { start_node_id: "n_disclosure", nodes: [], edges: [] },
  };

  it("counts a read-back of \"\", null or none as unchanged", () => {
    expect(diffAssistant(desired, { ...desired, tools: [], greeting: "" })).toEqual([]);
    expect(diffAssistant(desired, { ...desired, tools: [], greeting: null })).toEqual([]);
    const withoutGreeting = Object.fromEntries(Object.entries(desired).filter(([key]) => key !== "greeting"));
    expect(diffAssistant(desired, { ...withoutGreeting, tools: [] })).toEqual([]);
  });

  it("counts the old Disclosure line as a difference in greeting and nothing else", () => {
    expect(diffAssistant(desired, { ...desired, tools: [], greeting: OLD_DISCLOSURE_LINE })).toEqual(["greeting"]);
  });
});

describe("diffAssistant", () => {
  it("compares tool_ids against the tools list and the flow with the flow matcher", () => {
    const desired: Record<string, unknown> = {
      name: "Duinvezel Support",
      model: "moonshotai/Kimi-K2.6",
      instructions: "base",
      enabled_features: ["telephony"],
      greeting: "g",
      voice_settings: { voice: "v" },
      dynamic_variables: { session_ok: "false" },
      dynamic_variables_webhook_url: "https://example.com/dv",
      dynamic_variables_webhook_timeout_ms: 4000,
      mcp_servers: [{ id: "s-1", allowed_tools: ["verify_account"] }],
      tool_ids: [],
      conversation_flow: { start_node_id: "n_disclosure", nodes: [], edges: [] },
    };
    expect(diffAssistant(desired, { ...desired, tools: [] })).toEqual([]);
    expect(diffAssistant(desired, { ...desired, tools: [{ tool_id: "x-1" }] })).toEqual(["tool_ids"]);
    expect(diffAssistant(desired, { ...desired, tools: [], instructions: "other" })).toEqual(["instructions"]);
    expect(diffAssistant(desired, { ...desired, tools: [], conversation_flow: null })).toEqual(["conversation_flow"]);
    expect(diffAssistant(desired, { ...desired, tools: [], dynamic_variables_webhook_timeout_ms: 4000.0 })).toEqual(
      [],
    );
  });
});

describe("recording", () => {
  it("counts missing settings as on, because the API's default is on", () => {
    expect(recordingIsOn({})).toBe(true);
    expect(recordingIsOn({ telephony_settings: {} })).toBe(true);
    expect(recordingIsOn({ telephony_settings: { recording_settings: { enabled: true } } })).toBe(true);
    expect(recordingIsOn({ telephony_settings: { recording_settings: { enabled: false } } })).toBe(false);
  });

  it("changes only recording_settings.enabled and leaves every other key as read", () => {
    const assistant = {
      telephony_settings: {
        default_texml_app_id: "app-1",
        supports_unauthenticated_web_calls: false,
        recording_settings: { enabled: false, channels: "dual", format: "mp3" },
      },
    };
    expect(telephonySettingsWithRecordingOn(assistant)).toEqual({
      default_texml_app_id: "app-1",
      supports_unauthenticated_web_calls: false,
      recording_settings: { enabled: true, channels: "dual", format: "mp3" },
    });
  });
});
