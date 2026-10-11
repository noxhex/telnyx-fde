# Architecture

Duinvezel is a fictional fiber ISP on the Belgian coast. The name is a working title (Dutch for "dune fiber"), so rename it freely. This document describes what we are building and how the pieces fit together. The reasons behind each choice are in [DECISIONS.md](DECISIONS.md), and the conversation design is in [WORKFLOW.md](WORKFLOW.md).

## The problem

When a fiber cut takes out an area, dozens of customers call within minutes to report the same thing. Support queues fill up, agents repeat the same answer all day, and the operations team often learns about the outage from the queue length instead of from data.

Duinvezel's voice assistant answers every call and does four things.

1. It recognises the caller and tells anyone in a known outage area what is happening before they have to ask.
2. It counts new outage reports per area and declares an incident the moment enough separate customers report one. That happens exactly once, even when they all call at the same time.
3. It handles the rest of a fiber support line's work (line diagnostics, repair tickets, simple questions) and escalates to a person when needed.
4. It degrades safely. If the backend is down, callers still get an honest answer and a way to reach a person.

**Who it serves.** Residential customers who want to know what is going on and get their connection fixed, and the operations team, who get incidents declared from call patterns within seconds.

**Why this use case.** The concurrency is the business problem, not decoration. Many callers reporting the same area at once is exactly where a single-threaded per-entity actor beats a cache. The routing is driven by real data that is known before the caller says a word.

## System overview

```text
                     Caller (phone)
                           │
                           ▼
   Telnyx AI Assistant "Duinvezel Support"
   Disclosure (speak) ▶ Route call (tool node) ▶ prompt and speak nodes
         │                                     │
         │ (1) call setup,                     │ (2) MCP tool calls,
         │     signed webhook                  │     bearer = per-call token
         ▼                                     ▼
   ┌────────────────────┐              ┌──────────────────────────────┐
   │ voice-context      │              │ voice-tools                  │
   │  POST /dv          │              │  POST /mcp  (MCP server)     │
   │  POST /tools/*     │              │  owns the actor classes      │
   └──┬───────┬─────┬───┘              └───┬──────────────────────┬───┘
      │       │     │                      │                      │
      │       │     └───────────┐   ┌──────┘                      │
      │       │                 ▼   ▼                             ▼
      │       │        CustomerAccount actor              AreaIncident actor
      │       │        (one per account, shared)          (one per postcode)
      │       │        Session actor                              │ publishes status
      │       │        (one per call, shared)                     │
      │       ▼                                                   ▼
      │     KV: CRM cache, flags, area status read model
      ▼
   mock-crm (stand-in for the ISP back office)

   Canary actor, alarm every 30 s ▶ /internal/health on each function ▶ push alert after 2 failures
```

## Components

| Component | What it is | Responsibility |
|---|---|---|
| Assistant "Duinvezel Support" | Telnyx AI Assistant with a conversation workflow, provisioned from the repo through the Assistants API | Talks to the caller, routes between nodes, calls tools |
| `voice-context` | Edge Function (TypeScript) | Dynamic variables webhook on the call setup path, the webhook behind the Route call tool node, internal health route |
| `voice-tools` | Edge Function (TypeScript) | Stateless MCP server with the assistant's tools. Ships the actor classes, so it owns the shared actors |
| `mock-crm` | Edge Function (TypeScript) | Fake ISP back office (customers, accounts, line tests) with switchable latency and failures |
| `CustomerAccount` | Stateful Actor, one per account | Call history, verification attempts and lockout, repair tickets |
| `AreaIncident` | Stateful Actor, one per postcode | Outage reports, the incident decision, subscribers, publishing area status to KV |
| `Session` | Stateful Actor, one per call | The call's session (trace id, identity level, account, area, disclosure, verification failures without an account), deleted by an alarm when it expires |
| `Canary` | Stateful Actor, single instance | Synthetic end-to-end check every 30 seconds, and the alert |
| KV namespace `duinvezel` | Telnyx KV | CRM cache, feature flags, area status read model, callback requests, canary results |

## A call, step by step

