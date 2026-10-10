# T08. voice-context function

**Phase** 1 · **Depends on** T03, T04, T05, T06, S1

## Goal

The call setup webhook. It must answer inside its budget with correct variables even when dependencies are slow or down, and it is the first link in every call's trace.

## Read first

- `docs/ARCHITECTURE.md`, sections A call step by step, Data contracts, Identity levels, Call setup latency budget, Security model and Failure modes.
- `docs/WORKFLOW.md`, section Variable contract.
- `docs/DECISIONS.md`, ADR-005, ADR-006, ADR-008, ADR-013, ADR-014 and ADR-015.
- Shared actors, at https://developers.telnyx.com/docs/edge-compute/stateful-actors/shared-actors.md (fetch it).

## Files

- `functions/voice-context/telnyx.toml`. KV binding `KV` (id from `infra/ids.json`), a shared actor binding `CUSTOMER_ACCOUNT` with type `CustomerAccount` and no class shipped here, secrets `TELNYX_PUBLIC_KEY`, `MCP_TOKEN_KEY`, `MCP_ENC_KEY` and `INTERNAL_KEY`, and the environment variable `CRM_URL` (mock-crm's URL from `infra/ids.json`).
- `functions/voice-context/src/index.ts` (routing only), `src/config.ts`, `src/deps.ts`, `src/routes/dv.ts`, `src/routes/disclosure.ts`, `src/routes/internal-health.ts`, `src/clients/crm.ts`, `src/clients/accounts.ts`.
- `functions/voice-context/test/dv.test.ts`, `test/disclosure.test.ts`, `test/routing.test.ts`, `test/helpers/signed-request.ts`.

## Routes

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /dv` | Telnyx signature | Dynamic variables webhook |
| `POST /tools/disclosure` | Telnyx signature | Webhook behind the Route call tool node |
| `GET /internal/health` | `x-internal-key` | Deep health check for the canary |
| `GET /healthz` | none | Liveness, touches no state |
| anything else | none | 404, touches no state |

## `/dv`, step by step

1. Read the raw body as text and verify the signature (T03) against `TELNYX_PUBLIC_KEY`. On failure, log `auth_failed` with the reason and the user agent, and return 403.
2. Parse with zod. Require `data.event_type` to be `"assistant.initialization"`, and read `telnyx_end_user_target`, `telnyx_agent_target`, `call_control_id`, `telnyx_conversation_channel` and the optional boolean `telnyx_end_user_target_verified` from `data.payload`. Invalid input returns 400. A channel other than `phone_call` is treated as an anonymous caller.
3. Read flags with a 10-second in-memory cache. If `dv_force_error` is true, log it and return 500. That is test path E.
4. Derive the session id with `sessionIdFromCallControlId`, and use the call control id itself as `trace_id`.
5. **CRM lookup**, 400 ms timeout. Try `crm/phone/<digits>` in KV first. On a miss, call `GET {CRM_URL}/customers?phone=<digits>` with the internal key, and cache the result (the customer or a not-found marker) for 600 s. A timeout or error means an unknown caller, with the reason `crm_timeout` or `crm_error`.
6. **Identity level.** No customer means `anonymous`. A customer with `telnyx_end_user_target_verified` true means `attested`. Any other customer means `number_match`.
7. **In parallel**, each with its own timeout. Read the area status from `area/<postcode>/status` (200 ms, and a missing key means `ok`). Call `CUSTOMER_ACCOUNT.recordCall` with the session id as `callId` and the trace id as `traceId` (400 ms, and a failure means `repeat_caller` `"false"` with the reason `actor_error`).
8. **Session.** Write `session/<sid>` with a 7200 s TTL, holding `sid`, `traceId`, `identity`, `accountNumber` and `postcode` if known, `callerPhone` (E.164, needed later for callbacks) and `createdAt`. Use a 200 ms timeout, and if the write fails, log it and carry on.
9. **Token.** Mint it with `exp` two hours ahead under `MCP_TOKEN_KEY`, then encrypt it with `MCP_ENC_KEY`. Both secrets are base64url strings, so turn them into bytes with `parseKey` once per container.
10. **Respond** 200 with `{ dynamic_variables, encrypted_dynamic_variables: { mcp_token } }`. Build `dynamic_variables` exactly as the contract in `docs/WORKFLOW.md` says. Every value is a string, and booleans are `"true"` or `"false"`.
11. **Log** one line with `event` `"dv"`, `trace_id`, `node` `"init"`, masked `caller` and `account`, `identity`, `area`, `area_outage`, `repeat_caller`, `cache` (`hit` or `miss`), `outcome` (`ok` or `degraded`), `reasons` (an array), `status` and `latency_ms` from the timing helper.

Steps 5 to 8 share a soft budget of 1200 ms. If it runs out, answer with what is known so far instead of waiting.

## `/tools/disclosure`

Signed like `/dv`, with the body `{ "session_id": "<sid>" }`. If the sid is valid and its session exists, add `disclosedAt` to the session and return 200 `{ "logged": true }`. Otherwise return 200 `{ "logged": false }`. Log `event` `"disclosure"` with `node` `"route_call"`. The tool node routes on variables, not on this response, so a failure here never blocks a call.

## `/internal/health`

Requires `x-internal-key`. Run, each with a timeout, a KV put and get on `canary/probe` (TTL 60 s), a real CRM lookup `GET {CRM_URL}/customers?phone=3258000001` (not `/healthz`, which stays up even when the `crm_fail` flag is on), and `CUSTOMER_ACCOUNT.snapshot` on the instance `CANARY-0`. Return 200 with each check's `ok` and `latency_ms`, or 503 if any check fails.

## Design for testing

`handleDv(req, deps)` and `handleDisclosure(req, deps)` take their dependencies (`now`, `kv`, `crm`, `accounts`, `secrets`, `log`, `random`) as an argument. `index.ts` builds the real ones from `env`. Tests use the KV fake, stub CRM and account clients, and a helper that signs requests with a key pair generated in the test.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Tests cover an unsigned request and a stale timestamp (403, with no KV access), a known attested caller, a number match, an unknown caller, a CRM timeout (anonymous and degraded), an actor failure (`repeat_caller` `"false"` and degraded), an outage area (`area_outage` `"true"` with `outage_eta`), `dv_force_error` (500), the response nesting values under `dynamic_variables` with every value a string, the token decrypting with `decryptForTests` and verifying, a cache hit skipping the CRM call on a second request, both disclosure outcomes, and an unknown path returning 404 with no KV access.
- [ ] A test shows `recordCall` receiving the call's trace id as `traceId`.
- [ ] Under `telnyx-edge dev`, `GET /healthz` answers 200, an unknown path 404, and an unsigned `POST /dv` 403. Dev has no `TELNYX_PUBLIC_KEY` and we cannot sign as Telnyx (DEBUGLOG issue 9), so the positive path is covered by the tests and by the first real call in T12.
- [ ] Nothing is shipped.

## Out of scope

MCP, the canary itself, assistant provisioning.
