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
| Area status at call setup | KV read model, written by the actor, behind a 10-second memory cache in each container | During an outage every caller from the area needs it. Reading the actor would queue them all on one single-threaded instance. A KV read takes 0.8 to 1.2 s (DEBUGLOG issues 11 and 15), so a warm container answers from memory, and up to 10 seconds of extra staleness is fine for an announcement. |
| Verification attempts, lockout, call history, tickets | `CustomerAccount` actor | Two calls guessing the same account must not both get a third attempt. Attempts must survive a hang-up, and an alarm lifts the lockout. |
| Per-call session | `Session` actor, one per call, deleted by its alarm two hours after creation (ADR-019) | Call setup creates it and every MCP call reads it. An actor round trip took 7 to 17 ms warm in T10, and about 0.4 s on the first call to a new instance, where a KV write takes about 1.4 s and a read about 1 s (DEBUGLOG, T10 measurements). One call is one sequential writer, so the instance never queues. |
| CRM lookups | KV cache with a ten-minute TTL, behind a 60-second memory cache in each container | The memory cache answers repeat callers on a warm container. The KV cache recognises callers across containers, which the `crm_fail` part of the demo needs, and gives a measurable hit rate. |
| Feature flags | KV, behind a memory cache in each container that serves the last good value and refreshes it in the background after 10 seconds (T20) | Threshold, fault injection and path toggles change without a redeploy, even mid-demo, and apply within about 10 seconds plus one KV read. A KV read takes longer than the flags' 1,000 ms bound (DEBUGLOG issue 15), so only a container's first requests wait for it. |
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

**Budget.** The dependency calls share a soft budget of 3,000 ms. When it runs out, `/dv` answers with what it knows. That leaves about a second of the timeout for the signature check, the token, cold-start work and the network. The target is a p95 server time under 3 s, and a warm container should answer most calls in about 0.4 s. The measured column comes from T10 on 12 October (DEBUGLOG, T10 measurements). S1's numbers stay in DEBUGLOG.

| Step | Timeout | Expected | Measured in T10 |
|---|---|---|---|
| `TELNYX_PUBLIC_KEY` read, before the soft budget | 1,000 ms | 0 ms once kept, 0.55 to 0.75 s on a container's first call | 546 ms, for smoke's unsigned `/dv` |
| Signature check | none, CPU only | under 5 ms | not measured |
| The two token keys, in parallel with the next three steps | 1,000 ms each | 0 ms once kept, 0.55 to 0.75 s on a container's first call | 1,127 and 1,278 ms for two reads in a row, in voice-tools |
| Flags, the last good value in memory, else KV (T20) | 1,000 ms, then defaults | under 1 ms from memory. Only a container's first calls wait for KV | every flags read in mock-crm hit the bound (DEBUGLOG issue 15) |
| CRM lookup, 60 s memory cache, else the KV cache raced against mock-crm | 2,000 ms since T22, including this replica's `INTERNAL_KEY` read | under 1 ms from memory. Otherwise whichever answers first, mock-crm (7 to 20 ms warm, about 1.0 s cold after T20) or the KV cache (about 1.1 s). A replica's first use adds its own key read | 7 to 20 ms warm. Cold, 2,174 ms on mock-crm's server before T20. On 13 October 103 to 300 ms, and two first uses in a row failed (DEBUGLOG issue 17) |
| All five area statuses, 10 s memory cache, else KV | 2,000 ms since T22 | under 1 ms from memory, about 1.1 s from KV | one KV read, 1,149 ms. KV reads took 1,083 to 1,639 ms on 13 October |
| `CustomerAccount.recordCall` | 600 ms | 8 to 17 ms, and about 0.4 to 0.5 s for an account's first call | 8 to 17 ms warm, 483 ms for a new instance |
| `Session.create` | 1,000 ms | about 0.4 s, because every call creates a new instance | 378 to 382 ms, of which 22 to 24 ms inside the actor |
| CRM cache write in KV, after mock-crm answered | 2,500 ms, cut by the soft budget | about 1.5 s | KV put plus get 2.47 to 3.12 s, the split not measured |
| Token mint and encryption | none, CPU only | under 5 ms | not measured |

The two token keys, the flags, the CRM lookup and the five area statuses start together. There are only five postcodes, so the area reads need not wait for the CRM. Once the CRM lookup has answered, `recordCall`, `Session.create` and, after a mock-crm answer, the CRM cache write run in parallel. That gives about 0.4 s when a warm container has the flags, the areas and the caller in memory, since `Session.create` always meets a new instance. When the areas come from KV it is about 1.1 s. When mock-crm answers, the CRM cache write makes it about 1.5 s, or about 2.5 s from a cold mock-crm. A container's first call adds about 0.6 s for the public key read before the budget. Each dependency has its own timeout, and a timeout degrades the answer (unknown caller, no repeat flag, no outage notice) instead of failing the webhook.

