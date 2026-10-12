# T11. Assistant provisioning script

**Phase** 2 · **Depends on** T10, T12 · **Hands-on** Thiago runs the script and makes the test calls · **Code by** implementer agent

## Goal

One idempotent script, `scripts/provision.ts`, creates or updates everything on the Telnyx side from the repo, so the assistant is reproducible and reviewable. A second run changes nothing.

## Read first

- `docs/WORKFLOW.md`, the variable contract. `docs/ARCHITECTURE.md`, sections Call setup latency budget and Security model. `docs/DECISIONS.md`, ADR-008, ADR-009, ADR-010, ADR-015 and ADR-020.
- `DEBUGLOG.md`, the S2, S3 and S4 findings, including how the API reads back what the portal made (S2, Read back through the API), and issues 5 and 13.
- `tasks/T12-workflow-content.md`, for `buildConversationFlow` and `loadInstructions`, which this script calls.
- Telnyx's API reference (fetch them). Assistants at https://developers.telnyx.com/api-reference/assistants/create-an-assistant.md, and `list-assistants.md`, `get-an-assistant.md` and `update-an-assistant.md` in the same folder. MCP servers at https://developers.telnyx.com/api-reference/mcp-servers/create-mcp-server.md, and `list-mcp-servers.md` and `update-mcp-server.md` next to it. Per-caller credentials at https://developers.telnyx.com/docs/inference/ai-assistants/per-caller-credentials.md.
- Shared tools are not in the API reference. Telnyx's own SDK lists `GET /ai/tools`, `POST /ai/tools` and `PATCH /ai/tools/{tool_id}` (https://github.com/team-telnyx/telnyx-node/blob/master/api.md).
- `AGENTS.md`, all of it.

## Files

- `scripts/provision.ts`, the entry point, and its modules in `scripts/provision/`, an API client that takes an injected `fetch` and timeout runner, the desired state, the comparison and the ids file.
- `scripts/test/*.test.ts`.
- `scripts/package.json` and `scripts/tsconfig.json`, a new workspace, plus `"scripts"` in the root `package.json` workspaces, the lock file that `npm install` updates, and `scripts/test/**/*.test.ts` in `vitest.config.ts`.

Thiago runs it from the repo root with `node scripts/provision.ts`, or with `--dry-run`, on Node 26's built-in type stripping and with no build step. So it uses only erasable TypeScript, its relative imports end in `.ts`, and its `tsconfig.json` sets `allowImportingTsExtensions` and `erasableSyntaxOnly`, as `assistant/` does. It imports only `node:` built-ins, `zod` and `../assistant/*.ts`, never `packages/` or `functions/`, whose sources import with `.js` paths that Node cannot run without a build. No new dependency, and zod validates every response the script reads.

## What it manages

In this order. Each step reads first, and creates or updates only when something differs. The script only ever touches the resources it names. Every other assistant, MCP server and shared tool on the account stays as it is, the `spike-routing` assistant, the `mcp-spike` server and the tools `spike_log`, "Default transfer", `take-message`, `get-weather` and "Default hangup" among them.

The base URL is `https://api.telnyx.com/v2`. The function URLs are the `invokeUrl` values in `infra/ids.json`.

1. **The integration secret `mcp_enc_key`.** The script checks that `GET /integration_secrets` lists the identifier `mcp_enc_key` and stops before any write when it does not. It never writes it, because T10 wrote it from the one saved value together with the edge secret `MCP_ENC_KEY`, and a mismatch crashes a call at its first tool use (DEBUGLOG issue 13).
2. **Three shared tools**, found by `display_name` in `GET /ai/tools` (read every page). A create is `POST /ai/tools` and an update `PATCH /ai/tools/{id}`, with the body `{ display_name, type, timeout_ms, <type>: { ... } }`, where the object's name is the tool's type, as in Telnyx's SDK. A read returns that object as `tool_definition` (DEBUGLOG, S2 findings). Every tool has `timeout_ms` 5,000, like the ones on the account.
   - `duinvezel-log-disclosure`, type `webhook`. Its `webhook` object is `name` `log_disclosure`, `description` "Records that the disclosure was played on this call.", `url` voice-context's `invokeUrl` plus `/tools/disclosure`, `method` `POST`, `async` false, and `body_parameters` `{ type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false }`. The tool node fills `session_id` from the dynamic variable of the same name (S2, answer 4).
   - `duinvezel-transfer`, type `transfer`. Its `transfer` object is `targets` `[{ name: "Duinvezel support engineer", to: <TRANSFER_TO> }]` and `from` `<DUINVEZEL_PHONE_NUMBER>`, the assistant's own number, so the person answering sees the support line.
   - `duinvezel-hangup`, type `hangup`. Its `hangup` object is `description` "Ends the call after the goodbye line."
