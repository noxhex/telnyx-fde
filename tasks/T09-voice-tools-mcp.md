# T09. voice-tools MCP server

**Phase** 1 · **Depends on** T04, T06, T07, S3

## Goal

The MCP server the assistant calls during a conversation. Every tool acts on the caller's session and on nothing else.

## Read first

- `docs/ARCHITECTURE.md`, sections MCP tools, Identity levels, Security model and Failure modes.
- `docs/DECISIONS.md`, ADR-008, ADR-009 (with the S3 result), ADR-013, ADR-014 and ADR-015.
- `AGENTS.md`, all of it.

## Files

- `functions/voice-tools/telnyx.toml`, adding secrets `MCP_TOKEN_KEY` and `INTERNAL_KEY` and the environment variable `CRM_URL`. The KV and actor bindings exist from T06 and T07.
- `functions/voice-tools/src/index.ts` (routing only), `src/auth.ts`, `src/session.ts`, `src/flags.ts`, `src/areas.ts` (postcode to area name), `src/clients/crm.ts`.
- `src/mcp/protocol.ts` (JSON-RPC types and errors), `src/mcp/server.ts` (dispatch), `src/mcp/tool-nodes.ts` (which workflow node each tool belongs to).
- `src/mcp/tools/verify-account.ts`, `check-area-status.ts`, `run-line-diagnostics.ts`, `report-outage.ts`, `create-ticket.ts`.
- `src/routes/internal-sessions.ts`.
- `functions/voice-tools/test/mcp-protocol.test.ts`, `test/auth.test.ts`, `test/tools.test.ts`.

## Routes

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /mcp` | bearer token | MCP over Streamable HTTP, JSON responses only (ADR-009) |
| `GET /mcp` | none | 405 |
| `POST /internal/sessions` | `x-internal-key` | Creates a session and returns a token, for MCP Inspector, the canary and the demo scripts |
| `GET /healthz` | none | Liveness, touches no state |
| anything else | none | 404, touches no state |

`POST /internal/sessions` takes `{ identity, accountNumber?, postcode?, callerPhone? }`, writes a session with a fresh random sid and `traceId` `"internal-<sid>"`, and returns `{ token, sid }` with a two-hour expiry.

## Protocol

As proven in S3. `initialize` negotiates the version, notifications get 202 with no body, `ping` returns an empty result, and `tools/list` and `tools/call` are described below. An unknown method is error -32601, invalid parameters -32602, and a JSON array (a batch) -32600.

## Auth

Every `POST /mcp` needs `Authorization: Bearer <token>`. Verify the token with `MCP_TOKEN_KEY` (turned into bytes with `parseKey`), then load `session/<sid>`. A missing, invalid or expired token, or a session that no longer exists, returns HTTP 401 with a JSON-RPC error and a log line `auth_failed` (reason and user agent), before any other state access.

## Tools

List them in this order. Write each description for a voice model, saying when to use the tool. Input schemas come from zod, with `z.toJSONSchema` if the installed zod has it, otherwise written by hand next to the schema.

1. **`verify_account`**, any identity. Input `{ postcode, account_number? }`, where the postcode is four digits.
   - The account comes from `account_number` in full mode, or from the session's matched account in postcode mode.
   - Fetch it with `GET {CRM_URL}/accounts/<number>` (800 ms timeout). If it does not exist, count a failure in the session itself, lock the session after three, and return `{ verified: false, attempts_left }` without creating an actor.
   - Otherwise call `CUSTOMER_ACCOUNT.verify`. On `ok`, set the session's identity to `verified` with the account number, postcode and line id, then return `{ verified: true, first_name, area_name, area_outage, outage_eta }` using the KV area status. On `wrong`, return `{ verified: false, attempts_left }`. On `locked`, return `{ verified: false, locked: true, locked_minutes }`.
2. **`check_area_status`**, any identity. Input `{ postcode }`. Read the KV area status and return `{ area_name, state, eta }`. A postcode outside our five areas returns `{ area_name: null, state: "unknown" }`.
3. **`run_line_diagnostics`**, needs `attested` or `verified`. No input. Call `POST {CRM_URL}/lines/<lineId>/test` with a 5000 ms timeout and return the result. A lower identity returns `{ needs_verification: true }`.
4. **`report_outage`**, needs `number_match`, `attested` or `verified` and a postcode in the session. Input `{ symptom }`. Call `AREA_INCIDENT.report` on the session's postcode, with the threshold, window and ETA taken from flags (`incident_threshold` default 3, `report_window_secs` default 1800, `incident_eta_minutes` default 240), and return the result.
5. **`create_ticket`**. Input `{ category, summary }`, with the summary at most 300 characters. `repair_visit` and `other` need `attested` or `verified`, and `callback` is allowed for any identity. With an account, call `CUSTOMER_ACCOUNT.createTicket` with the dedupe key `<sid>/<category>`. Without one (a callback only), write `callback/<sid>` in KV with the caller's phone and the summary, for seven days, idempotent per sid. Return `{ ticket_id, window }`.

Expected business outcomes (wrong postcode, locked, `needs_verification`) are normal results. A failing dependency returns a tool result with `isError: true` and one short sentence the model can say aloud, for example "The diagnostics system is not responding right now." Results go out as `content: [{ type: "text", text: <JSON of the result> }]`.

## Logging

One line per request with `event` `"mcp"`, the JSON-RPC `method`, `tool`, `node` from `tool-nodes.ts`, `trace_id` from the session, `identity`, `outcome`, `status` and `latency_ms`.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Protocol tests cover version negotiation, a notification returning 202, `ping`, `tools/list` returning the five tools with input schemas, an unknown method, invalid parameters, a batch, `GET /mcp` and an unknown path.
- [ ] Auth tests cover no token, a bad signature, an expired token and a missing session, all returning 401 with no access beyond the session read.
- [ ] Tool tests with stub clients cover each tool's happy path and identity gate, `verify_account` in both modes with wrong details and a lockout, `report_outage` passing the flags through, `create_ticket` dedupe and the anonymous callback, and a session for one account never reaching another.
- [ ] MCP Inspector against `telnyx-edge dev` lists and calls the tools with a token from `POST /internal/sessions`.
- [ ] Nothing is shipped.

## Out of scope

`subscribe_updates` (T16), the canary (T14), demo scripts (T15).
