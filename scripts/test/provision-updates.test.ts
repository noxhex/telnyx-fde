/**
 * Updates: a changed edge order, a changed instruction file, a changed
 * `allowed_tools`, a recording found off and a number found elsewhere each
 * count as a difference, and the update carries only the managed fields.
 */

import { describe, expect, it } from "vitest";

import { buildConversationFlow } from "../../assistant/flow.ts";
import type { FlowEdge, Instructions, ToolIds } from "../../assistant/flow.ts";
import { loadInstructions } from "../../assistant/instructions.ts";
import { ManualTimeouts } from "./manual-timeout.ts";
import { FakeApi, PHONE_NUMBER, TRANSFER_TO, makeDeps } from "./fake-api.ts";
import type { ProvisionDeps } from "../provision/run.ts";
import { provision } from "../provision/run.ts";

const MANAGED_ASSISTANT_FIELDS = [
  "name",
  "model",
  "instructions",
  "enabled_features",
  "greeting",
  "voice_settings",
  "dynamic_variables",
  "dynamic_variables_webhook_url",
  "dynamic_variables_webhook_timeout_ms",
  "mcp_servers",
  "tool_ids",
  "conversation_flow",
];

/** Runs a first provision, then a second one with the overrides; returns the second run's requests and deps. */
async function runTwice(
  api: FakeApi,
  overrides?: Partial<ProvisionDeps>,
): Promise<{ requests: ReturnType<typeof api.requests.slice>; lines: string[] }> {
  await provision(makeDeps({ api, timeoutRunner: new ManualTimeouts().runner }));
  const before = api.requests.length;
  const second = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides });
  await provision(second);
  return { requests: api.requests.slice(before), lines: second.lines };
}

