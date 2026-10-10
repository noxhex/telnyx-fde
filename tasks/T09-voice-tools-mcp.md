# T09. voice-tools MCP server

**Phase** 1 · **Depends on** T04, T06, T07, T08, T18, S3

## Goal

The MCP server the assistant calls during a conversation. Every tool acts on the caller's session and on nothing else.

## Read first

- `docs/ARCHITECTURE.md`, sections MCP tools, Where state lives, Identity levels, Security model and Failure modes.
- `docs/DECISIONS.md`, ADR-008, ADR-009 (with the S3 result), ADR-013, ADR-014, ADR-015 and ADR-019.
- `DEBUGLOG.md`, issue 11 (KV latency).
- `AGENTS.md`, all of it.

## Files

- `functions/voice-tools/telnyx.toml`, adding secrets `MCP_TOKEN_KEY` and `INTERNAL_KEY` and the environment variable `CRM_URL`. The KV and actor bindings exist from T06, T07 and T18.
- `functions/voice-tools/src/index.ts` (routing only), `src/auth.ts`, `src/flags.ts`, `src/area-status.ts`, `src/clients/crm.ts`, `src/clients/sessions.ts`.
- `src/mcp/protocol.ts` (JSON-RPC types and errors), `src/mcp/server.ts` (dispatch), `src/mcp/tool-nodes.ts` (which workflow node each tool belongs to).
- `src/mcp/tools/verify-account.ts`, `check-area-status.ts`, `run-line-diagnostics.ts`, `report-outage.ts`, `create-ticket.ts`.
- `src/routes/internal-sessions.ts`.
- `functions/voice-tools/test/mcp-protocol.test.ts`, `test/auth.test.ts`, `test/tools.test.ts`.

Postcodes and area names come from `packages/shared/src/areas.ts`, and the memory caches from `packages/shared/src/memory-cache.ts` (both T08). The session types are in `packages/shared/src/session-types.ts` (T18).

