# T12. Workflow content

**Phase** 2 · **Depends on** T19 · **Code by** implementer agent

## Goal

`assistant/flow.ts` builds the assistant's `conversation_flow` from typed definitions that mirror `docs/WORKFLOW.md`, and `assistant/instructions/` holds the base instructions and the instructions of each prompt node. The code is pure and makes no network call, so the payload that T11's provisioning script sends is exactly the one this card's tests check.

## Read first

- `docs/WORKFLOW.md`, all of it. It is the source of truth for every node, edge, scripted line and instruction, and this card follows it.
- `docs/DECISIONS.md`, ADR-010, ADR-011, ADR-012 and ADR-013.
- `docs/ARCHITECTURE.md`, sections MCP tools and Identity levels, and the answers each tool gives in `functions/voice-tools/src/mcp/tools/`.
- Telnyx's workflow guide at https://developers.telnyx.com/docs/inference/ai-assistants/workflows.md and the `conversation_flow` schema in https://developers.telnyx.com/api-reference/assistants/create-an-assistant.md (fetch them).
- `AGENTS.md`, all of it.

## Files

- `assistant/flow.ts`, the typed definitions and `buildConversationFlow`.
- `assistant/instructions.ts`, which reads the instruction files.
- `assistant/instructions/base.md` and one file per prompt node, `verify.md`, `outage-help.md`, `triage.md`, `diagnose.md`, `repair-ticket.md`, `take-message.md` and `degraded.md`.
- `assistant/test/flow.test.ts`.
- `assistant/package.json` and `assistant/tsconfig.json`, a new workspace, plus `"assistant"` in the root `package.json` workspaces, the lock file that `npm install` updates, and `assistant/test/**/*.test.ts` in `vitest.config.ts`, so `npm run check` type-checks and tests it.

T11's script runs on Node 26 without a build step, and it imports this module. So `assistant/` uses only erasable TypeScript, which means no `enum`, `namespace` or parameter properties, and its relative imports end in `.ts`. Its `tsconfig.json` extends the base with `allowImportingTsExtensions` and `erasableSyntaxOnly`. No new dependency.

## The payload

The API shape, from the reference above. Node and edge ids are stable, because T11 compares what it sent with what the API returns.

- `conversation_flow` is `{ start_node_id, nodes, edges }`, with `start_node_id` `n_disclosure`. Edges are evaluated in array order, so the array keeps the order of each node's edges in `docs/WORKFLOW.md`.
- A speak node is `{ id, name, type: "speak", message }`.
- A tool node is `{ id, name, type: "tool", shared_tool_id }`, plus `message` on End call, which says the End call line before the hangup runs. The three shared tool ids are an input to `buildConversationFlow`, because T11 creates the tools.
- A prompt node is `{ id, name, type: "prompt", instructions, instructions_mode }`. The API defaults `instructions_mode` to `replace`, so every prompt node sets it explicitly, `append` everywhere except Degraded, which is `replace` (ADR-012).
- An edge is `{ id, start_node_id, target: { type: "node", node_id }, condition }`.
  - An LLM edge's condition is `{ type: "llm", prompt }`, with the sentence from `docs/WORKFLOW.md` word for word.
  - A variable edge's condition is `{ type: "expression", expression: { type: "comparison", op, left: { type: "variable", name }, right } }`. `right` is `{ type: "string_literal", value: "true" }` for the string comparisons and `{ type: "number_literal", value: 300 }` for the duration. A boolean literal is never used, because the variables hold the strings `"true"` and `"false"` (S2).
  - A default edge's condition is `{ type: "default" }`.
- `buildConversationFlow({ toolIds, instructions })` returns the object. `toolIds` holds `logDisclosure`, `transfer` and `hangup`, and `instructions` holds the text of each prompt node. `loadInstructions()` in `instructions.ts` reads the files, and it is the only function that does I/O.

**Tools per prompt node.** Open decision 1 below. Until it is settled, each prompt node's definition lists its MCP tools from the Nodes table as data, and the payload carries no per-node tool field.

## Instructions

Each file in `assistant/instructions/` holds its draft from `docs/WORKFLOW.md` word for word, without the heading or the code fence. `base.md` is the assistant-level instructions, which T11 sends, and it is not part of `conversation_flow`. The Verify account draft already covers the answers of `verify_account` for a misheard or missing value (T19), so the model asks the caller to repeat it one character at a time and nothing counts against them.

## Tests

- The invariants from the outline. Every speak node has exactly one default edge. Every tool node with edges has exactly one default edge, End call has none, and Transfer has only its one default edge. Default edges leave only speak and tool nodes. On each node, variable edges come before LLM edges. Every edge's start and target exist, every node except Disclosure has an incoming edge, and node and edge ids are unique.
- The payload. `start_node_id` is `n_disclosure`, the 13 nodes have the ids, types and names of the Nodes table, every prompt node has the `instructions_mode` above, every variable edge has the literal kind above, and the three tool nodes carry the ids passed in.
- Against `docs/WORKFLOW.md`, read by the test. Each scripted line appears word for word as its node's `message`. Each instruction file equals its draft. Each prompt node's tool list equals its entry in the Nodes table, leaving out the tools marked stretch.
- Every `{{variable}}` in a message or an instruction is in the variable contract of `docs/WORKFLOW.md` or starts with `telnyx_`.

## Acceptance

- [ ] `npm run check` passes.
- [ ] The tests above pass with the real instruction files.
- [ ] Nothing calls the network, and nothing is provisioned.

## Open decisions

1. **Tools per node.** `docs/WORKFLOW.md` says each node enables only its own tools. The API's per-node control is `shared_tool_ids` with `tools_mode`, for shared tools, and the reference does not say whether a node can switch the assistant's MCP tools on or off. Either Thiago attaches the `mcp-spike` server to `spike-routing`, switches its tool off on one prompt node in the portal, and a read-only `GET /v2/ai/assistants/<id>` shows how the API carries that, or every prompt node keeps all five tools and the server's identity checks (ADR-013) stay the only gate.
2. **Order.** This card needs nothing from T11, and T11 provisions what it builds. So T12 runs first, then T11.
3. **`subscribe_updates`.** Outage help's draft offers it "if subscribe_updates is available". It does not exist until T16, so the proposal is to drop that line from the draft until then, rather than leave the model a line about a tool it never has.
4. **Variables the edges read.** In S2 the portal listed a custom variable only once it appeared in the assistant's text, so Thiago named the routing variables there, and nothing has shown whether edges sent through the API need the same. Either `base.md` gets one context line that names `session_ok`, `repeat_caller`, `needs_verification` and `diagnostics_enabled`, or T11's first test calls show whether edges need it.

## Out of scope

Provisioning (T11), path tests (T13), `subscribe_updates` and edges to another assistant (T16).
