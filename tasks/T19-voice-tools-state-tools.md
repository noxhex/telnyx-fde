# T19. voice-tools MCP tools that change state

**Phase** 1 · **Depends on** T06, T07, T09, T18

## Goal

The three MCP tools that change state, `verify_account`, `report_outage` and `create_ticket`, on top of the server core from T09. Every tool acts on the caller's session and on nothing else, so a caller cannot talk the model into another account.

## Read first

- `docs/ARCHITECTURE.md`, sections MCP tools, Identity levels and Security model.
- `docs/DECISIONS.md`, ADR-004, ADR-006, ADR-013, ADR-015 and ADR-019.
- `tasks/T09-voice-tools-mcp.md`, for the server, auth, logging and timeout conventions this card extends.
- `AGENTS.md`, all of it.

## Files

- `functions/voice-tools/src/flags.ts`, `src/clients/accounts.ts`, `src/clients/areas.ts`.
- `src/mcp/tools/verify-account.ts`, `src/mcp/tools/report-outage.ts`, `src/mcp/tools/create-ticket.ts`.
- `src/mcp/server.ts` and `src/mcp/tool-nodes.ts`, to register the three tools.
- `src/config.ts`, for their timeouts.
- `src/deps.ts` and `src/index.ts`, to add the new clients and the flags cache to the dependencies and build them from `env`. The flags cache lives per container, created once at module level, like the area cache.
- `src/clients/sessions.ts`, adding `setVerified` and `recordVerifyFailure`, and `src/clients/crm.ts`, adding `GET /accounts/<number>`.
- `src/actors/customer-account.ts`, only to export the helper that computes a ticket's window, for the callback without an account.
- `functions/voice-tools/test/tools-write.test.ts`, and `test/mcp-protocol.test.ts` for the full tool list. The other test files that build the dependencies (`test/tools-read.test.ts`, `test/auth.test.ts`, `test/internal-sessions.test.ts` and `test/routing.test.ts`) change only to give their fakes the new fields.

`voice-tools` owns the actor classes, so its clients call `CUSTOMER_ACCOUNT`, `AREA_INCIDENT` and `SESSION` through its own bindings and can use the classes' types directly.

## Timeouts and caches

| Call | Timeout |
|---|---|
| `SESSION.setVerified`, `SESSION.recordVerifyFailure` | 1,000 ms |
| `CUSTOMER_ACCOUNT.verify`, `CUSTOMER_ACCOUNT.createTicket` | 1,000 ms |
| `AREA_INCIDENT.report`, which can queue behind other reporters and the actor's alarm during an outage | 3,000 ms |
| Flags from `flags/global`, through a 10-second memory cache, with the defaults on a timeout | 1,000 ms |
| The callback write to `callback/<sid>` | 2,500 ms |
| mock-crm `GET /accounts/<number>`, an estimate until T10 measures the call between functions | 1,500 ms |

`AREA_INCIDENT.report` no longer waits for KV, because the actor's alarm publishes the status (ADR-005). The actor runs one call at a time, alarms included, so a report that arrives while the alarm writes to KV waits for that write, about 1.4 s. Only answers are cached, never a timeout, an error or a default.

## Tools

The full list, in this order, is `verify_account`, `check_area_status`, `run_line_diagnostics`, `report_outage`, `create_ticket`. Write each description for a voice model, saying when to use the tool. Input schemas come from zod, with `z.toJSONSchema`.

1. **`verify_account`**, any identity. Input `{ postcode, account_number? }`, where the postcode is four digits.
   - While the session's verify lock is active (`verify.lockedUntil` after now), return `{ verified: false, locked: true, locked_minutes }` without calling the CRM or an actor.
   - The account comes from `account_number` when the model passes one (full mode), and otherwise from the session's matched account (postcode mode). With neither, return `{ verified: false, account_number_needed: true }`, with no call and nothing counted.
   - Fetch it with `GET {CRM_URL}/accounts/<number>`. If it does not exist, call `SESSION.recordVerifyFailure`, which locks verification in this session for 15 minutes after three failures, and return `{ verified: false, attempts_left }`, or the locked result when that failure locked it. No `CustomerAccount` actor is created.
   - Otherwise call `CUSTOMER_ACCOUNT.verify`. On `ok`, call `SESSION.setVerified` with the account number, postcode and line id, then return `{ verified: true, first_name, area_name, area_outage, outage_eta }` using the area status from T09's `area-status.ts`. If `setVerified` answers `locked`, return the locked result instead. On `wrong`, return `{ verified: false, attempts_left }`. On `locked`, return `{ verified: false, locked: true, locked_minutes }`.
   - `locked_minutes` is the time left on the lock, rounded up to whole minutes.
2. **`report_outage`**, needs `number_match`, `attested` or `verified` and an account and a postcode in the session, and otherwise returns `{ needs_verification: true }`. Input `{ symptom }`, one of `no_connection`, `slow`, `intermittent` and `other`. Call `AREA_INCIDENT.report` on the session's postcode, with the session's account as `accountId` and the threshold, window and ETA taken from flags (`incident_threshold` default 3, `report_window_secs` default 1800, `incident_eta_minutes` default 240), and return the result.
3. **`create_ticket`**. Input `{ category, summary }`, with the summary at most 300 characters. `repair_visit` and `other` need `attested` or `verified`, and `callback` is allowed for any identity. With an account, call `CUSTOMER_ACCOUNT.createTicket` with the dedupe key `<sid>/<category>`. Without one (a callback only), write `callback/<sid>` in KV with the caller's phone, the summary, the ticket id and the window, for seven days, idempotent per sid. Its ticket id is `T-` and four digits derived from the sid, so a repeat for the same sid gives the same id and overwrites the same key without a read. Its window comes from the same helper as `CustomerAccount.createTicket`, the next working day from 08:00 to 12:00. Return `{ ticket_id, window }`.

Expected business outcomes (wrong postcode, locked, `needs_verification`) are normal results. A failing dependency returns a tool result with `isError: true` and one short sentence the model can say aloud. Results go out as `content: [{ type: "text", text: <JSON of the result> }]`.

Every actor call (`CUSTOMER_ACCOUNT.verify` and `createTicket`, `AREA_INCIDENT.report`, and `SESSION.setVerified` and `recordVerifyFailure`) passes the session's `traceId` as `traceId`, so the actors' log lines join this call's trace.

## Acceptance

- [ ] `npm run check` passes.
- [ ] `tools/list` returns the five tools in the order above, with input schemas.
- [ ] Tool tests with stub clients cover each tool's happy path and identity gate, `verify_account` in both modes with wrong details, an account that does not exist counted on the session, the session lock refusing without a CRM or actor call, an account lockout with `locked_minutes` rounded up, `report_outage` passing the flags through and their defaults, `create_ticket` dedupe and the anonymous callback, a session for one account never reaching another, and every actor call carrying the session's `traceId`.
- [ ] Cache tests show flags read from KV at most once per 10 seconds per container, with the production lifetime written as a literal, and a timeout or default not cached.
- [ ] Held-promise tests cover each timeout in the table, with the late result arriving after the timeout fired (AGENTS.md, Tests).
- [ ] Nothing is shipped.

## Out of scope

`subscribe_updates` (T16), the canary (T14), demo scripts (T15).