**CRM timeouts.** voice-context's lookup (`crmLookupMs`) is 2,000 ms and voice-tools' account fetch (`crmAccountMs`) 2,500 ms since T22. The health check's CRM call stays at 1,500 ms. Warm calls from voice-context to mock-crm took 7 to 20 ms, so a timeout derived from them would come out at about 500 ms. That would turn every lookup on a cold path into an unknown caller. The timeout matters only on a cold path, so it is sized for that path, as Thiago decided on 12 October when he kept both at 1,500 ms. The first calls on 13 October showed the cold path is longer (DEBUGLOG issue 17). A CRM call can meet two first uses in a row, the caller's own `INTERNAL_KEY` read and mock-crm's read window, about 1.7 s together. voice-context's 2,000 ms still leaves 1,000 ms of the soft budget for `Session.create`. voice-tools' 2,500 ms keeps a cold `verify_account` at about 3 s. Telnyx does not document a timeout for MCP tool calls, and a shared webhook tool's default is 5,000 ms (DEBUGLOG, S2 findings). Before T20, mock-crm's first keyed request took 2,174 ms, because it read its two secrets one after the other and then waited out its flags read. T20 starts the three reads together on a container's first request and waits at most 1,000 ms for them. So a cold lookup should take about 1.0 s plus the network, which took 5 to 15 ms between the functions, and stay under the bound. After a ship the platform's probe (DEBUGLOG issue 4) is the first request of the container it reaches, so that container's reads have usually finished before the first lookup.

**What T10 changed.** Three measurements moved the budget (DEBUGLOG, T10 measurements).

- A secret read costs 0.55 to 0.75 s once per container. `/dv` reads the public key before its soft budget starts, so a container's first call setup takes about 0.6 s longer than the budget suggests.
- A KV read took about 1.1 s, above S1's 0.8 s, and every flags read hit its 1,000 ms bound, so T20 moves the flags to a background refresh. The area reads' 1,500 ms bound held.
- A warm actor call took 7 to 17 ms, and the first call to a new instance about 0.4 s. Every call setup creates a new `Session` instance, so it always pays that. `recordCall`'s 600 ms bound leaves little room for an account's first call.

**What the first calls changed.** Two findings of 13 October moved the budget again (DEBUGLOG issue 17).

- A replica reads each secret on first use, and requests spread over several replicas per function, so first uses keep coming long after a ship. Since T22 voice-context and voice-tools start every read on a replica's first request of any kind, as mock-crm has since T20, and a request joins a read already running. The first `/dv` on a fresh replica still pays its public key read, so a warm-up runs before the review (README, "Before a demo").
- KV reads took 1,083 to 1,639 ms, so the area bounds went from 1,500 to 2,000 ms.

## Security model

- **Telnyx webhooks.** `/dv` and `/tools/*` require a valid Ed25519 signature over `{timestamp}|{raw body}`, with a timestamp less than five minutes old.
- **MCP.** Every request needs the per-call bearer token, which is HMAC-signed and expires with the call. Tools act only on the session's account and area, so a caller cannot talk the model into reading someone else's account.
- **Caller ID can be spoofed.** A number match personalises the greeting and the outage notice, since area outages are public information anyway. Account actions need verification unless the call has full SHAKEN attestation.
- **Everything else.** `/internal/*` routes and `mock-crm` require an internal key header. Unknown paths return 404 without touching KV or an actor (DEBUGLOG issue 4). The one exception is the warm-up. Each function starts its secret reads and its flags read on a replica's first request of any kind, without waiting for them (ADR-014, T20 for mock-crm, T22 for voice-context and voice-tools). These reads change no state.
- **Logs** mask phone and account numbers and never contain tokens, keys or signatures.
- **Known gap, phone numbers in the platform's logs.** The platform's invocation log records each request's full path, so mock-crm's `GET /customers?phone=<digits>` leaves the caller's number there unmasked, out of our masking's reach (DEBUGLOG issue 16). That is accepted for the demo, where the only real number is Thiago's. The production answer is to send the number in a POST body, and the cleanup list in `tasks/later.md` has it.

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
- **One trace id per call.** `trace_id` is the call control id, so our logs join Telnyx's own conversation records. It reaches `voice-tools` through the session. Callers pass it to every state-changing actor method as `traceId`, and each such method logs one line with it. `AreaIncident` keeps the trace id of the change that set its outbox, so the `publish` and `publish_retry` lines its alarm writes carry the trace id of the call behind them. Actor methods write to their type's log, which `telnyx-edge actors logs <Type>` reads. The platform redacts some values in runtime logs, and an `internal-<sid>` trace id reads `internal-[redacted]` in every line (DEBUGLOG issue 16). The first real call shows whether a call control id survives.
- **A signal beyond logs.** Per-hop latency on every line, plus the canary's latency series in `canary/last`.
- **Detection within a minute.** The Canary actor runs a synthetic end-to-end check every 30 seconds through the same code paths a call uses, and pushes an alert to a phone after two consecutive failures.
- **A live view during the demo.** `telnyx-edge logs <function> --tail --json` piped through `jq`.

The README will answer the brief's question directly. It will say how you would know within a minute that the assistant was broken, and what you would look at first.