describe("a changed desired state", () => {
  it("counts a changed edge order as a difference in conversation_flow", async () => {
    const swapped = (args: { toolIds: ToolIds; instructions: Instructions }) => {
      const flow = buildConversationFlow(args);
      const edges: FlowEdge[] = [...flow.edges];
      const first = edges[0];
      const second = edges[1];
      if (first === undefined || second === undefined) {
        throw new Error("the flow has fewer than two edges");
      }
      edges[0] = second;
      edges[1] = first;
      return { ...flow, edges };
    };
    const { requests, lines } = await runTwice(new FakeApi(), { buildFlow: swapped });

    const updates = requests.filter(
      (r) => r.method === "POST" && r.path === "/ai/assistants/assistant-0001-uuid",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.method).toBe("POST");
    expect(lines).toContain("assistant Duinvezel Support (assistant-0001-uuid): updated (conversation_flow)");

    const body = updates[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...MANAGED_ASSISTANT_FIELDS].sort());
    expect("telephony_settings" in body).toBe(false);
    const flow = body["conversation_flow"] as { edges: FlowEdge[] };
    expect(flow.edges.slice(0, 2).map((edge) => edge.id)).toEqual([
      "e_route_session_ok",
      "e_disclosure_default",
    ]);
  });

  it("sends one assistant update with only the managed fields on a changed instruction file, and names instructions", async () => {
    const instructions = { ...loadInstructions(), base: "Changed base instructions." };
    const { requests, lines } = await runTwice(new FakeApi(), { instructions });

    const writes = requests.filter((r) => r.method !== "GET");
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /ai/assistants/assistant-0001-uuid"]);
    expect(lines).toContain("assistant Duinvezel Support (assistant-0001-uuid): updated (instructions)");

    const body = writes[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...MANAGED_ASSISTANT_FIELDS].sort());
    expect(body["instructions"]).toBe("Changed base instructions.");
  });

  it("counts a changed allowed_tools on the server and on the assistant", async () => {
    const allowedTools = ["verify_account", "report_outage"];
    const { requests, lines } = await runTwice(new FakeApi(), { allowedTools });

    const puts = requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.path)).toEqual(["/ai/mcp_servers/mcp-server-0001-uuid"]);
    expect(puts[0]?.body).toEqual({
      name: "duinvezel-voice-tools",
      type: "http",
      url: "https://voice-tools-11c54a81-0.telnyxcompute.com/mcp",
      api_key_ref: "{{mcp_token | mcp_enc_key}}",
      allowed_tools: ["verify_account", "report_outage"],
    });
    expect(lines).toContain("mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): updated (allowed_tools)");

    const updates = requests.filter(
      (r) => r.method === "POST" && r.path === "/ai/assistants/assistant-0001-uuid",
    );
    expect(updates).toHaveLength(1);
    expect(lines).toContain("assistant Duinvezel Support (assistant-0001-uuid): updated (mcp_servers)");
    expect((updates[0]?.body as Record<string, unknown>)["mcp_servers"]).toEqual([
      { id: "mcp-server-0001-uuid", allowed_tools: ["verify_account", "report_outage"] },
    ]);
  });

  it("sends telephony_settings as read with only recording_settings.enabled changed when a read finds recording off", async () => {
    const api = new FakeApi();
    await provision(makeDeps({ api, timeoutRunner: new ManualTimeouts().runner }));
    const assistant = api.assistants[0];
    if (assistant === undefined) {
      throw new Error("the first run created no assistant");
    }
    assistant.telephony_settings = {
      default_texml_app_id: "app-for-assistant-0001-uuid",
      supports_unauthenticated_web_calls: false,
      recording_settings: { enabled: false, channels: "single", format: "wav", stop_on_conversation_end: true },
    };

    const before = api.requests.length;
    await provision(makeDeps({ api, timeoutRunner: new ManualTimeouts().runner }));
    const requests = api.requests.slice(before);

    const updates = requests.filter(
      (r) => r.method === "POST" && r.path === "/ai/assistants/assistant-0001-uuid",
    );
    expect(updates).toHaveLength(1);
    const body = updates[0]?.body as Record<string, unknown>;
    expect(body["telephony_settings"]).toEqual({
      default_texml_app_id: "app-for-assistant-0001-uuid",
      supports_unauthenticated_web_calls: false,
      recording_settings: { enabled: true, channels: "single", format: "wav", stop_on_conversation_end: true },
    });
    expect(api.assistants[0]?.telephony_settings).toEqual(body["telephony_settings"]);
  });
});

describe("the greeting read-backs T23 accepts", () => {
  /**
   * The run's own ids file, so the second run prints `unchanged` everywhere
   * instead of writing the ids again.
   */
  async function firstRun(api: FakeApi): Promise<Record<string, unknown>> {
    const first = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(first);
    return JSON.parse(first.written[0] ?? "{}") as Record<string, unknown>;
  }

  it("counts a greeting read back as null or absent as unchanged", async () => {
    const api = new FakeApi();
    const idsFile = await firstRun(api);
    const stored = api.assistants[0];
    if (stored === undefined) {
      throw new Error("the first run created no assistant");
    }

    stored.managed["greeting"] = null;
    const before = api.requests.length;
    const second = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides: { idsFile } });
    await provision(second);
    expect(api.requests.slice(before).every((r) => r.method === "GET")).toBe(true);
    expect(second.lines).toContain("assistant Duinvezel Support (assistant-0001-uuid): unchanged");

    const beforeAbsent = api.requests.length;
    delete stored.managed["greeting"];
    const third = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides: { idsFile } });
    await provision(third);
    expect(api.requests.slice(beforeAbsent).every((r) => r.method === "GET")).toBe(true);
    expect(third.lines).toContain("assistant Duinvezel Support (assistant-0001-uuid): unchanged");
  });
});

