# T09. voice-tools MCP server core

**Phase** 1 · **Depends on** T04, T08, T18, S3, S4

## Goal

The MCP server the assistant calls during a conversation, with its routing, protocol, authentication and sessions, plus the two tools that only read. Every tool acts on the caller's session and on nothing else. T19 adds the three tools that change state, so each diff stays small.

## Read first

- `docs/ARCHITECTURE.md`, sections MCP tools, Where state lives, Identity levels, Security model and Failure modes.
- `docs/DECISIONS.md`, ADR-008, ADR-009, ADR-013, ADR-014, ADR-015 and ADR-019.
- `DEBUGLOG.md`, S3 findings (what Telnyx's MCP client sends) and issue 11 (KV latency).
- `spikes/mcp-spike/src/mcp.ts`, the S3 server this card builds on.
- `AGENTS.md`, all of it.

## Files

- `functions/voice-tools/package.json`, adding `@modelcontextprotocol/sdk` at exactly `1.32.1`, the version S3 ran (ADR-009). It is allowed in this function only. Run `npm install` at the root, so the root `package-lock.json` changes with it.
- `functions/voice-tools/telnyx.toml`, adding the secrets `MCP_TOKEN_KEY` and `INTERNAL_KEY` and, under `[env_vars]`, `CRM_URL` (mock-crm's URL from `infra/ids.json`). The KV and actor bindings exist from T06, T07 and T18.
- `functions/voice-tools/src/index.ts` (routing only, next to the actor re-exports), `src/config.ts`, `src/deps.ts`, `src/auth.ts`, `src/area-status.ts`, `src/clients/crm.ts`, `src/clients/sessions.ts`.
- `src/mcp/server.ts` (builds the SDK server and transport for one request), `src/mcp/tool-nodes.ts` (which workflow node each tool belongs to), `src/mcp/tools/check-area-status.ts`, `src/mcp/tools/run-line-diagnostics.ts`.
- `src/routes/mcp.ts`, `src/routes/internal-sessions.ts`.
- `functions/voice-tools/test/routing.test.ts` (extended), `test/mcp-protocol.test.ts`, `test/auth.test.ts`, `test/tools-read.test.ts`, `test/internal-sessions.test.ts`.

Postcodes and area names come from `packages/shared/src/areas.ts`, the memory cache from `packages/shared/src/memory-cache.ts` and the session types from `packages/shared/src/session-types.ts`.

## Routes

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /mcp` | bearer token | MCP over Streamable HTTP, JSON responses only (ADR-009) |
| `GET /mcp` | none | 405 |
| `POST /internal/sessions` | `x-internal-key` | Creates a session and returns a token, for MCP Inspector, the canary and the demo scripts |
| `GET /healthz` | none | Liveness, touches no state |
| anything else | none | 404, touches no state |

`POST /internal/sessions` takes `{ identity, accountNumber?, postcode?, lineId?, callerPhone? }`, validated with zod, where `identity` is `anonymous`, `number_match` or `attested`. It creates a session through `SESSION.create` on a fresh random sid (32 lowercase hex characters, from the injected randomness) with `traceId` `"internal-<sid>"`, and returns `{ token, sid }`, the token minted under `MCP_TOKEN_KEY` with a two-hour expiry. A missing or wrong key answers 401 before any actor call, compared in constant time.

## Protocol

As proven in S3 and recorded in ADR-009. The server is built on the SDK's `WebStandardStreamableHTTPServerTransport` in stateless mode with JSON responses, and each POST builds a fresh server and transport pair. `initialize` answers with the version the client asked for when it is `2025-11-25`, `2025-06-18` or `2025-03-26`, and otherwise with `2025-06-18`. Notifications get 202 with no body, `ping` returns an empty result, and `tools/list` and `tools/call` serve the tools below. An unknown method is error -32601, and an unknown tool or a malformed request is a JSON-RPC error too. A tool argument that fails validation is not a protocol error. It is a tool result with `isError: true` and one short sentence that names the argument and what it accepts, so the model can fix its call, the rule of the 2025-11-25 spec (Tools, Error Handling, SEP-1303). That rule came with Thiago's decision of 11 October, after this card was done, and T19's follow-up applies it to all five tools. A JSON array (a batch) gets whatever the SDK answers, and a test pins it.

## Auth

Every `POST /mcp` needs `Authorization: Bearer <token>`, checked before the SDK sees the request. Verify the token with `MCP_TOKEN_KEY` (turned into bytes with `parseKey` once per container), then load the session with `SESSION.get` on the token's sid. A missing, invalid or expired token, or a session that is missing or expired, answers HTTP 401 with a JSON-RPC error and a log line `auth_failed` (reason and user agent), before any other state access. A session read or a secret read that fails or times out answers HTTP 503 with a JSON-RPC error, logged with the reason `session_unavailable` or `secret_error`. The per-request server is built with the loaded session, so every tool handler sees only that session.

S4 showed that Telnyx sends the bearer token on every MCP request of a conversation, `initialize` and `notifications/initialized` included (DEBUGLOG, S4 findings), so no request needs an exception from the token check.

## Timeouts and caches

KV calls from a function take about 0.8 s to read and 1.4 s to write, and an actor round trip about 0.15 s, or 0.3 s after a pause (DEBUGLOG issue 11). Every outbound call has its own timeout.

| Call | Timeout |
|---|---|
| `SESSION.get`, `SESSION.create` | 1,000 ms |
| A secret read (`MCP_TOKEN_KEY`, `INTERNAL_KEY`), memoised per container, a failed read not kept | 1,000 ms |
| An area status from `area/<postcode>/status`, through a 10-second memory cache | 1,500 ms |
| mock-crm `POST /lines/<lineId>/test` | 5,000 ms |

The memory cache lives per container, created once at module level and passed in through the dependencies, as in T08. Only answers are cached, never a timeout or an error. A missing key is an answer, and it means `ok`.

## Tools

List them in this order. Write each description for a voice model, saying when to use the tool. Input schemas come from zod, with `z.toJSONSchema`.

1. **`check_area_status`**, any identity. Input `{ postcode }`, four digits. Read the area status and return `{ area_name, state, eta }`. A postcode outside our five areas returns `{ area_name: null, state: "unknown" }` without a KV read.
2. **`run_line_diagnostics`**, needs `attested` or `verified` and a line id in the session. No input. Call `POST {CRM_URL}/lines/<lineId>/test` with the internal key and return the result. A lower identity, or a session without a line id, returns `{ needs_verification: true }`.

Expected business outcomes (`needs_verification`, an unknown postcode) are normal results. A failing dependency returns a tool result with `isError: true` and one short sentence the model can say aloud, for example "The diagnostics system is not responding right now." Results go out as `content: [{ type: "text", text: <JSON of the result> }]`.

## Logging

Every request writes one line, `/healthz`, 404s and auth failures included (AGENTS.md, Logging). An MCP request logs `event` `"mcp"`, the JSON-RPC `method`, `tool`, `node` from `tool-nodes.ts`, `trace_id` from the session, `identity`, `outcome`, `status` and `latency_ms`, the timing helper's object.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Protocol tests cover version negotiation (the three versions echoed, `2024-11-05` and an unknown version answered with `2025-06-18`), a notification returning 202 with no body, `ping`, `tools/list` returning the two tools in order with input schemas, an unknown method, invalid parameters, a batch, `GET /mcp` and an unknown path. Since 11 October an invalid argument is a tool result with `isError`, not -32602 (Protocol, above, and T19's follow-up).
- [ ] Auth tests cover no token, a bad signature, an expired token, a missing session and an expired session, all returning 401 with no state access beyond the session read, and a failed or held session read and an unreadable `MCP_TOKEN_KEY` returning 503.
- [ ] Tool tests cover `check_area_status` for an outage, a quiet area, a missing key, a postcode outside the five with no KV read and a failed read, and `run_line_diagnostics` for `attested` and `verified`, `number_match`, a session without a line id, a mock-crm failure and a held call timing out at 5,000 ms.
- [ ] `/internal/sessions` tests cover no key and a wrong key (401, no actor call), an invalid body (400), and a valid body creating the session with `traceId` `"internal-<sid>"` and returning a token that verifies.
- [ ] Cache tests show an area status read from KV at most once per 10 seconds per container, with the production lifetime written as a literal, and a failed read not cached.
- [ ] Held-promise tests cover each timeout in the table, with the late result arriving after the timeout fired (AGENTS.md, Tests).
- [ ] Under `telnyx-edge dev`, `GET /healthz` answers 200, `GET /mcp` 405, `POST /mcp` without a token 401, an unknown path 404, and all three actor bindings register. Dev has no `INTERNAL_KEY`, `MCP_TOKEN_KEY` or KV (DEBUGLOG issue 9), so MCP Inspector runs against the deployed function in T10.
- [ ] Nothing is shipped.

## Out of scope

`verify_account`, `report_outage` and `create_ticket` (T19), `subscribe_updates` (T16), the canary (T14), demo scripts (T15).