1. Telnyx answers the call and POSTs `assistant.initialization` to `voice-context /dv`, signed with Ed25519.
2. `voice-context` checks the signature and looks the caller up by number (its memory cache, then the KV cache raced against `mock-crm`). It reads the area statuses (memory cache, then KV), records the call on the caller's `CustomerAccount` actor, creates the call's `Session` actor and mints a per-call token.
3. It answers with `dynamic_variables` (greeting, identity flags, area status, repeat-caller flag) and `encrypted_dynamic_variables.mcp_token`, inside the call setup budget.
4. The workflow plays the disclosure verbatim. The Route call tool node then logs it and routes on those variables before the caller has to say anything.
5. Prompt nodes call MCP tools on `voice-tools`. Telnyx decrypts the token and sends it as the bearer token, so the model never sees it. `voice-tools` validates the token, loads the session from its `Session` actor and acts only on that session's account and area.
6. `report_outage` goes to the `AreaIncident` actor for the caller's postcode. The actor dedupes by account, counts reports inside the window, declares the incident once the threshold is reached, and its alarm publishes the new status to KV straight away.
7. The next caller from that postcode reads the new status at call setup and hears the outage notice seconds into the call.

## Where state lives

| State | Home | Why |
|---|---|---|
| Outage reports and the incident decision per area | `AreaIncident` actor | Reporters arrive concurrently, and the count, the per-account dedupe and the incident transition must each happen exactly once. KV is last-write-wins with no compare-and-swap. |
| Area status at call setup | KV read model, written by the actor, behind a 10-second memory cache in each container | During an outage every caller from the area needs it. Reading the actor would queue them all on one single-threaded instance. A KV read takes about 0.8 s (DEBUGLOG issue 11), so a warm container answers from memory, and up to 10 seconds of extra staleness is fine for an announcement. |
| Verification attempts, lockout, call history, tickets | `CustomerAccount` actor | Two calls guessing the same account must not both get a third attempt. Attempts must survive a hang-up, and an alarm lifts the lockout. |
| Per-call session | `Session` actor, one per call, deleted by its alarm two hours after creation (ADR-019) | Call setup creates it and every MCP call reads it. An actor round trip takes about 140 ms warm and 280 ms after a pause, where a KV write takes about 1.4 s and a read about 0.8 s. One call is one sequential writer, so the instance never queues. |
| CRM lookups | KV cache with a ten-minute TTL, behind a 60-second memory cache in each container | The memory cache answers repeat callers on a warm container. The KV cache recognises callers across containers, which the `crm_fail` part of the demo needs, and gives a measurable hit rate. |
| Feature flags | KV, behind a 10-second memory cache in each container | Threshold, fault injection and path toggles change without a redeploy, even mid-demo, and apply within 10 seconds. |
| Caller identity for tools | Per-call token in `encrypted_dynamic_variables` | The model never sees it, tools cannot be talked into another account, and every MCP request carries the trace id. |

## Data contracts

### KV keys

KV keys allow only `a-z A-Z 0-9 - _ / = .`. Phone numbers therefore drop the `+`, and call control ids (which contain `:`) are hashed. Build every key with the helpers in `packages/shared/src/kv-keys.ts`.

| Key | Value | TTL | Written by |
|---|---|---|---|
| `crm/phone/<digits>` | Customer summary from mock-crm, or a "not found" marker | 600 s | voice-context |
| `area/<postcode>/status` | `{ state, incidentId, eta, version, updatedAt }` | none | AreaIncident actor |
| `callback/<sid>` | Callback request from a caller without an account | 7 days | voice-tools |
| `flags/global` | Feature flags as JSON | none | scripts or by hand |
| `canary/last` | Last canary run with per-check latency | none | Canary actor |
| `canary/probe` | Scratch value for the health check's KV round trip | 60 s | voice-context |

`<sid>` is the first 32 hex characters of a SHA-256 hash of the call control id. Sessions created through `POST /internal/sessions` get a random sid of the same form.

### Actors

| Type | Instance name | Methods (summary) |
|---|---|---|
| `CustomerAccount` | account number, for example `DV-100231` | `recordCall`, `verify`, `createTicket`, `snapshot`, `alarm` |
| `AreaIncident` | postcode, for example `8630` | `report`, `status`, `resolve`, `subscribe` (stretch), `alarm` |
| `Session` | sid | `create`, `get`, `markDisclosure`, `setVerified`, `recordVerifyFailure`, `alarm` |
| `Canary` | `canary` | `start`, `lastRun`, `alarm` |

The session document holds `sid`, `traceId`, `identity`, `accountNumber`, `postcode` and `lineId` when known, `callerPhone` (E.164, for callbacks), `createdAt`, `expiresAt` (two hours after creation), `disclosedAt`, and the verification failures and lock for account numbers that do not exist. Card T18 defines it in full.