describe("the state the T11 run left", () => {
  /* T11 sent the Disclosure line as the greeting, and a disclosure tool whose
   * body_parameters asked the model for session_id with no preset (DEBUGLOG
   * issues 18 and 19). */
  const OLD_GREETING =
    "{{greeting_line}}, you've reached Duinvezel fiber support. I'm an automated assistant, " +
    "and this call is recorded so we can improve our service.";

  /** Rewinds the assistant's greeting and the disclosure tool to the shapes the T11 run created. */
  function rewindToT11(api: FakeApi): void {
    const stored = api.assistants[0];
    if (stored === undefined) {
      throw new Error("the first run created no assistant");
    }
    stored.managed["greeting"] = OLD_GREETING;
    const disclosure = api.tools.find((tool) => tool.body["display_name"] === "duinvezel-log-disclosure");
    if (disclosure === undefined) {
      throw new Error("the first run created no disclosure tool");
    }
    disclosure.body = {
      display_name: "duinvezel-log-disclosure",
      type: "webhook",
      timeout_ms: 5000,
      webhook: {
        name: "log_disclosure",
        description: "Records that the disclosure was played on this call.",
        url: "https://voice-context-00d2df1a-d.telnyxcompute.com/tools/disclosure",
        method: "POST",
        async: false,
        body_parameters: {
          type: "object",
          properties: { session_id: { type: "string" } },
          required: ["session_id"],
          additionalProperties: false,
        },
      },
    };
  }

  async function t11Account(): Promise<{ api: FakeApi; idsFile: Record<string, unknown> }> {
    const api = new FakeApi();
    const first = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(first);
    rewindToT11(api);
    return { api, idsFile: JSON.parse(first.written[0] ?? "{}") as Record<string, unknown> };
  }

  it("a dry run against the old greeting prints would update (greeting) and sends no write", async () => {
    const { api, idsFile } = await t11Account();
    const before = api.requests.length;
    const deps = makeDeps({
      api,
      timeoutRunner: new ManualTimeouts().runner,
      overrides: { dryRun: true, idsFile },
    });
    await provision(deps);

    expect(api.requests.slice(before).every((r) => r.method === "GET")).toBe(true);
    expect(deps.lines).toEqual([
      "secret mcp_enc_key: present",
      "tool duinvezel-log-disclosure (tool-0001-uuid): would update (webhook)",
      "tool duinvezel-transfer (tool-0002-uuid): unchanged",
      "tool duinvezel-hangup (tool-0003-uuid): unchanged",
      "mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): unchanged",
      "assistant Duinvezel Support (assistant-0001-uuid): would update (greeting)",
      "phone_number ...0143 (pn-0001): unchanged",
      "ids infra/ids.json: unchanged",
    ]);
    expect(deps.written).toHaveLength(0);
  });

  it("the real run updates the disclosure tool's preset and the assistant's greeting, and nothing else", async () => {
    const { api, idsFile } = await t11Account();
    const before = api.requests.length;
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides: { idsFile } });
    await provision(deps);
    const requests = api.requests.slice(before);

    expect(requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual([
      "PATCH /ai/tools/tool-0001-uuid",
      "POST /ai/assistants/assistant-0001-uuid",
    ]);
    expect(deps.lines).toEqual([
      "secret mcp_enc_key: present",
      "tool duinvezel-log-disclosure (tool-0001-uuid): updated (webhook)",
      "tool duinvezel-transfer (tool-0002-uuid): unchanged",
      "tool duinvezel-hangup (tool-0003-uuid): unchanged",
      "mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): unchanged",
      "assistant Duinvezel Support (assistant-0001-uuid): updated (greeting)",
      "phone_number ...0143 (pn-0001): unchanged",
      "ids infra/ids.json: unchanged",
    ]);

    const patch = requests.find((r) => r.method === "PATCH")?.body as Record<string, unknown>;
    const webhook = patch["webhook"] as Record<string, unknown>;
    expect(webhook["preset_body_fields"]).toEqual({ session_id: "{{session_id}}" });
    expect(webhook["body_parameters"]).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect((requests.find((r) => r.method === "POST")?.body as Record<string, unknown>)["greeting"]).toBe("");
  });

  it("the run after that prints unchanged for every resource", async () => {
    const { api, idsFile } = await t11Account();
    await provision(makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides: { idsFile } }));

    const before = api.requests.length;
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides: { idsFile } });
    await provision(deps);

    expect(api.requests.slice(before).every((r) => r.method === "GET")).toBe(true);
    expect(deps.lines).toEqual([
      "secret mcp_enc_key: present",
      "tool duinvezel-log-disclosure (tool-0001-uuid): unchanged",
      "tool duinvezel-transfer (tool-0002-uuid): unchanged",
      "tool duinvezel-hangup (tool-0003-uuid): unchanged",
      "mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): unchanged",
      "assistant Duinvezel Support (assistant-0001-uuid): unchanged",
      "phone_number ...0143 (pn-0001): unchanged",
      "ids infra/ids.json: unchanged",
    ]);
    expect(deps.written).toHaveLength(0);
  });
});

