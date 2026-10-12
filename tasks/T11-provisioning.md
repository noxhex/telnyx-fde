# T11. Assistant provisioning script

**Phase** 2 · **Depends on** T10, T12 · **Hands-on** Thiago runs the script and makes the test calls · **Code by** implementer agent

## Goal

One idempotent script, `scripts/provision.ts`, creates or updates everything on the Telnyx side from the repo, so the assistant is reproducible and reviewable. A second run changes nothing.

## Read first

- `docs/WORKFLOW.md`, the variable contract. `docs/ARCHITECTURE.md`, sections Call setup latency budget and Security model. `docs/DECISIONS.md`, ADR-008, ADR-009, ADR-010 and ADR-015.
- `DEBUGLOG.md`, the S2, S3 and S4 findings and issues 5 and 13.
- `tasks/T12-workflow-content.md`, for `buildConversationFlow` and `loadInstructions`, which this script calls.
- Telnyx's API reference (fetch them). Assistants at https://developers.telnyx.com/api-reference/assistants/create-an-assistant.md, `update-an-assistant.md` and `list-assistants.md` in the same folder. MCP servers at https://developers.telnyx.com/api-reference/mcp-servers/create-mcp-server.md and the list and update pages next to it. Per-caller credentials at https://developers.telnyx.com/docs/inference/ai-assistants/per-caller-credentials.md.
- Shared tools are not in the API reference. Telnyx's own SDK lists `GET /ai/tools`, `POST /ai/tools` and `PATCH /ai/tools/{tool_id}` (https://github.com/team-telnyx/telnyx-node/blob/master/api.md), with a body of `display_name`, `type`, an object named after the type and an optional `timeout_ms`. Open decision 2 settles the shapes before this card runs.
- `AGENTS.md`, all of it.

## Files

- `scripts/provision.ts`, the entry point, and its modules in `scripts/provision/`, an API client that takes an injected `fetch`, the desired state, the comparison and the ids file.
- `scripts/test/*.test.ts`.
- `scripts/package.json` and `scripts/tsconfig.json`, a new workspace, plus `"scripts"` in the root `package.json` workspaces, the lock file that `npm install` updates, and `scripts/test/**/*.test.ts` in `vitest.config.ts`.

Thiago runs it from the repo root with `node scripts/provision.ts`, or with `--dry-run`, on Node 26's built-in type stripping and with no build step. So it uses only erasable TypeScript, its relative imports end in `.ts`, and its `tsconfig.json` sets `allowImportingTsExtensions` and `erasableSyntaxOnly`, as `assistant/` does. No new dependency, and zod validates every response the script reads.

## What it manages

In this order. Each step reads first, and creates or updates only when something differs. The script only ever touches the resources it names, so the spike assistants and the `mcp-spike` server stay as they are.

1. **The integration secret `mcp_enc_key`.** T10 wrote it from the one saved value, together with the edge secret `MCP_ENC_KEY`. The script checks that `GET /v2/integration_secrets` lists the identifier and stops when it does not (open decision 5). It never writes it, because a mismatch with the edge secret crashes a call at its first tool use (DEBUGLOG issue 13).
2. **Three shared tools.** `duinvezel-log-disclosure` is a webhook tool that POSTs `{ session_id }` to voice-context's `/tools/disclosure`. Its body parameter `session_id` is a required string, filled from the dynamic variable of the same name (S2, answer 4). `duinvezel-transfer` transfers to the number in `TRANSFER_TO` (open decision 8). `duinvezel-hangup` hangs up.
3. **The MCP server `duinvezel-voice-tools`.** Type `http` (S3), URL voice-tools' `/mcp`, `api_key_ref` exactly `{{mcp_token | mcp_enc_key}}` (ADR-008), and `allowed_tools` the five tools in T19's order.
4. **The assistant `Duinvezel Support`.**
   - `model` `moonshotai/Kimi-K2.6`, `instructions` from `assistant/instructions/base.md`, and `voice_settings.voice` from open decision 7.
   - `greeting` is the Disclosure line. In S2 a speak start node replaced the greeting, so it never plays twice, and it covers a call where the workflow does not start.
   - `dynamic_variables` holds the defaults of the variable contract in `docs/WORKFLOW.md`. `dynamic_variables_webhook_url` is voice-context's `/dv`, and `dynamic_variables_webhook_timeout_ms` is 4,000 (`docs/ARCHITECTURE.md`, Call setup latency budget).
   - `mcp_servers` is `[{ id, allowed_tools }]` for the server above. `conversation_flow` is `buildConversationFlow` with the three tool ids.
   - `telephony_settings.recording_settings.enabled` is `true`, because the disclosure tells the caller the call is recorded.
5. **The phone number.** The number in `DUINVEZEL_PHONE_NUMBER` is attached to the assistant's TeXML application, the `telephony_settings.default_texml_app_id` that the API returns for the assistant, with `PATCH /v2/phone_numbers/{id}` and `connection_id` (open decision 6). S2 found that a number hangs up until it is attached to the assistant's application, and for a few minutes after, so the script says so when it changes the number.