Actor classes are thin adapters. They load state, call a pure domain function from `src/domain/`, save the result and set alarms. The domain functions hold all the rules and carry the unit tests.

### Identity levels

| Level | Meaning | Allowed |
|---|---|---|
| `anonymous` | Caller ID matched no account | `check_area_status`, `verify_account`, callback requests |
| `number_match` | Caller ID matched an account, without full SHAKEN attestation | Personal greeting, outage notice, `report_outage` |
| `attested` | Caller ID matched and `telnyx_end_user_target_verified` is true | Everything |
| `verified` | Passed `verify_account` during this call | Everything |

### Dynamic variables

The full contract with types and defaults is in [WORKFLOW.md](WORKFLOW.md#variable-contract). Every boolean is the string `"true"` or `"false"`, because variable edges compare strings.

## MCP tools

All tools act on the session behind the bearer token. None of them takes an account id from the model, apart from the account number a caller reads out during verification.

| Tool | Input | Result | Touches | Node |
|---|---|---|---|---|
| `verify_account` | `account_number` (optional for a number match), `postcode`, both cleaned of spoken forms first | verified or not, attempts left, lockout minutes, or a value to repeat | mock-crm, `CustomerAccount.verify`, `Session` | Verify account |
| `check_area_status` | `postcode` | area name, state, ETA | KV read model, through the memory cache | Verify account |
| `run_line_diagnostics` | none | line state, signal, last seen, suggestion | mock-crm line test (slow on purpose) | Diagnose |
| `report_outage` | `symptom` (`no_connection`, `slow`, `intermittent`, `other`) | reports in window, threshold, whether this report declared the incident, ETA | `AreaIncident.report` | Outage help, Diagnose |
| `create_ticket` | `category` (`repair_visit`, `callback`, `other`), `summary` | ticket id, visit window | `CustomerAccount.createTicket` with a dedupe key | Repair ticket, Take message |
| `subscribe_updates` (stretch) | none | subscribed | `AreaIncident.subscribe` | Outage help |

When the session's identity level is below what a tool needs, the tool returns `needs_verification` instead of failing. A misheard account number or postcode returns `account_number_unclear` or `postcode_unclear`, so the model asks the caller again and nothing counts against them. A failing dependency, and an argument that fails validation, return a tool result with `isError: true` and one short sentence, as the 2025-11-25 spec has it for input validation (SEP-1303). Only an unknown tool or a malformed request gets a JSON-RPC error.

## Call setup latency budget

**Webhook timeout.** The assistant sets `dynamic_variables_webhook_timeout_ms` to 4,000, approved by Thiago on 10 October. Telnyx's default is 1,500 ms and its maximum 10,000 ms. The rule from spike S1 takes the slowest cold call setup estimate times 1.5, rounded up to 500 ms, at most 4,000 ms. S1 measured KV calls from inside a function at about 0.8 s for a read and 1.4 s for a write (DEBUGLOG issue 11). On the first design, with its session in KV, the slowest call setup (a CRM cache miss after a pause) came to about 4.8 s, and 1.5 times that is far above the cap. So the cap applies, and the design below was reworked to fit under it, with the session in an actor and memory caches in front of the KV reads (ADR-019). T11 sets the value on the assistant.

**Budget.** The dependency calls share a soft budget of 3,000 ms. When it runs out, `/dv` answers with what it knows. That leaves about a second of the timeout for the signature check, the token, cold-start work and the network. The target is a p95 server time under 3 s, and a warm container should answer most calls in about 0.2 s.

| Step | Timeout | Expected | Measured in S1, warm min / median / max |
|---|---|---|---|
| Signature check | none, CPU only | under 5 ms | not measured |
| Flags, 10 s memory cache, else KV | 1,000 ms, then defaults | under 1 ms from memory, about 0.8 s from KV | KV read 668 / 806 / 941 ms |
| CRM lookup, 60 s memory cache, else the KV cache raced against mock-crm | 1,500 ms | under 1 ms from memory, about 0.8 s on a KV hit, about 1.2 s on a miss | KV read as above. The mock-crm call is an estimate until T10 measures it |
| All five area statuses, 10 s memory cache, else KV | 1,500 ms | under 1 ms from memory, about 0.8 s from KV | KV read as above |
| `CustomerAccount.recordCall` | 600 ms | about 0.15 s, 0.3 s after a pause | 134 / 141 / 160 ms, and 269 to 284 ms after a pause |
| `Session.create` | 1,000 ms | as `recordCall`, plus whatever a new instance costs | actor round trip as above. A new instance was not measured |
| CRM cache write in KV, after mock-crm answered | 2,500 ms, cut by the soft budget | about 1.4 s, 1.8 s after a pause | KV write 1,146 / 1,355 / 1,496 ms, and 1,757 ms after a pause |
| Token mint and encryption | none, CPU only | under 5 ms | not measured |

The flags, the CRM lookup and the five area statuses start together. There are only five postcodes, so the area reads need not wait for the CRM. Once the CRM lookup has answered, `recordCall`, `Session.create` and, after a mock-crm answer, the CRM cache write run in parallel. That gives about 0.2 s when a warm container has the flags, the areas and the caller in memory, about 1.0 to 1.2 s when they come from KV, and about 2.6 to 3.0 s on a CRM cache miss, where the KV write dominates. Each dependency has its own timeout, and a timeout degrades the answer (unknown caller, no repeat flag, no outage notice) instead of failing the webhook. T10 times the first request after each ship, which is a guaranteed cold start, and voice-context's call to mock-crm.

## Security model

- **Telnyx webhooks.** `/dv` and `/tools/*` require a valid Ed25519 signature over `{timestamp}|{raw body}`, with a timestamp less than five minutes old.
- **MCP.** Every request needs the per-call bearer token, which is HMAC-signed and expires with the call. Tools act only on the session's account and area, so a caller cannot talk the model into reading someone else's account.
- **Caller ID can be spoofed.** A number match personalises the greeting and the outage notice, since area outages are public information anyway. Account actions need verification unless the call has full SHAKEN attestation.
- **Everything else.** `/internal/*` routes and `mock-crm` require an internal key header. Unknown paths return 404 without touching KV or an actor (DEBUGLOG issue 4).
- **Logs** mask phone and account numbers and never contain tokens, keys or signatures.

## Failure modes

| Failure | What the caller gets | How we notice |
|---|---|---|
| Webhook times out or errors | Telnyx falls back to defaults, `session_ok` stays `"false"`, and the Degraded node offers a person | Canary alert, `dv` error log, Degraded node in the transcript |
| Token cannot be decrypted, for example when the integration secret and the edge secret differ | Telnyx makes no MCP request. Its docs say the call goes on without the tools, but in S4 the call crashed at the first tool use (DEBUGLOG issue 13). Both copies of the key are written together from one value, and every key change gets a real test call before the demo | `dv` succeeded but no MCP calls arrive for that trace id, and the call ends when the caller needs a tool |
| mock-crm slow or down | Caller treated as unknown and asked to verify | `crm_timeout` in the `dv` log, falling cache hit rate |
| KV publish from the actor fails | The incident is still recorded, and the actor's alarm retries the publish | `publish_retry` log line, canary area check |
| Actor call fails at call setup | No repeat-caller flag, and the call continues normally | `actor_error` field in the `dv` log |
| `Session.create` fails at call setup | The variables still carry the greeting and the outage notice, but the MCP tools answer 401 for that call. The prompts admit missing tools and offer a person | `session_error` or `session_timeout` in the `dv` log reasons |
| Transfer fails | The Take message node records a callback request | Transfer tool status in the transcript |

## Observability

Platform invocation logs run at least 30 seconds behind and record no client IP or user agent (DEBUGLOG issue 4). We use them for forensics, not detection. Detection comes from our own signals.

- **One structured JSON line per request** with `ts`, `level`, `svc`, `event`, `trace_id`, `node`, `tool`, masked `caller` and `account`, `outcome`, `status`, `cache`, and `latency_ms` split into `total`, `kv`, `actor` and `crm`.
- **One trace id per call.** `trace_id` is the call control id, so our logs join Telnyx's own conversation records. It reaches `voice-tools` through the session. Callers pass it to every state-changing actor method as `traceId`, and each such method logs one line with it. `AreaIncident` keeps the trace id of the change that set its outbox, so the `publish` and `publish_retry` lines its alarm writes carry the trace id of the call behind them.
- **A signal beyond logs.** Per-hop latency on every line, plus the canary's latency series in `canary/last`.
- **Detection within a minute.** The Canary actor runs a synthetic end-to-end check every 30 seconds through the same code paths a call uses, and pushes an alert to a phone after two consecutive failures.
- **A live view during the demo.** `telnyx-edge logs <function> --tail --json` piped through `jq`.

The README will answer the brief's question directly. It will say how you would know within a minute that the assistant was broken, and what you would look at first.
