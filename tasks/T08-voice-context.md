# T08. voice-context function

**Phase** 1 · **Depends on** T03, T04, T05, T06, T18, S1

## Goal

The call setup webhook. It must answer inside its budget with correct variables even when dependencies are slow or down, and it is the first link in every call's trace.

## Read first

- `docs/ARCHITECTURE.md`, sections A call step by step, Where state lives, Data contracts, Identity levels, Call setup latency budget, Security model and Failure modes.
- `docs/WORKFLOW.md`, section Variable contract.
- `docs/DECISIONS.md`, ADR-005, ADR-006, ADR-008, ADR-013, ADR-014, ADR-015 and ADR-019.
- `DEBUGLOG.md`, issue 11 (KV latency).
- Shared actors, at https://developers.telnyx.com/docs/edge-compute/stateful-actors/shared-actors.md (fetch it).

## Files

- `functions/voice-context/telnyx.toml`. KV binding `KV` (id from `infra/ids.json`), shared actor bindings `CUSTOMER_ACCOUNT` with type `CustomerAccount` and `SESSION` with type `Session`, with no class shipped here, secrets `TELNYX_PUBLIC_KEY`, `MCP_TOKEN_KEY`, `MCP_ENC_KEY` and `INTERNAL_KEY`, and the environment variable `CRM_URL` (mock-crm's URL from `infra/ids.json`).
- `functions/voice-context/src/index.ts` (routing only), `src/config.ts`, `src/deps.ts`, `src/routes/dv.ts`, `src/routes/disclosure.ts`, `src/routes/internal-health.ts`, `src/clients/crm.ts`, `src/clients/accounts.ts`, `src/clients/sessions.ts`.
- `packages/shared/src/areas.ts`, the five postcodes with their area names (8620 Nieuwpoort, 8630 Veurne, 8660 De Panne, 8670 Koksijde, 8600 Diksmuide), and `packages/shared/src/memory-cache.ts`, a small cache whose entries expire after a fixed time on an injected clock. Both are exported from `packages/shared/src/index.ts`, have tests in `packages/shared/test/`, and T09 uses them too.
- `functions/voice-context/test/dv.test.ts`, `test/disclosure.test.ts`, `test/internal-health.test.ts`, `test/routing.test.ts`, `test/helpers/signed-request.ts`.

## Routes

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /dv` | Telnyx signature | Dynamic variables webhook |
| `POST /tools/disclosure` | Telnyx signature | Webhook behind the Route call tool node |
| `GET /internal/health` | `x-internal-key` | Deep health check for the canary |
| `GET /healthz` | none | Liveness, touches no state |
| anything else | none | 404, touches no state |

## Secrets and memory caches

Secrets are read on first use and kept for the container's lifetime, and a failed read is not kept. A `TELNYX_PUBLIC_KEY` that cannot be read fails the signature check (403, reason `no_key`), so the routes fail closed. An `MCP_TOKEN_KEY` or `MCP_ENC_KEY` that cannot be read makes `/dv` log `secret_error` and return 500.

Each container keeps three memory caches, created once at module level in `index.ts` and passed in through the dependencies. Flags and area statuses stay for 10 seconds, and CRM lookup results for 60 seconds, keyed by the caller's digits. Only answers are cached. A timeout, an error or a default is never cached, so the next request tries again.

## `/dv`, step by step

1. Read the raw body as text and verify the signature (T03) against `TELNYX_PUBLIC_KEY`. On failure, log `auth_failed` with the reason and the user agent, and return 403 with no KV or actor access.
2. Parse with zod. Require `data.event_type` to be `"assistant.initialization"`, and read `telnyx_end_user_target`, `telnyx_agent_target`, `call_control_id`, `telnyx_conversation_channel` and the optional boolean `telnyx_end_user_target_verified` from `data.payload`. Invalid input returns 400. A channel other than `phone_call` is treated as an anonymous caller.
3. Derive the session id with `sessionIdFromCallControlId`, and use the call control id itself as `trace_id`.
4. **Start together**, each with its own timeout.
   - **Flags**, from memory, else `flags/global` from KV (1,000 ms). On a timeout or error, use the defaults.
   - **CRM lookup** (1,500 ms), from memory when the cache has the caller. Otherwise read `crm/phone/<digits>` from KV and call `GET {CRM_URL}/customers?phone=<digits>` with the internal key at the same time. The first usable answer wins. That is a KV hit (a customer or a not-found marker) or a mock-crm answer (200 with the customer, or 404). A KV miss or a failed call is not an answer, so the other side is still awaited. With no answer in time the caller is unknown, with the reason `crm_timeout`, or `crm_error` when both sides failed.
   - **Area statuses** for all five postcodes in `areas.ts`, each from memory, else from `area/<postcode>/status` in KV (1,500 ms, all in parallel). A missing key means `ok`. A failed or timed-out read leaves that area unknown. A customer whose postcode is not among the five gets `area_outage` `"false"`.
5. **Flags first.** Wait for the flags before anything changes state. If `dv_force_error` is true, log it and return 500. That is test path E.
6. **Identity level.** No customer means `anonymous`. A customer with `telnyx_end_user_target_verified` true means `attested`. Any other customer means `number_match`.
7. **Once the CRM lookup has answered, in parallel**, each with its own timeout.
   - `CUSTOMER_ACCOUNT.recordCall` for a known customer, with the session id as `callId` and the trace id as `traceId` (600 ms). A failure means `repeat_caller` `"false"`, with the reason `actor_error` or `actor_timeout`.
   - `SESSION.create` on the instance named by the sid (1,000 ms), with the `traceId`, the `identity`, the `accountNumber`, `postcode` and `lineId` when known, the `callerPhone` (E.164) and `nowMs`. The types are in `packages/shared/src/session-types.ts` (T18). The session lasts two hours. If the call fails or times out, log the reason (`session_error` or `session_timeout`) and carry on, because the variables still serve the call (ARCHITECTURE, Failure modes).
   - When the answer came from mock-crm, write it to `crm/phone/<digits>` in KV with a 600 s TTL (2,500 ms), so other containers find the caller too. A failed write changes nothing for the caller, and the log line records it as `cache_write` `"failed"`.
8. **Soft budget.** Steps 4 to 7 share a soft budget of 3,000 ms from the start of step 4, and each timeout is cut to what remains of it. When it runs out, answer with what is known so far. A pending CRM lookup counts as `crm_timeout`, a pending area read as unknown, a pending `recordCall` as `actor_timeout` and a pending `SESSION.create` as `session_timeout`. A pending cache write is no longer awaited, with a handler attached so a late failure cannot surface as an unhandled rejection.
9. **Token.** Mint it with `exp` two hours ahead under `MCP_TOKEN_KEY`, then encrypt it with `MCP_ENC_KEY`. Both secrets are base64url strings, so turn them into bytes with `parseKey` once per container.
10. **Respond** 200 with `{ dynamic_variables, encrypted_dynamic_variables: { mcp_token } }`. Build `dynamic_variables` exactly as the contract in `docs/WORKFLOW.md` says. Every value is a string, and booleans are `"true"` or `"false"`.
11. **Log** one line with `event` `"dv"`, `trace_id`, `node` `"init"`, masked `caller` and `account`, `identity`, `area`, `area_outage`, `repeat_caller`, `cache` (`"memory"`, `"kv"` or `"miss"`), `cache_write` when a write ran, `outcome` (`ok` or `degraded`), `reasons` (an array), `status` and `latency_ms` from the timing helper.

`docs/ARCHITECTURE.md` (Call setup latency budget) has the expected times. They are about 0.2 s on a warm container that has everything in memory, about 1.0 to 1.2 s when the reads come from KV, and up to the 3,000 ms soft budget on a CRM cache miss.

## `/tools/disclosure`

Signed like `/dv`, with the body `{ "session_id": "<sid>" }`. For a sid of 32 lowercase hex characters, call `SESSION.markDisclosure` on that instance (1,000 ms), and return 200 `{ "logged": true }` when the outcome is `logged` or `unchanged`. Otherwise, and for any other sid without calling the actor, return 200 `{ "logged": false }`. Log `event` `"disclosure"` with `node` `"route_call"`, the outcome and the `trace_id` from the result. The tool node routes on variables, not on this response, so a failure here never blocks a call.

## `/internal/health`

Requires `x-internal-key`. Run these checks in parallel, each with a timeout.

- KV, a put on `canary/probe` with a 60 s TTL (2,500 ms), then a get of it (1,500 ms).
- A real CRM lookup, `GET {CRM_URL}/customers?phone=3258000001` (1,500 ms). Not `/healthz`, which stays up even when the `crm_fail` flag is on.
- `CUSTOMER_ACCOUNT.snapshot` on the instance `CANARY-0`, and `SESSION.get` on the sid of 32 zeros, which finds no session and writes nothing (1,000 ms each).

Return 200 with each check's `ok` and `latency_ms`, or 503 if any check fails. T10 records these latencies for voice-context's calls to KV, mock-crm and the actors.

## Design for testing

`handleDv(req, deps)`, `handleDisclosure(req, deps)` and the health handler take their dependencies (`now`, `kv`, `crm`, `accounts`, `sessions`, `caches`, `secrets`, `log`, `random`) as an argument. `index.ts` builds the real ones from `env`. Tests use the KV fake, stub CRM, account and session clients, fresh caches on the fake clock, held promises for every timeout, and a helper that signs requests with a key pair generated in the test.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Tests cover an unsigned request and a stale timestamp (403, with no KV or actor access), a known attested caller, a number match, an unknown caller, a CRM timeout (anonymous and degraded), an actor failure (`repeat_caller` `"false"` and degraded), an outage area (`area_outage` `"true"` with `outage_eta`), `dv_force_error` (500, with no actor call), the response nesting values under `dynamic_variables` with every value a string, the token decrypting with `decryptForTests` and verifying, both disclosure outcomes and an invalid sid, the health check's 200 and 503, and an unknown path returning 404 with no KV or actor access.
- [ ] Cache tests show a second request within 10 s reading neither the flags nor the area statuses from KV, and a request after 10 s reading them again. A caller looked up within 60 s is answered from memory without KV or mock-crm (`cache` `"memory"`). A KV hit answers while mock-crm is still pending (`cache` `"kv"`, no cache write). A KV miss waits for mock-crm and then writes the KV cache. A mock-crm failure while the KV read is still pending ends with the KV hit. A timeout or failure is never cached.
- [ ] Held-promise tests cover each timeout, the soft budget answering at 3,000 ms with what is known, and each late result arriving after its timeout without changing the answer (AGENTS.md, Tests).
- [ ] Tests show `recordCall` receiving the call's trace id as `traceId`, `SESSION.create` called on the sid with the identity, account, postcode, line id, caller phone and trace id, and a failed `SESSION.create` still answering 200, degraded, with the reason `session_error`.
- [ ] Under `telnyx-edge dev`, `GET /healthz` answers 200, an unknown path 404, and an unsigned `POST /dv` 403. Dev has no `TELNYX_PUBLIC_KEY` and we cannot sign as Telnyx (DEBUGLOG issue 9), so the positive path is covered by the tests and by the first real call in T12. Dev turned out to refuse this function altogether (DEBUGLOG issue 12), so `test/routing.test.ts` covers these three through the real fetch handler, and T10's smoke test checks them on the deployed function.
- [ ] Nothing is shipped.

## Out of scope

MCP, the Session actor itself (T18), the canary, assistant provisioning.