describe("the state the runs before T29 left", () => {
  /* Before T29 the transfer tool's `transfer` object held only `targets` and
   * `from`: a blind transfer with no engineer acceptance and no voicemail
   * detection (ADR-021, DEBUGLOG issues 27 and 28). */
  function rewindTransferToPreT29(api: FakeApi): void {
    const transfer = api.tools.find((tool) => tool.body["display_name"] === "duinvezel-transfer");
    if (transfer === undefined) {
      throw new Error("the first run created no transfer tool");
    }
    transfer.body = {
      display_name: "duinvezel-transfer",
      type: "transfer",
      timeout_ms: 5000,
      transfer: {
        targets: [{ name: "Duinvezel support engineer", to: TRANSFER_TO }],
        from: PHONE_NUMBER,
      },
    };
  }

  it("a real run updates the transfer to the warm transfer, and the run after prints unchanged everywhere", async () => {
    const api = new FakeApi();
    const first = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(first);
    const idsFile = JSON.parse(first.written[0] ?? "{}") as Record<string, unknown>;
    rewindTransferToPreT29(api);

    const before = api.requests.length;
    const second = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides: { idsFile } });
    await provision(second);
    const requests = api.requests.slice(before);

    expect(requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual([
      "PATCH /ai/tools/tool-0002-uuid",
    ]);
    expect(second.lines).toEqual([
      "secret mcp_enc_key: present",
      "tool duinvezel-log-disclosure (tool-0001-uuid): unchanged",
      "tool duinvezel-transfer (tool-0002-uuid): updated (transfer)",
      "tool duinvezel-hangup (tool-0003-uuid): unchanged",
      "mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): unchanged",
      "assistant Duinvezel Support (assistant-0001-uuid): unchanged",
      "phone_number ...0143 (pn-0001): unchanged",
      "ids infra/ids.json: unchanged",
    ]);

    const patch = requests.find((r) => r.method === "PATCH")?.body as Record<string, unknown>;
    expect(patch["transfer"]).toEqual({
      targets: [{ name: "Duinvezel support engineer", to: TRANSFER_TO }],
      from: PHONE_NUMBER,
      warm_transfer_instructions:
        "Tell the engineer in one or two short sentences what the customer needs " +
        "and what has been done on this call, such as verification, a line check or a ticket. " +
        "Give the customer's first name only if they were verified, " +
        "and never read out a full account number. " +
        "Then ask whether they can take the call now.",
      warm_transfer_acceptance: { enabled: true },
      voicemail_detection: {
        detection_mode: "premium",
        on_voicemail_detected: { action: "stop_transfer" },
      },
    });

    const beforeThird = api.requests.length;
    const third = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides: { idsFile } });
    await provision(third);

    expect(api.requests.slice(beforeThird).every((r) => r.method === "GET")).toBe(true);
    expect(third.lines).toEqual([
      "secret mcp_enc_key: present",
      "tool duinvezel-log-disclosure (tool-0001-uuid): unchanged",
      "tool duinvezel-transfer (tool-0002-uuid): unchanged",
      "tool duinvezel-hangup (tool-0003-uuid): unchanged",
      "mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): unchanged",
      "assistant Duinvezel Support (assistant-0001-uuid): unchanged",
      "phone_number ...0143 (pn-0001): unchanged",
      "ids infra/ids.json: unchanged",
    ]);
    expect(third.written).toHaveLength(0);
  });
});