**Ids.** The function URLs come from `infra/ids.json`. Every id the script creates or finds goes back into it, under `assistant`, `mcpServer`, `tools` and `phoneNumber`. The file is written only when a value changed, and keys the script does not own stay as they are.

**Idempotency.** Each resource is found by its name through the list endpoint before anything is created. A create sends `Idempotency-Key: duinvezel-<kind>-<the first 16 hex characters of the SHA-256 of the body>`, so a create that timed out and is run again is replayed instead of doubled (ADR-015, DEBUGLOG issue 5). An update goes out only when a field the script manages differs from what the API returns, and it sends only that resource's managed fields.

**Output.** One line per resource, `created`, `updated` with the names of the fields that changed, or `unchanged`. Lines hold ids, names and field names, never the API key, a secret, a token, or a phone number beyond its last four digits.

**Inputs and errors.**

- The script reads `TELNYX_API_KEY`, `TRANSFER_TO` and `DUINVEZEL_PHONE_NUMBER` from the environment, which Thiago loads from `~/.config/telnyx/env`. When one is missing it stops before any request and names it.
- `--dry-run` sends only GET requests and prints what a real run would do.
- Every request has a 15-second timeout. A timeout stops the run and says that the outcome is unknown, so the next run reads before it writes.
- An answer that is not 2xx stops the run with the method, the path, the status and the API's error code and title, never the body that was sent. A 403, and any error that mentions 10039 or a spend limit, stops it at once.

## Tests

With a fake `fetch` that records every request and answers like the API.

- A first run against an empty account checks the secret, creates the three tools, the MCP server and the assistant in that order, attaches the number and writes the ids.
- A second run against what the first run created sends no create and no update, and prints `unchanged` for every resource.
- A changed instruction file sends one assistant update that carries only the managed fields, and the output names `instructions`.
- A create that timed out and is run again sends the same `Idempotency-Key`.
- A missing `mcp_enc_key` stops before any write, and a missing environment variable stops before any request.
- `--dry-run` sends only GET requests.
- The API key appears only in the `Authorization` header, and no output line contains it, `TRANSFER_TO`, or the phone number in full.
- An error answer stops the run with its method, path, status and code, and a 403 stops it at once.
- The payloads. The dynamic variable defaults equal the contract table in `docs/WORKFLOW.md`, read by the test. The webhook timeout is 4,000. `api_key_ref` is exactly `{{mcp_token | mcp_enc_key}}`. `allowed_tools` lists the five tools in order. `conversation_flow` equals `buildConversationFlow`'s output for the tool ids the run created.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Thiago runs the script with `--dry-run`, then for real, then a second time, and the second run prints `unchanged` for every resource.
- [ ] A browser test call and a phone call each hear the Disclosure line, and voice-context logs `dv` and the disclosure for the call's trace id.
- [ ] `infra/ids.json` holds every id.

## Open decisions

1. **Order.** T12 builds the flow without the network, and this script provisions it. So T12 runs first, then T11.
2. **The shared tools.** The endpoints exist only in Telnyx's SDK, and the shapes of the webhook, transfer and hangup objects are documented nowhere. Either Thiago runs one read-only `GET /v2/ai/tools`, which shows how the S2 tool `spike_log` (a webhook tool made in the portal) is stored, so the card can name the exact shapes, or he creates the three tools once in the portal and the script only finds them by name.
3. **Tool nodes and the assistant's tools.** If the shared tools must also be in the assistant's `tool_ids` for the tool nodes to run them, the model could call transfer and hangup from any prompt node, which `docs/WORKFLOW.md` rules out. The proposal is to leave `tool_ids` empty and let the first test call show whether the tool nodes run.
4. **Signed tool calls.** voice-context's `/tools/disclosure` accepts only a valid Telnyx signature, and Telnyx's docs do not say whether a webhook tool's request is signed. If it is not, every Route call gets a 403. The routing still works, because the edges read call setup variables, but no disclosure is recorded. The first test call shows it in voice-context's log. The fallback is an internal-key header through integration secret templating (`{{#integration_secret}}…{{/integration_secret}}`). That needs a second integration secret written from `DUINVEZEL_INTERNAL_KEY` and a voice-context change, so it is decided after the call.
5. **`mcp_enc_key`.** The outline had the script manage it. The proposal is that it only checks the identifier and never writes it, so keys are only ever written by T10's steps, from the one saved value.
6. **The phone number.** Which number, and whether the script moves it from `spike-routing`'s application to the new assistant's. The API reference does not say that `connection_id` takes a TeXML application id, but S2's finding points that way. The alternative is that Thiago attaches it in the portal.
7. **The voice.** A voice id in the form `Telnyx.<model>.<voice>`, picked by Thiago.
8. **The transfer.** The number in `TRANSFER_TO`, and the transfer's `from`, which the API requires. The proposal is the assistant's own number, so the person answering sees the support line.

## Out of scope

The workflow's content (T12), path tests (T13), the canary (T14), demo tooling (T15).