3. **The MCP server `duinvezel-voice-tools`**, found by `name` in `GET /ai/mcp_servers` (read every page with `page[size]=100`). A create is `POST /ai/mcp_servers` and an update `PUT /ai/mcp_servers/{id}` with the full body. Type `http` (S3), `url` voice-tools' `invokeUrl` plus `/mcp`, `api_key_ref` exactly `{{mcp_token | mcp_enc_key}}` (ADR-008), and `allowed_tools` `["verify_account", "check_area_status", "run_line_diagnostics", "report_outage", "create_ticket"]`, the order of `docs/ARCHITECTURE.md`, MCP tools.
4. **The assistant `Duinvezel Support`**, found by `name` in `GET /ai/assistants`, then read in full with `GET /ai/assistants/{id}`. A create is `POST /ai/assistants` and an update `POST /ai/assistants/{id}`, which keeps the fields it does not receive.
   - `model` `moonshotai/Kimi-K2.6`, `instructions` the text of `assistant/instructions/base.md` from `loadInstructions()`, and `enabled_features` `["telephony"]`, which lets the assistant take calls.
   - `greeting` is the Disclosure line, the `message` of the flow's `n_disclosure` node. In S2 a speak start node replaced the greeting, so it never plays twice, and it covers a call where the workflow does not start.
   - `voice_settings` is `spike-routing`'s, which S2 proved on the phone path, `{ voice: "Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02", voice_speed: 1, similarity_boost: 0.5, style: 0, use_speaker_boost: true, language_boost: "English", expressive_mode: true, background_audio: { type: "predefined_media", value: "silence", volume: 0.5 } }`.
   - `dynamic_variables` holds the defaults of the variable contract in `docs/WORKFLOW.md`, all strings. `dynamic_variables_webhook_url` is voice-context's `invokeUrl` plus `/dv`, and `dynamic_variables_webhook_timeout_ms` is 4,000 (`docs/ARCHITECTURE.md`, Call setup latency budget).
   - `mcp_servers` is `[{ id, allowed_tools }]` for the server above, with the same five tools.
   - `tool_ids` is `[]`. Transfer, hangup and the disclosure log run only on their tool nodes (ADR-020), so the model cannot call them from a prompt node. An update that sends `tool_ids` replaces the attached shared tools.
   - `conversation_flow` is `buildConversationFlow` with the three tool ids and the instructions from `loadInstructions()`.
   - `telephony_settings.recording_settings.enabled` is `true`, because the disclosure tells the caller the call is recorded. The API's default is `true` already, so a create sends no `telephony_settings`. When a read finds recording off, the update sends `telephony_settings` as the API returned it with only that field changed, so the TeXML application id and the other settings stay as they are.
5. **The phone number.** `GET /phone_numbers?filter[phone_number]=<DUINVEZEL_PHONE_NUMBER>`, with the query built by `URLSearchParams`, so the plus reaches the API as `%2B`. When its `connection_id` is not the assistant's `telephony_settings.default_texml_app_id`, the script sends `PATCH /phone_numbers/{id}` with `{ connection_id }` and nothing else. That moves the number from `spike-routing`'s application to the new assistant's. S2 found that a number hangs up for a few minutes after it is attached, so the script then prints that the number needs a few minutes before calls go through.

**Ids.** Every id the script creates or finds goes into `infra/ids.json`, as `assistant` (`id`, `name`, `texmlAppId`), `mcpServer` (`id`, `name`), `tools` (`logDisclosure`, `transfer` and `hangup`, each with `id` and `name`) and `phoneNumber` (`id`). The file holds no phone number. It is written only when a value changed, with two-space indentation and a final newline, and the keys the script does not own (`kvNamespaceId`, `functions`) stay as they are.

**Idempotency.** Each resource is found by its name before anything is created. A create sends `Idempotency-Key: duinvezel-<kind>-<the first 16 hex characters of the SHA-256 of the body>`, with `<kind>` one of `tool`, `mcp-server` and `assistant`, so a create that timed out and is run again is replayed instead of doubled (ADR-015, DEBUGLOG issue 5). An update goes out only when a field the script manages differs from what the API returns, and it sends only that resource's managed fields.

**The comparison.** The script compares only what it sends.

- An object matches when every key the script sends matches the API's value for that key. Keys the API adds are ignored, such as a node's `position`, a tool node's resolved `tool`, or nulls for fields the script leaves out.
- A list matches when it has the same length and each item matches in order, with two exceptions. `conversation_flow.nodes` match by `id` in any order, while edges keep their order, which is their evaluation order. The assistant's attached shared tools are the `tool_id`s of the entries in its `tools` list, because the API returns no `tool_ids` field, and they match `tool_ids` as a set.
- Numbers match by value, so the API's `300.0` matches `300`.
- A shared tool's `<type>` object is compared with the API's `tool_definition`.

**Output.** One line per resource, `created`, `updated` with the names of the fields that changed, or `unchanged`, plus the secret check and the number. Lines hold ids, names and field names, never the API key, a secret, a token, or a phone number beyond its last four digits.

**Inputs and errors.**

