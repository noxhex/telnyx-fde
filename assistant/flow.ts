/**
 * `assistant/flow.ts` — the assistant's `conversation_flow`, built from
 * typed definitions that mirror `docs/WORKFLOW.md` word for word (card T12).
 * The code is pure: no I/O, no clock, no network. T11's provisioning script
 * imports this module on plain Node 26, so it is erasable TypeScript only
 * and every relative import ends in `.ts`.
 *
 * Node and edge ids are stable, because T11 compares what it sent with what
 * the API returns. `edgeDefinitions` keeps the declaration order of the
 * document's Edges section per node: that order is evaluation order, the
 * first true variable edge wins and the default edge is the fallback (the
 * Telnyx workflow guide, "Evaluation order").
 *
 * Every prompt node sees all five MCP tools of the `duinvezel-voice-tools`
 * server, so a prompt node carries no tool field at all — the payload sends
 * neither `shared_tool_ids` nor `tools_mode`, which is how a node made in
 * the portal reads back (ADR-020, DEBUGLOG S2 findings). Each prompt node's
 * definition still lists the MCP tools its instructions name, as data, so a
 * test can check the two against each other and against the Nodes table.
 *
 * Variable edges never use a boolean literal: every boolean dynamic variable
 * holds the string `"true"` or `"false"`, and the portal's editor types
 * `true` as a Boolean by default, which never matches (S2, answer 1). The
 * duration guard compares `telnyx_conversation_duration_secs` against a
 * Number literal (S2, answer 2).
 */

/** The five MCP tools of the `duinvezel-voice-tools` server (docs/ARCHITECTURE.md, MCP tools). */
export type McpToolName =
  | "verify_account"
  | "check_area_status"
  | "run_line_diagnostics"
  | "report_outage"
  | "create_ticket";

/** Ids of the three shared tools, created by T11 before the assistant. */
export type ToolIds = {
  logDisclosure: string;
  transfer: string;
  hangup: string;
};

/** The base instructions plus one text per prompt node, as `loadInstructions()` returns them. */
export type Instructions = {
  base: string;
  verify: string;
  outageHelp: string;
  triage: string;
  diagnose: string;
  repairTicket: string;
  takeMessage: string;
  degraded: string;
};

/** The API shape the assistant create/update accepts. */
export type FlowCondition =
  | { type: "llm"; prompt: string }
  | {
      type: "expression";
      expression: {
        type: "comparison";
        op: string;
        left: { type: "variable"; name: string };
        right: { type: "string_literal"; value: string } | { type: "number_literal"; value: number };
      };
    }
  | { type: "default" };

export type SpeakFlowNode = { id: string; name: string; type: "speak"; message: string };
export type ToolFlowNode = {
  id: string;
  name: string;
  type: "tool";
  shared_tool_id: string;
  message?: string;
};
export type PromptFlowNode = {
  id: string;
  name: string;
  type: "prompt";
  instructions: string;
  instructions_mode: "append" | "replace";
};
export type FlowNode = SpeakFlowNode | ToolFlowNode | PromptFlowNode;

export type FlowEdge = {
  id: string;
  start_node_id: string;
  target: { type: "node"; node_id: string };
  condition: FlowCondition;
};

