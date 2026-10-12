# T12. Workflow content

**Phase** 2 · **Depends on** T19 · **Code by** implementer agent

## Goal

`assistant/flow.ts` builds the assistant's `conversation_flow` from typed definitions that mirror `docs/WORKFLOW.md`, and `assistant/instructions/` holds the base instructions and the instructions of each prompt node. The code is pure and makes no network call, so the payload that T11's provisioning script sends is exactly the one this card's tests check.

## Read first

- `docs/WORKFLOW.md`, all of it. It is the source of truth for every node, edge, scripted line and instruction, and this card follows it.
- `docs/DECISIONS.md`, ADR-010, ADR-011, ADR-012, ADR-013 and ADR-020.
- `docs/ARCHITECTURE.md`, sections MCP tools and Identity levels, and the answers each tool gives in `functions/voice-tools/src/mcp/tools/`.
- `DEBUGLOG.md`, S2 findings, including how the API reads back a workflow made in the portal.
- Telnyx's workflow guide at https://developers.telnyx.com/docs/inference/ai-assistants/workflows.md and the `conversation_flow` schema in https://developers.telnyx.com/api-reference/assistants/create-an-assistant.md (fetch them).
- `AGENTS.md`, all of it.

## Files

- `assistant/flow.ts`, the typed definitions and `buildConversationFlow`.
- `assistant/instructions.ts`, which reads the instruction files.
- `assistant/instructions/base.md` and one file per prompt node, `verify.md`, `outage-help.md`, `triage.md`, `diagnose.md`, `repair-ticket.md`, `take-message.md` and `degraded.md`.
- `assistant/test/flow.test.ts`.
- `assistant/package.json` and `assistant/tsconfig.json`, a new workspace, plus `"assistant"` in the root `package.json` workspaces, the lock file that `npm install` updates, and `assistant/test/**/*.test.ts` in `vitest.config.ts`, so `npm run check` type-checks and tests it.

T11's script runs on Node 26 without a build step, and it imports this module. So `assistant/` uses only erasable TypeScript, which means no `enum`, `namespace` or parameter properties, and its relative imports end in `.ts`. Its `tsconfig.json` extends the base with `allowImportingTsExtensions` and `erasableSyntaxOnly`. It imports nothing from `packages/` or `functions/`, whose sources import with `.js` paths that Node cannot run without a build. No new dependency.

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
- `buildConversationFlow({ toolIds, instructions })` returns the object. `toolIds` holds `logDisclosure`, `transfer` and `hangup`, and `instructions` holds the text of each prompt node. `loadInstructions()` in `instructions.ts` reads the files, and it is the only function that does I/O. It returns each text without trailing whitespace, so a file's final newline never makes T11 see a difference from what the API stored.

**Tools per prompt node** (ADR-020). Every prompt node sees all five MCP tools, so a prompt node carries no tool field. The payload sends neither `shared_tool_ids` nor `tools_mode`, which is how a node made in the portal reads back, with every tool of the assistant (DEBUGLOG, S2 findings). Each prompt node's definition still lists its MCP tools from the Nodes table as data, without the tools marked stretch, and its instructions name exactly those tools.

## Instructions

Each file in `assistant/instructions/` holds its draft from `docs/WORKFLOW.md` word for word, without the heading or the code fence. `base.md` is the assistant-level instructions, which T11 sends, and it is not part of `conversation_flow`.

- The base draft ends with one context line that names every custom variable an edge reads, `session_ok`, `area_outage`, `repeat_caller`, `needs_verification` and `diagnostics_enabled`, and nothing else.
- Outage help has no line about `subscribe_updates` until T16 builds the tool.
- The Verify account draft covers the answers of `verify_account` for a misheard or missing value (T19), so the model asks the caller to repeat it one character at a time and nothing counts against them.
- No instruction and no message contains `session_id` or `mcp_token`.

## Tests

- The invariants. Every speak node has exactly one default edge. Every tool node with edges has exactly one default edge, End call has none, and Transfer has only its one default edge. Default edges leave only speak and tool nodes. On each node, variable edges come before LLM edges. Every edge's start and target exist, every node except Disclosure has an incoming edge, and node and edge ids are unique.
- The payload. `start_node_id` is `n_disclosure`, the 13 nodes have the ids, types and names of the Nodes table, every prompt node has the `instructions_mode` above and no `shared_tool_ids` or `tools_mode`, every variable edge has the literal kind above, and the three tool nodes carry the ids passed in.
- Against `docs/WORKFLOW.md`, read by the test.
  - Each scripted line appears word for word as its node's `message`.
  - Each instruction file equals its draft, and `loadInstructions()` returns it without trailing whitespace.
  - Each prompt node's tool data equals its entry in the Nodes table, leaving out the tools marked stretch.
  - Each prompt node's instructions name every tool of its entry and no other MCP tool, matched as whole words. The MCP tools are every tool the Nodes table lists. `base.md` names none.
- Every `{{variable}}` in a message or an instruction is in the variable contract of `docs/WORKFLOW.md` or starts with `telnyx_`.
- `base.md` contains `{{name}}` for every variable that a variable edge of the built flow reads, apart from those starting with `telnyx_`.
- No message or instruction contains `session_id` or `mcp_token`.

## Acceptance

- [ ] `npm run check` passes.
- [ ] The tests above pass with the real instruction files.
- [ ] Nothing calls the network, and nothing is provisioned.

## Decided on 12 October

Thiago settled the card's open questions.

1. Every prompt node sees all five MCP tools, each node's instructions name the tools it may use, and the server's identity checks stay the gate (ADR-020).
2. T12 runs first, then T11.
3. Outage help drops its `subscribe_updates` line until T16.
4. The base instructions get one line that names every variable an edge reads, and no instruction ever carries `mcp_token` or `session_id`.

## Out of scope

Provisioning (T11), path tests (T13), `subscribe_updates` and edges to another assistant (T16).