- The script reads `TELNYX_API_KEY`, `TRANSFER_TO` and `DUINVEZEL_PHONE_NUMBER` from the environment, which Thiago loads from `~/.config/telnyx/env`. When one is missing, or a number is not E.164 (a plus and 7 to 15 digits), it stops before any request and names the variable, never its value.
- `--dry-run` sends only GET requests, prints what a real run would do and writes no file.
- Every request has a 15-second timeout through the injected timeout runner, and is aborted when it fires. A timeout stops the run and says that the outcome is unknown, so the next run reads before it writes.
- An answer that is not 2xx stops the run with the method, the path without its query, the status and the API's first error code and title, never the body that was sent. A 403, and any error that mentions 10039 or a spend limit, stops it at once.
- The reference leaves some response wrappers unclear. The MCP server list is documented as a bare array, while the SDK reads it as a page, and creates may or may not wrap the object in `data`. The schemas accept both forms and nothing looser.

## Tests

With a fake `fetch` that records every request and answers like the API, and a manual timeout runner. Fake numbers only, never a real one.

- A first run against an empty account checks the secret, creates the three tools, the MCP server and the assistant in that order, attaches the number and writes the ids.
- A second run against what the first run created sends no create and no update, and prints `unchanged` for every resource. Its fake API answers the way the S2 read-back shows, with nodes in another order, a `position` on every node, a resolved `tool` on tool nodes, nulls for unsent fields, the duration as `300.0` and no `tool_ids` field.
- A changed edge order, a changed instruction file and a changed `allowed_tools` each count as a difference. The instruction change sends one assistant update that carries only the managed fields, and the output names `instructions`.
- A list with the five tools that are on the account today gets no request to any of their ids.
- The tool payloads equal the shapes above, with `from` the assistant's number and `to` the transfer number.
- The number lookup sends the plus as `%2B`. A number already attached prints `unchanged`. Otherwise one `PATCH` carries only `connection_id`, and the output says the number needs a few minutes.
- A read that finds recording off sends `telephony_settings` as read, with only `recording_settings.enabled` changed.
- A create that timed out and is run again sends the same `Idempotency-Key`.
- A missing `mcp_enc_key` stops before any write, and a missing or malformed environment variable stops before any request.
- `--dry-run` sends only GET requests and writes no file.
- The API key appears only in the `Authorization` header, and no output line contains it, `TRANSFER_TO`, or the phone number in full.
- An error answer stops the run with its method, path, status and code, and a 403 stops it at once.
- The payloads. The dynamic variable defaults equal the contract table in `docs/WORKFLOW.md`, read by the test. The webhook timeout is 4,000. `api_key_ref` is exactly `{{mcp_token | mcp_enc_key}}`. `allowed_tools` lists the five tools in order. `tool_ids` is empty. `conversation_flow` equals `buildConversationFlow`'s output for the tool ids the run created.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Thiago runs the script with `--dry-run`, then for real, then a second time, and the second run prints `unchanged` for every resource.
- [ ] A browser test call and a phone call each hear the Disclosure line, and voice-context logs `dv` and the disclosure for the call.
- [ ] `infra/ids.json` holds every id.

**What the first calls should show.**

- voice-context logs a `dv` line for the call. Whether its `trace_id`, the call control id, survives the platform's redaction answers DEBUGLOG issue 16.
- The Route call tool node reaches `/tools/disclosure` with the call's sid, not the default `"none"`. That shows whether the tool node still fills `session_id` when no instruction names it, which S2's instructions did.
- Whether the disclosure request is signed (After the first call, point 1).
- An MCP tool call from a prompt node, for example `verify_account` in Verify account, reaches voice-tools. That shows the prompt nodes keep the assistant's MCP tools without a tool field (ADR-020).

## Decided on 12 October

Thiago settled the card's open questions, and the sections above follow them.

1. T12 runs first, then this card.
2. The shared tools take their shapes from his `GET /v2/ai/tools` (DEBUGLOG, S2 findings), provisioning stays fully scripted, and every tool the script does not own stays as it is.
3. Transfer and hangup live only on their tool nodes, so `tool_ids` is empty.
4. Signed tool calls wait for the first call (below).
5. The script only checks that `mcp_enc_key` exists.
6. The number in `DUINVEZEL_PHONE_NUMBER` moves from `spike-routing` to the new assistant, and the script says it needs a few minutes.
7. The voice is `spike-routing`'s, with its settings.
8. `TRANSFER_TO` is Thiago's mobile, kept in his env file and never in the repo, and the transfer's `from` is the assistant's own number. In rehearsal the transfer is tested from another phone, since his mobile cannot ring itself.

## After the first call

1. **Signed tool calls.** voice-context's `/tools/disclosure` accepts only a valid Telnyx signature, and Telnyx's docs do not say whether a webhook tool's request is signed. If the first call shows it is not, Thiago decided that `/tools/disclosure` accepts a request without signature headers only when its `session_id` names an existing session, because the 32-character sid reaches only Telnyx, through `/dv`, and it logs that the request was unsigned. A request whose signature fails stays a 403. One limit of that capability is that the sid is an unkeyed hash of the call control id (`packages/shared/src/kv-keys.ts`), and the actor invocation records name each `Session` instance by its sid (DEBUGLOG issue 16), so anyone with access to the account's logs can find it. That is a voice-context change, written as its own follow-up once the call has shown it. Routing works either way, because the edges read call setup variables.

## Out of scope

The workflow's content (T12), path tests (T13), the canary (T14), demo tooling (T15).
