/**
 * `scripts/provision/desired.ts` — the desired state of the Telnyx side, as
 * the script manages it. The shapes come from the API reference and from what
 * the API read back of the portal-made spike resources (DEBUGLOG, S2
 * findings): a shared tool create sends its definition under a key named
 * after its type and reads it back as `tool_definition`.
 */

import { buildConversationFlow } from "../../assistant/flow.ts";
import type { ConversationFlow, Instructions, ToolIds } from "../../assistant/flow.ts";

export const ASSISTANT_NAME = "Duinvezel Support";
export const ASSISTANT_MODEL = "moonshotai/Kimi-K2.6";
export const MCP_SERVER_NAME = "duinvezel-voice-tools";
export const MCP_SECRET_IDENTIFIER = "mcp_enc_key";

/** Exactly `{{mcp_token | mcp_enc_key}}` (ADR-008). */
export const MCP_API_KEY_REF = "{{mcp_token | mcp_enc_key}}";

/** The five MCP tools, in the order of docs/ARCHITECTURE.md, MCP tools. */
export const ALLOWED_TOOLS: readonly string[] = [
  "verify_account",
  "check_area_status",
  "run_line_diagnostics",
  "report_outage",
  "create_ticket",
];

/** docs/ARCHITECTURE.md, Call setup latency budget (approved by Thiago on 10 October). */
export const DV_WEBHOOK_TIMEOUT_MS = 4_000;

/** Every shared tool on the account has `timeout_ms` 5,000 (S2 read-back). */
export const TOOL_TIMEOUT_MS = 5_000;

/** The voice S2 proved on the phone path, copied from `spike-routing`. */
export const VOICE_SETTINGS: Record<string, unknown> = {
  voice: "Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02",
  voice_speed: 1,
  similarity_boost: 0.5,
  style: 0,
  use_speaker_boost: true,
  language_boost: "English",
  expressive_mode: true,
  background_audio: { type: "predefined_media", value: "silence", volume: 0.5 },
};

/**
 * The defaults of the variable contract in docs/WORKFLOW.md, all strings
 * (every boolean is the string "true" or "false"). `mcp_token` has no
 * default: it is the one encrypted variable and lives only in the `/dv`
 * response.
 */
export const DYNAMIC_VARIABLE_DEFAULTS: Record<string, string> = {
  session_ok: "false",
  session_id: "none",
  greeting_line: "Hello",
  first_name: "unknown",
  caller_known: "false",
  identity_level: "anonymous",
  needs_verification: "true",
  verify_mode: "full",
  area_code: "unknown",
  area_name: "your area",
  area_outage: "false",
  outage_eta: "as soon as possible",
  repeat_caller: "false",
  diagnostics_enabled: "true",
};

export type SharedToolKey = "logDisclosure" | "transfer" | "hangup";

export type SharedToolDesired = {
  key: SharedToolKey;
  /** The create/update body, `{ display_name, type, timeout_ms, <type>: { ... } }`. */
  body: Record<string, unknown>;
};

/**
 * The three shared tools, in the order the script provisions them. The
 * transfer's `from` is the assistant's own number, so the person answering
 * sees the support line. `session_id` on the webhook tool is a preset body
 * field since T23 (DEBUGLOG issue 19): Telnyx fills the preset from the
 * dynamic variable of the same name and keeps it out of the model's view, so
 * `body_parameters` asks the model for nothing
 * (https://developers.telnyx.com/docs/inference/ai-assistants/preset-webhook-parameters).
 * Preset body fields are dropped on `GET` tools; this one is a `POST`.
 * The transfer stops at voicemail (`voicemail_detection` with
 * `stop_transfer`), and its acceptance is sent switched off rather than left
 * out, because the script compares only the keys it sends (ADR-021,
 * DEBUGLOG issue 29). The brief goes out as the empty string to clear the
 * one T29 left: Telnyx documents neither whether an update replaces a
 * tool's definition or merges into it, nor a value that removes a field.
 */
export function sharedToolBodies(input: {
  voiceContextUrl: string;
  transferTo: string;
  phoneNumber: string;
}): SharedToolDesired[] {
  return [
    {
      key: "logDisclosure",
      body: {
        display_name: "duinvezel-log-disclosure",
        type: "webhook",
        timeout_ms: TOOL_TIMEOUT_MS,
        webhook: {
          name: "log_disclosure",
          description: "Records that the disclosure was played on this call.",
          url: `${input.voiceContextUrl}/tools/disclosure`,
          method: "POST",
          async: false,
          body_parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          preset_body_fields: { session_id: "{{session_id}}" },
        },
      },
    },
    {
      key: "transfer",
      body: {
        display_name: "duinvezel-transfer",
        type: "transfer",
        timeout_ms: TOOL_TIMEOUT_MS,
        transfer: {
          targets: [{ name: "Duinvezel support engineer", to: input.transferTo }],
          from: input.phoneNumber,
          voicemail_detection: {
            detection_mode: "premium",
            on_voicemail_detected: { action: "stop_transfer" },
          },
          warm_transfer_acceptance: { enabled: false },
          warm_transfer_instructions: "",
        },
      },
    },
    {
      key: "hangup",
      body: {
        display_name: "duinvezel-hangup",
        type: "hangup",
        timeout_ms: TOOL_TIMEOUT_MS,
        hangup: { description: "Ends the call after the goodbye line." },
      },
    },
  ];
}

/** The MCP server's managed body; an update sends it in full (PUT). */
export function mcpServerBody(input: { voiceToolsUrl: string; allowedTools?: readonly string[] }): Record<
  string,
  unknown
> {
  return {
    name: MCP_SERVER_NAME,
    type: "http",
    url: `${input.voiceToolsUrl}/mcp`,
    api_key_ref: MCP_API_KEY_REF,
    allowed_tools: [...(input.allowedTools ?? ALLOWED_TOOLS)],
  };
}

/**
 * The assistant's managed body: the create sends all of it, and an update
 * sends exactly these fields again (the API keeps the fields it does not
 * receive). `greeting` is the empty string since T23: the greeting played
 * alongside the Disclosure speak start node, so every call heard the line
 * twice (DEBUGLOG issue 18). `tool_ids` is empty — transfer, hangup and the
 * disclosure log run only on their tool nodes (ADR-020).
 * `telephony_settings` is not here: the API's default switches recording on,
 * and when a read finds it off the update sends the settings as read back
 * with only that field changed.
 */
export function assistantBody(input: {
  toolIds: ToolIds;
  mcpServerId: string;
  instructions: Instructions;
  voiceContextUrl: string;
  allowedTools?: readonly string[];
  buildFlow?: (args: { toolIds: ToolIds; instructions: Instructions }) => ConversationFlow;
}): Record<string, unknown> {
  const flow = (input.buildFlow ?? buildConversationFlow)({
    toolIds: input.toolIds,
    instructions: input.instructions,
  });
  return {
    name: ASSISTANT_NAME,
    model: ASSISTANT_MODEL,
    instructions: input.instructions.base,
    enabled_features: ["telephony"],
    greeting: "",
    voice_settings: VOICE_SETTINGS,
    dynamic_variables: { ...DYNAMIC_VARIABLE_DEFAULTS },
    dynamic_variables_webhook_url: `${input.voiceContextUrl}/dv`,
    dynamic_variables_webhook_timeout_ms: DV_WEBHOOK_TIMEOUT_MS,
    mcp_servers: [{ id: input.mcpServerId, allowed_tools: [...(input.allowedTools ?? ALLOWED_TOOLS)] }],
    tool_ids: [],
    conversation_flow: flow,
  };
}