describe("the tools the script does not own", () => {
  it("gets no request to any of the five existing tools' ids", async () => {
    const api = new FakeApi();
    const existing = [
      { id: "existing-spike-log", display_name: "spike_log", type: "webhook" },
      { id: "existing-default-transfer", display_name: "Default transfer", type: "transfer" },
      { id: "existing-take-message", display_name: "take-message", type: "webhook" },
      { id: "existing-get-weather", display_name: "get-weather", type: "webhook" },
      { id: "existing-default-hangup", display_name: "Default hangup", type: "hangup" },
    ];
    for (const tool of existing) {
      api.tools.push({
        id: tool.id,
        body: { display_name: tool.display_name, type: tool.type, timeout_ms: 5000, [tool.type]: {} },
      });
    }

    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(deps);

    for (const tool of existing) {
      for (const request of api.requests) {
        expect(request.path).not.toContain(tool.id);
        expect(request.bodyText ?? "").not.toContain(tool.id);
      }
    }
    expect(api.tools).toHaveLength(8);
    const ourCreates = api.requests.filter((r) => r.method === "POST" && r.path === "/ai/tools");
    expect(ourCreates).toHaveLength(3);
    /* The assistant's tool_ids stays empty: the five stay unattached, and so do the three. */
    const assistantCreate = api.requests.find((r) => r.method === "POST" && r.path === "/ai/assistants");
    expect((assistantCreate?.body as Record<string, unknown>)["tool_ids"]).toEqual([]);
  });
});

describe("the phone number", () => {
  it("sends the plus as %2B, and one PATCH carries only connection_id when the number sits elsewhere", async () => {
    const api = new FakeApi();
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(deps);

    const lookup = api.requests.find((r) => r.method === "GET" && r.path === "/phone_numbers");
    expect(lookup?.query.get("filter[phone_number]")).toBe("+12025550143");
    expect(lookup?.url).toContain("filter%5Bphone_number%5D=%2B12025550143");
    expect(lookup?.url).not.toContain("+12025550143");

    const patches = api.requests.filter((r) => r.method === "PATCH" && r.path.startsWith("/phone_numbers/"));
    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe("/phone_numbers/pn-0001");
    expect(patches[0]?.body).toEqual({ connection_id: "app-for-assistant-0001-uuid" });
    expect(deps.lines.at(-2)).toContain("the number needs a few minutes before calls go through");
  });

  it("sends a second PATCH when the number drifts back, and prints unchanged when it stays", async () => {
    const api = new FakeApi();
    await provision(makeDeps({ api, timeoutRunner: new ManualTimeouts().runner }));

    const attached = await runTwice(api);
    expect(attached.lines).toContain("phone_number ...0143 (pn-0001): unchanged");
    expect(attached.requests.every((r) => r.method === "GET")).toBe(true);

    const drifted = api.phoneNumbers[0];
    if (drifted === undefined) {
      throw new Error("no phone number in the fake");
    }
    drifted.connection_id = "app-of-spike-routing";
    const before = api.requests.length;
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(deps);
    const patches = api.requests
      .slice(before)
      .filter((r) => r.method === "PATCH" && r.path.startsWith("/phone_numbers/"));
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ connection_id: "app-for-assistant-0001-uuid" });
    expect(deps.lines).toContain(
      "phone_number ...0143 (pn-0001): updated (connection_id); the number needs a few minutes before calls go through",
    );
  });
});