export type ConversationFlow = {
  start_node_id: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

/** Internal definitions, mirroring the Nodes and Edges tables of `docs/WORKFLOW.md`. */

export type SpeakNodeDef = { kind: "speak"; id: string; name: string; message: string };
export type ToolNodeDef = {
  kind: "tool";
  id: string;
  name: string;
  tool: keyof ToolIds;
  /** Only End call says its line before the hangup runs. */
  message?: string;
};
export type PromptNodeDef = {
  kind: "prompt";
  id: string;
  name: string;
  instructionsMode: "append" | "replace";
  instructionsKey: keyof Omit<Instructions, "base">;
  /** The MCP tools this node's instructions name, without the ones marked stretch. */
  tools: readonly McpToolName[];
};
export type NodeDef = SpeakNodeDef | ToolNodeDef | PromptNodeDef;

export type EdgeConditionDef =
  | { kind: "default" }
  | { kind: "llm"; prompt: string }
  | {
      kind: "variable";
      op: "==" | "!=" | ">=";
      variable: string;
      right: { type: "string_literal"; value: string } | { type: "number_literal"; value: number };
    };

export type EdgeDef = {
  id: string;
  from: string;
  to: string;
  condition: EdgeConditionDef;
};

export const START_NODE_ID = "n_disclosure";

/**
 * The 13 nodes of the Nodes table, in its order. Messages are the scripted
 * lines of `docs/WORKFLOW.md` word for word; the API reference settles the
 * shapes: a speak node is `{ id, name, type, message }`, a tool node adds
 * `shared_tool_id` (and `message` only on End call), a prompt node sets
 * `instructions_mode` explicitly because the API default is `replace` —
 * `append` everywhere except Degraded (ADR-012).
 */
export const nodeDefinitions: readonly NodeDef[] = [
  {
    kind: "speak",
    id: "n_disclosure",
    name: "Disclosure",
    message:
      "{{greeting_line}}, you've reached Duinvezel fiber support. I'm an automated assistant, " +
      "and this call is recorded so we can improve our service.",
  },
  { kind: "tool", id: "n_route", name: "Route call", tool: "logDisclosure" },
  {
    kind: "prompt",
    id: "n_verify",
    name: "Verify account",
    instructionsMode: "append",
    instructionsKey: "verify",
    tools: ["verify_account", "check_area_status"],
  },
  {
    kind: "speak",
    id: "n_outage_notice",
    name: "Outage notice",
    message:
      "There's a confirmed outage affecting {{area_name}}. Our engineers are working on it, " +
      "and we expect your service back {{outage_eta}}. Is that why you're calling, " +
      "or is there something else I can help with?",
  },
  {
    kind: "prompt",
    id: "n_outage_help",
    name: "Outage help",
    instructionsMode: "append",
    instructionsKey: "outageHelp",
    tools: ["report_outage"],
  },
  {
    kind: "prompt",
    id: "n_triage",
    name: "Triage",
    instructionsMode: "append",
    instructionsKey: "triage",
    tools: [],
  },
  {
    kind: "prompt",
    id: "n_diagnose",
    name: "Diagnose",
    instructionsMode: "append",
    instructionsKey: "diagnose",
    tools: ["run_line_diagnostics", "report_outage"],
  },
  {
    kind: "prompt",
    id: "n_ticket",
    name: "Repair ticket",
    instructionsMode: "append",
    instructionsKey: "repairTicket",
    tools: ["create_ticket"],
  },
  {
    kind: "speak",
    id: "n_handoff",
    name: "Handoff",
    message: "I'll connect you with one of our support engineers now. Please stay on the line.",
  },
  { kind: "tool", id: "n_transfer", name: "Transfer", tool: "transfer" },
  {
    kind: "prompt",
    id: "n_message",
    name: "Take message",
    instructionsMode: "append",
    instructionsKey: "takeMessage",
    tools: ["create_ticket"],
  },
  {
    kind: "prompt",
    id: "n_degraded",
    name: "Degraded",
    instructionsMode: "replace",
    instructionsKey: "degraded",
    tools: [],
  },
  {
    kind: "tool",
    id: "n_end",
    name: "End call",
    tool: "hangup",
    message: "Thanks for calling Duinvezel. Goodbye.",
  },
];

const TRUE: { type: "string_literal"; value: string } = { type: "string_literal", value: "true" };

/**
 * The edges of `docs/WORKFLOW.md`, grouped by node in the table's order and
 * keeping each node's declaration order — on each node the variable edges
 * come first (facts, ADR-011), then the LLM edges (intent), with the one
 * default edge last where the document has one. An LLM edge's prompt is the
 * document's sentence word for word.
 */
export const edgeDefinitions: readonly EdgeDef[] = [
  // Disclosure
  { id: "e_disclosure_default", from: "n_disclosure", to: "n_route", condition: { kind: "default" } },
  // Route call
  {
    id: "e_route_session_ok",
    from: "n_route",
    to: "n_degraded",
    condition: { kind: "variable", op: "!=", variable: "session_ok", right: TRUE },
  },
  {
    id: "e_route_area_outage",
    from: "n_route",
    to: "n_outage_notice",
    condition: { kind: "variable", op: "==", variable: "area_outage", right: TRUE },
  },
  {
    id: "e_route_repeat_caller",
    from: "n_route",
    to: "n_handoff",
    condition: { kind: "variable", op: "==", variable: "repeat_caller", right: TRUE },
  },
  {
    id: "e_route_needs_verification",
    from: "n_route",
    to: "n_verify",
    condition: { kind: "variable", op: "==", variable: "needs_verification", right: TRUE },
  },
  { id: "e_route_default", from: "n_route", to: "n_triage", condition: { kind: "default" } },
  // Verify account
  {
    id: "e_verify_triage",
    from: "n_verify",
    to: "n_triage",
    condition: {
      kind: "llm",
      prompt:
        "Verification succeeded, or the caller was already verified, " +
        "and they need help with their connection or account.",
    },
  },
  {
    id: "e_verify_end",
    from: "n_verify",
    to: "n_end",
    condition: {
      kind: "llm",
      prompt:
        "The caller only wanted to know whether there is an outage at a postcode and has their answer, " +
        "or wants to end the call.",
    },
  },
  {
    id: "e_verify_handoff",
    from: "n_verify",
    to: "n_handoff",
    condition: {
      kind: "llm",
      prompt:
        "The caller cannot verify, is locked out, or asks to talk to a person, " +
        "such as an engineer or an agent.",
    },
  },
  // Outage notice
  {
    id: "e_outage_notice_default",
    from: "n_outage_notice",
    to: "n_outage_help",
    condition: { kind: "default" },
  },
  // Outage help
  {
    id: "e_outage_help_verify",
    from: "n_outage_help",
    to: "n_verify",
    condition: {
      kind: "llm",
      prompt:
        "The caller has a different problem from the outage, " +
        "such as a fault that started earlier or a billing question.",
    },
  },
  {
    id: "e_outage_help_handoff",
    from: "n_outage_help",
    to: "n_handoff",
    condition: {
      kind: "llm",
      prompt: "The caller asks to talk to a person, such as an engineer or an agent.",
    },
  },
  {
    id: "e_outage_help_end",
    from: "n_outage_help",
    to: "n_end",
    condition: {
      kind: "llm",
      prompt: "The caller has nothing more to ask, or wants to end the call.",
    },
  },
  // Triage
  {
    id: "e_triage_diagnose",
    from: "n_triage",
    to: "n_diagnose",
    condition: {
      kind: "llm",
      prompt: "The caller's internet is down, slow or unstable, or they ask for a line check.",
    },
  },
  {
    id: "e_triage_ticket",
    from: "n_triage",
    to: "n_ticket",
    condition: {
      kind: "llm",
      prompt:
        "The caller needs a technician or reports physical damage, " +
        "such as a cut cable or a broken fiber box.",
    },
  },
  {
    id: "e_triage_handoff",
    from: "n_triage",
    to: "n_handoff",
    condition: {
      kind: "llm",
      prompt: "The caller asks to talk to a person, such as an engineer or an agent.",
    },
  },
  {
    id: "e_triage_end",
    from: "n_triage",
    to: "n_end",
    condition: {
      kind: "llm",
      prompt: "The caller has nothing more to ask, or wants to end the call.",
    },
  },
  // Diagnose
  {
    id: "e_diagnose_diagnostics_off",
    from: "n_diagnose",
    to: "n_ticket",
    condition: { kind: "variable", op: "!=", variable: "diagnostics_enabled", right: TRUE },
  },
  {
    id: "e_diagnose_time_guard",
    from: "n_diagnose",
    to: "n_handoff",
    condition: {
      kind: "variable",
      op: ">=",
      variable: "telnyx_conversation_duration_secs",
      right: { type: "number_literal", value: 300 },
    },
  },
  {
    id: "e_diagnose_ticket",
    from: "n_diagnose",
    to: "n_ticket",
    condition: {
      kind: "llm",
      prompt: "Diagnostics show the line needs a repair visit, or the caller wants a technician.",
    },
  },
  {
    id: "e_diagnose_end",
    from: "n_diagnose",
    to: "n_end",
    condition: {
      kind: "llm",
      prompt: "The caller has nothing more to ask, or wants to end the call.",
    },
  },
  {
    id: "e_diagnose_handoff",
    from: "n_diagnose",
    to: "n_handoff",
    condition: {
      kind: "llm",
      prompt: "The caller asks to talk to a person, such as an engineer or an agent.",
    },
  },
  // Repair ticket
  {
    id: "e_ticket_end",
    from: "n_ticket",
    to: "n_end",
    condition: {
      kind: "llm",
      prompt: "The caller has nothing more to ask, or wants to end the call.",
    },
  },
  {
    id: "e_ticket_handoff",
    from: "n_ticket",
    to: "n_handoff",
    condition: {
      kind: "llm",
      prompt: "The caller asks to talk to a person, such as an engineer or an agent.",
    },
  },
  // Handoff
  { id: "e_handoff_default", from: "n_handoff", to: "n_transfer", condition: { kind: "default" } },
  // Transfer: the one default edge is used only if the transfer fails
  { id: "e_transfer_default", from: "n_transfer", to: "n_message", condition: { kind: "default" } },
  // Take message
  {
    id: "e_message_end",
    from: "n_message",
    to: "n_end",
    condition: {
      kind: "llm",
      prompt:
        "The callback request is recorded and read back, the caller does not want one, " +
        "or the caller wants to end the call.",
    },
  },
  // Degraded
  {
    id: "e_degraded_handoff",
    from: "n_degraded",
    to: "n_handoff",
    condition: { kind: "llm", prompt: "The caller wants to speak with a person." },
  },
  {
    id: "e_degraded_end",
    from: "n_degraded",
    to: "n_end",
    condition: { kind: "llm", prompt: "The caller will call back later or wants to end the call." },
  },
];

function buildCondition(def: EdgeConditionDef): FlowCondition {
  if (def.kind === "default") {
    return { type: "default" };
  }
  if (def.kind === "llm") {
    return { type: "llm", prompt: def.prompt };
  }
  return {
    type: "expression",
    expression: {
      type: "comparison",
      op: def.op,
      left: { type: "variable", name: def.variable },
      right: def.right,
    },
  };
}

/**
 * Builds the `conversation_flow` object T11 sends. It returns exactly the
 * documented fields and no others, so the API's read-back differs only in
 * the keys the API adds (a `position` per node, a resolved `tool` on tool
 * nodes, nulls for unsent fields — DEBUGLOG, S2 findings), which T11's
 * comparison ignores.
 */
export function buildConversationFlow(input: {
  toolIds: ToolIds;
  instructions: Instructions;
}): ConversationFlow {
  const { toolIds, instructions } = input;
  const nodes: FlowNode[] = nodeDefinitions.map((def) => {
    if (def.kind === "speak") {
      return { id: def.id, name: def.name, type: "speak", message: def.message };
    }
    if (def.kind === "tool") {
      const node: ToolFlowNode = {
        id: def.id,
        name: def.name,
        type: "tool",
        shared_tool_id: toolIds[def.tool],
      };
      if (def.message !== undefined) {
        node.message = def.message;
      }
      return node;
    }
    return {
      id: def.id,
      name: def.name,
      type: "prompt",
      instructions: instructions[def.instructionsKey],
      instructions_mode: def.instructionsMode,
    };
  });
  const edges: FlowEdge[] = edgeDefinitions.map((def) => ({
    id: def.id,
    start_node_id: def.from,
    target: { type: "node", node_id: def.to },
    condition: buildCondition(def.condition),
  }));
  return { start_node_id: START_NODE_ID, nodes, edges };
}