## Routes

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /mcp` | bearer token | MCP over Streamable HTTP, JSON responses only (ADR-009) |
| `GET /mcp` | none | 405 |
| `POST /internal/sessions` | `x-internal-key` | Creates a session and returns a token, for MCP Inspector, the canary and the demo scripts |
| `GET /healthz` | none | Liveness, touches no state |
| anything else | none | 404, touches no state |

`POST /internal/sessions` takes `{ identity, accountNumber?, postcode?, lineId?, callerPhone? }`, where `identity` is `anonymous`, `number_match` or `attested`. It creates a session through `SESSION.create` on a fresh random sid (32 lowercase hex characters) with `traceId` `"internal-<sid>"`, and returns `{ token, sid }` with a two-hour expiry.

## Protocol

As proven in S3. `initialize` negotiates the version, notifications get 202 with no body, `ping` returns an empty result, and `tools/list` and `tools/call` are described below. An unknown method is error -32601, invalid parameters -32602, and a JSON array (a batch) -32600.

## Auth

Every `POST /mcp` needs `Authorization: Bearer <token>`. Verify the token with `MCP_TOKEN_KEY` (turned into bytes with `parseKey`), then load the session with `SESSION.get` on the token's sid. A missing, invalid or expired token, or a session that is missing or expired, returns HTTP 401 with a JSON-RPC error and a log line `auth_failed` (reason and user agent), before any other state access. A session read that fails or times out returns HTTP 503 with a JSON-RPC error, logged with the reason `session_unavailable`.

## Timeouts and caches

KV calls from a function take about 0.8 s to read and 1.4 s to write, and an actor round trip about 0.15 s, or 0.3 s after a pause (DEBUGLOG issue 11). Every outbound call has its own timeout.

| Call | Timeout |
|---|---|
| `SESSION.get`, `SESSION.setVerified`, `SESSION.recordVerifyFailure`, `SESSION.create` | 1,000 ms |
| `CUSTOMER_ACCOUNT.verify`, `CUSTOMER_ACCOUNT.createTicket` | 1,000 ms |
| `AREA_INCIDENT.report`, which may wait for its own KV publish | 3,000 ms |
| Flags from `flags/global`, through a 10-second memory cache, with the defaults on a timeout | 1,000 ms |
| An area status from `area/<postcode>/status`, through a 10-second memory cache | 1,500 ms |
| The callback write to `callback/<sid>` | 2,500 ms |
| mock-crm `GET /accounts/<number>` | 1,500 ms |
| mock-crm `POST /lines/<lineId>/test` | 5,000 ms |

The memory caches live per container, created once at module level and passed in, like T08's. Only answers are cached, never a timeout, an error or a default.

## Tools

List them in this order. Write each description for a voice model, saying when to use the tool. Input schemas come from zod, with `z.toJSONSchema` if the installed zod has it, otherwise written by hand next to the schema.

1. **`verify_account`**, any identity. Input `{ postcode, account_number? }`, where the postcode is four digits.
   - While the session's verify lock is active (`verify.lockedUntil` after now), return `{ verified: false, locked: true, locked_minutes }` without calling the CRM or an actor.
   - The account comes from `account_number` in full mode, or from the session's matched account in postcode mode.
   - Fetch it with `GET {CRM_URL}/accounts/<number>`. If it does not exist, call `SESSION.recordVerifyFailure`, which locks verification in this session for 15 minutes after three failures, and return `{ verified: false, attempts_left }`, or the locked result when that failure locked it. No `CustomerAccount` actor is created.
   - Otherwise call `CUSTOMER_ACCOUNT.verify`. On `ok`, call `SESSION.setVerified` with the account number, postcode and line id, then return `{ verified: true, first_name, area_name, area_outage, outage_eta }` using the area status. If `setVerified` answers `locked`, return the locked result instead. On `wrong`, return `{ verified: false, attempts_left }`. On `locked`, return `{ verified: false, locked: true, locked_minutes }`.
   - `locked_minutes` is the time left on the lock, rounded up to whole minutes.
2. **`check_area_status`**, any identity. Input `{ postcode }`. Read the area status and return `{ area_name, state, eta }`. A postcode outside our five areas returns `{ area_name: null, state: "unknown" }` without a KV read.
3. **`run_line_diagnostics`**, needs `attested` or `verified`. No input. Call `POST {CRM_URL}/lines/<lineId>/test` with the session's line id and return the result. A lower identity returns `{ needs_verification: true }`.
4. **`report_outage`**, needs `number_match`, `attested` or `verified` and a postcode in the session. Input `{ symptom }`. Call `AREA_INCIDENT.report` on the session's postcode, with the threshold, window and ETA taken from flags (`incident_threshold` default 3, `report_window_secs` default 1800, `incident_eta_minutes` default 240), and return the result.
5. **`create_ticket`**. Input `{ category, summary }`, with the summary at most 300 characters. `repair_visit` and `other` need `attested` or `verified`, and `callback` is allowed for any identity. With an account, call `CUSTOMER_ACCOUNT.createTicket` with the dedupe key `<sid>/<category>`. Without one (a callback only), write `callback/<sid>` in KV with the caller's phone and the summary, for seven days, idempotent per sid. Return `{ ticket_id, window }`.

Expected business outcomes (wrong postcode, locked, `needs_verification`) are normal results. A failing dependency returns a tool result with `isError: true` and one short sentence the model can say aloud, for example "The diagnostics system is not responding right now." Results go out as `content: [{ type: "text", text: <JSON of the result> }]`.

Every actor call (`CUSTOMER_ACCOUNT.verify` and `createTicket`, `AREA_INCIDENT.report`, and `SESSION.setVerified` and `recordVerifyFailure`) passes the session's `traceId` as `traceId`, so the actors' log lines join this call's trace.

## Logging

One line per request with `event` `"mcp"`, the JSON-RPC `method`, `tool`, `node` from `tool-nodes.ts`, `trace_id` from the session, `identity`, `outcome`, `status` and `latency_ms`.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Protocol tests cover version negotiation, a notification returning 202, `ping`, `tools/list` returning the five tools with input schemas, an unknown method, invalid parameters, a batch, `GET /mcp` and an unknown path.
- [ ] Auth tests cover no token, a bad signature, an expired token and a missing session, all returning 401 with no access beyond the session read, and a failed session read returning 503.
- [ ] Tool tests with stub clients cover each tool's happy path and identity gate, `verify_account` in both modes with wrong details, an account that does not exist counted on the session, the session lock refusing without a CRM or actor call, and an account lockout, `report_outage` passing the flags through, `create_ticket` dedupe and the anonymous callback, a session for one account never reaching another, and every actor call carrying the session's `traceId`.
- [ ] Cache tests show area statuses and flags read from KV at most once per 10 seconds per container, and a failed read not cached.
- [ ] Held-promise tests cover each timeout in the table, with the late result arriving after the timeout (AGENTS.md, Tests).
- [ ] Under `telnyx-edge dev`, `GET /healthz` answers 200, `GET /mcp` 405, `POST /mcp` without a token 401, an unknown path 404, and all three actor bindings register. Dev has no `INTERNAL_KEY`, `MCP_TOKEN_KEY` or KV (DEBUGLOG issue 9), so MCP Inspector runs against the deployed function in T10.
- [ ] Nothing is shipped.

## Out of scope

`subscribe_updates` (T16), the canary (T14), demo scripts (T15).
