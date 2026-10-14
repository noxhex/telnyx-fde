# Architecture decisions

Each record says what we decided, why, and what it costs. Records marked **Pending** wait on a spike, and get updated with the result. Evidence links point to [DEBUGLOG.md](../DEBUGLOG.md), so every claim has a trail.

## ADR-001. Use case is a fiber outage and support line

**Status.** Accepted

**Context.** The brief rewards a use case that genuinely needs multi-step conversation and per-entity state. Booking lines are the common pick and make for a flat demo.

**Decision.** Build the support line of a fictional fiber ISP on the Belgian coast. Callers in a known outage area hear the status immediately, new outage reports are counted per area, and an incident is declared once enough separate customers report it.

**Consequences.** Concurrency is the real business problem, which gives honest answers to "why an actor" and "why not KV". The demo has a visible moment where reports cross the threshold and the next caller hears the outage notice. Telnyx is a carrier, so the outage-surge pain is familiar to the panel.

## ADR-002. TypeScript everywhere

**Status.** Accepted

**Context.** Stateful Actors and the KV `env` binding are TypeScript-only. Other languages reach KV only over REST and cannot host actors.

**Decision.** All functions, shared code, scripts and the provisioning tooling are TypeScript, with `strict` on.

**Consequences.** One toolchain (npm workspaces, `tsc`, `vitest`). No polyglot story, which the brief does not ask for.

## ADR-003. Three functions, split by blast radius

**Status.** Accepted

**Context.** The dynamic variables webhook sits on the call setup path with a 1.5 s default budget. The tools have different traffic, latency and failure modes. Each ship takes about eleven minutes (DEBUGLOG issue 3).

**Decision.** `voice-context` handles call setup and the Route call tool node. `voice-tools` is the MCP server and owns the actor classes. `mock-crm` stands in for the ISP back office.

**Consequences.** A tools release cannot break call setup. Shared actors let both functions reach `CustomerAccount`, which also covers the "shared actors" stretch goal. Three ships per full release, so we ship only at checkpoints (ADR-016).

## ADR-004. AreaIncident actor owns outage reports and the incident decision

**Status.** Accepted

**Context.** During an outage many callers report the same postcode within seconds. Counting them, ignoring repeat reports from the same account and declaring the incident must each happen exactly once. KV has no transactions or compare-and-swap, and concurrent writers to one key are last-write-wins.

**Decision.** One `AreaIncident` actor per postcode holds the reports inside a sliding window, the per-account dedupe, the threshold check and the transition from `ok` to `outage`. The threshold and window come from feature flags.

**Consequences.** No locks, and no lost or doubled reports. All reports for one area serialise on one instance, which is acceptable because a report is a few milliseconds of work. Reads do not go through the actor (ADR-005).

## ADR-005. Area status is a KV read model published by the actor

**Status.** Accepted. On 10 October the KV write moved from the actor method into its alarm (DEBUGLOG issue 11).

**Context.** Every call setup needs the caller's area status. Routing those reads through the actor would queue every caller from the outage area on one single-threaded instance at the worst possible moment, and the smoke test measured an actor round trip at about 150 ms warm and about 290 ms after a pause.

**Decision.** The actor publishes `area/<postcode>/status` to KV whenever the status changes. Call setup reads KV only. Publishing uses an outbox. The pending status is saved in actor storage in the same turn as the decision, and that turn sets the alarm to fire straight away. The alarm writes the status to KV with a 5,000 ms timeout, since alarms have a 15-minute budget, and retries until the write succeeds. No actor method waits for KV (ADR-019).

**Consequences.** Reads fan out from KV. The announcement can be a few seconds stale (the alarm and the KV write), plus up to 10 seconds in a warm container's memory cache (ADR-019), which is fine for "there is an outage in your area". The outbox closes the dual-write gap between actor storage and KV. The report that declares an incident returns without waiting for a KV write, which S1 measured at 1.1 to 1.8 s. A KV write that timed out has an unknown outcome (ADR-015) and may still land after a newer one, so after any timed-out publish the alarm writes the then-current status again once at least 30 seconds have passed, far longer than S1's slowest KV write. Only that confirming write clears the marker. A write that landed even later would leave KV stale, and only a compare-and-swap could rule that out, which KV does not have.

## ADR-006. CustomerAccount actor for limits, history and tickets

**Status.** Accepted

**Context.** Verification attempts must survive a hang-up, and two parallel calls guessing the same account must not both get a third attempt. Repeat-caller detection needs a per-account call count. Tickets must not be created twice.

**Decision.** One `CustomerAccount` actor per account. `verify` checks and updates the attempt counter in one turn and locks the account for 15 minutes after three failures. An alarm lifts the lock. `recordCall` counts calls in the last 24 hours and is idempotent per call id. `createTicket` is idempotent per dedupe key. `voice-tools` ships the class and `voice-context` reaches it through a shared actor binding.

**Consequences.** Read-modify-write without a lock, on exactly the operations that need it. Actors are created only for accounts that exist in the CRM, so random account numbers cannot spawn instances.

## ADR-007. Sessions, caches and flags live in KV

**Status.** Accepted. On 10 October ADR-019 moved sessions to an actor and put memory caches in front of the KV reads.

**Context.** A call is one sequential conversation, so its session has a single writer. CRM lookups are re-queryable data. Flags must change without a redeploy.

**Decision.** Sessions in KV with a two-hour TTL, CRM lookups cached for ten minutes, and flags in `flags/global`.

**Consequences.** KV is used for exactly the workloads the brief lists. No counters or coordination ever go in KV.

## ADR-008. Per-call capability token through encrypted dynamic variables

**Status.** Accepted, 10 October, after spike S4.

**Evidence.** DEBUGLOG S4 findings and issue 13.

**Context.** The MCP server must know which call, account and area a request belongs to. Passing an account id as a tool argument would let a prompt-injected caller ask for someone else's account.

**Decision.** At call setup `voice-context` mints an HMAC-signed token naming the session, encrypts it with AES-256-GCM under a key shared with Telnyx as an integration secret, and returns it in `encrypted_dynamic_variables.mcp_token`. The MCP server is configured with `api_key_ref: "{{mcp_token | mcp_enc_key}}"`, so Telnyx sends the decrypted token as the bearer token.

**Consequences.** The model never sees the token, and Telnyx sends it as the bearer token on every MCP request of the conversation, `initialize` and `notifications/initialized` included, so every request carries the trace id. When decryption fails no unauthenticated request is made, as Telnyx's per-caller credentials page says. That page also says the conversation goes on without the server's tools, but in S4 a browser call crashed at the first tool use instead (DEBUGLOG issue 13). So the integration secret and the edge secret are always written together from one value, as T10's steps do, and every key change gets a real test call before the demo.

## ADR-009. Stateless MCP over Streamable HTTP

**Status.** Accepted, 10 October, after spike S3. The SDK stays.

**Evidence.** DEBUGLOG S3 findings, local and deployed.

**Context.** Containers recycle and scale to zero, any request can land on any container, and requests are capped at 30 seconds. Long-lived SSE streams and in-memory MCP sessions do not fit.

**Decision.** Every MCP request is a self-contained POST answered with a JSON response. Session state lives in the `Session` actor (ADR-019). The server is built on the official SDK (`@modelcontextprotocol/sdk` 1.32.1): its `WebStandardStreamableHTTPServerTransport` speaks fetch `Request`/`Response` directly, so it runs inside the edge fetch handler unmodified, in stateless mode (no session id generator, so no `Mcp-Session-Id`) with `enableJsonResponse`. Each POST builds a fresh server and transport pair, because the SDK refuses to reuse a stateless transport across requests. The one override is protocol negotiation: the SDK also echoes the 2024-* versions and falls back to its latest, so a small `setRequestHandler` replacement pins the supported set to `2025-11-25` / `2025-06-18` / `2025-03-26` with `2025-06-18` as the fallback. Strict routing stays ours: only `POST /mcp` reaches the SDK, `GET /mcp` gets a 405 and every other path a 404 before any dispatch.

**Consequences.** No sticky sessions, nothing to lose on a restart, and MCP Inspector can test every request in isolation. The JSON-RPC framing, batching, parse errors and header validation come from the SDK instead of hand-rolled code. The SDK stays because Telnyx's client passed both checks that were still open. It never sent `GET /mcp`, so our 405 never comes into play, and no request got the 406 the SDK gives a POST whose `Accept` header lacks `text/event-stream`. It initialised once at the start of the conversation, then sent `tools/list` and later `tools/call` with protocol version `2025-11-25`, each a POST that took 9 to 51 ms on our side. The SDK's own client in MCP Inspector opens a `GET /mcp` stream after `initialize` and tolerates the 405. T09 adds the SDK to voice-tools at exactly 1.32.1, the version the spike ran, and the hand-rolled subset is no longer needed as a fallback.

## ADR-010. Route on a tool node right after the disclosure

**Status.** Accepted, 10 October, after spike S2.

**Evidence.** DEBUGLOG S2 findings, and the answers at the end of `docs/WORKFLOW.md`.

**Context.** A speak node must have exactly one default edge, so routing has to happen in the next node. On calls, variable edges on a prompt node are evaluated before each model turn. If that turn waits for the caller to speak, routing would stall until they say something, and coming back to that node later would fire the same edges again. S2 checks how this behaves in practice.

**Decision.** The disclosure speak node leads to a Route call tool node. Its shared webhook tool records that the disclosure played, and its variable edges route on the call setup variables, followed by one default edge.

**Consequences.** Routing happens immediately after the disclosure, runs exactly once per call, and leaves an audit record that the disclosure was delivered. In S2 the tool node routed on custom string variables straight after the speak node, with no caller turn. Its edges compare against the String `"true"`, so provisioning sets every value type explicitly, and the time-based edge on Diagnose fires only on phone calls, so it is tested by phone.

## ADR-011. Variable edges for facts, LLM edges for intent

**Status.** Accepted

**Context.** Some routing decisions are facts known before the call (area status, identity, repeat caller, flags, elapsed time). Others depend on what the caller means.

**Decision.** Facts route through variable comparisons, declared in priority order because the first true edge wins. Intent routes through LLM conditions written as explicit decisions. Diagnose also has a time guard on `telnyx_conversation_duration_secs`.

**Consequences.** Deterministic paths are predictable and testable, and the model only decides what it is good at. On calls, variable edges win over LLM edges because they are evaluated before the model turn.

## ADR-012. Append instructions by default, replace only in Degraded

**Status.** Accepted

**Context.** Append keeps the global persona and safety rules. In the Degraded node, the global prompt describes tools the call does not have, which invites invented tool results.

**Decision.** Every prompt node appends, except Degraded, which replaces the base instructions with a short standalone prompt.

**Consequences.** One place for global rules, and no stale tool descriptions where tools are missing.

## ADR-013. Personalise on caller ID, act only on verification or attestation

**Status.** Accepted

**Context.** Caller ID can be spoofed. Greeting by name and announcing an area outage are low risk, while running diagnostics or creating tickets acts on an account.

**Decision.** Four identity levels (`anonymous`, `number_match`, `attested`, `verified`). A number match personalises the greeting, plays the outage notice and allows outage reports, which are deduped per account. Diagnostics and repair tickets need `attested` or `verified`. Anyone can leave a callback request. Verification asks a matched caller only for the postcode, and an unknown caller for account number and postcode.

**Consequences.** Calls from abroad (no SHAKEN attestation) still get personalisation and the outage path, plus one question before account actions.

## ADR-014. Strict routing, authentication before state

**Status.** Accepted. On 12 October Thiago allowed one exception for reads. mock-crm starts its two secret reads and its flags read on a container's first request of any kind, unknown paths included, once per container and without waiting for them. So its first keyed lookup waits for the slowest read instead of their sum (T20, DEBUGLOG issue 15). On 13 October Claude Code extended the same exception to voice-context and voice-tools (T22, DEBUGLOG issue 17), under Thiago's go-ahead for code that survives a replica's first use. Nothing changes state before authentication.

**Evidence.** DEBUGLOG issue 4. The sample actor function changed state on every path, including a browser's favicon request and an unexplained visitor.

**Decision.** Each function answers only its known routes and returns 404 for everything else. Signature or token checks run before any KV or actor access. Our own log line records the user agent and the auth result for every request.

**Consequences.** Unsolicited traffic shows up as rejected requests in our logs instead of mystery state changes.

## ADR-015. Every write is idempotent, and a timeout is an unknown outcome

**Status.** Accepted

**Evidence.** DEBUGLOG issue 5. A KV namespace create timed out in the CLI but had succeeded on the server.

**Decision.** Writes that create something take a dedupe key (tickets use the session id plus category, call records use the call id). Retries check before writing again. Telnyx API calls that create resources send an `Idempotency-Key` header.

**Consequences.** Retries from Telnyx, from the model or from our own code cannot double-create.

## ADR-016. Iterate locally, ship at checkpoints

**Status.** Accepted

**Evidence.** DEBUGLOG issue 3. The first ship took 11 minutes 25 seconds, about four times the documented estimate.

**Decision.** Develop against `telnyx-edge dev`, which runs functions and actors locally in Docker, and against unit tests. Ship only at checkpoints and record every ship time.

**Consequences.** Fast loops. Edge-only behaviour (signatures from real Telnyx traffic, cold starts) is covered by the spikes and the end-to-end tests.

## ADR-017. Own signals for detection, platform logs for forensics

**Status.** Accepted

**Evidence.** DEBUGLOG issue 4. Invocation logs ran at least 30 seconds behind and record no client IP or user agent. The Telnyx status page has no component for Edge Compute or KV.

**Decision.** Structured JSON logs with per-hop latency and a per-call trace id, plus a Canary actor that runs an end-to-end check every 30 seconds and pushes an alert after two consecutive failures.

**Consequences.** We can answer "how would you know within a minute" with a mechanism instead of a dashboard we have to watch.

## ADR-018. Telnyx-hosted models write the code, Claude Code orchestrates

**Status.** Accepted. The model roles come from the bake-off on T03, on 9 October. On 10 October the tester was dropped from T07 on.

**Context.** Requirement 6 asks for the solution to be built with Telnyx Inference through OpenCode, and allows comparing other tools. The review asks which models we chose and why. Three facts shaped the setup. The `@telnyx/opencode` plugin runs only on OpenCode v1 (DEBUGLOG issue 2). Telnyx Inference hosts open-weight models only, so Claude is not available through it. Anthropic's terms allow a Claude subscription only in Claude's own apps and in Claude Code, so connecting the subscription to OpenCode is not an option.

**Decision.** OpenCode 1.18.35 with `@telnyx/opencode` 0.1.5, and two agents with separate roles. The implementer runs on Kimi-K3 and writes the code and its tests, and the reviewer runs on GLM-5.3, as chosen by the bake-off on T03. A third agent, the tester on DeepSeek-V4-Flash-0731, wrote the tests before the implementer on T02, T04 and T06, and is not used from T07 on. Claude Code, on Thiago's Claude subscription, is the orchestrator and an independent reviewer. It runs each card through `tools/card.sh`, reviews the result, writes feedback and commits accepted work, following `CLAUDE.md`. `.claude/settings.json` denies it edits to solution code, so every line of application code, tests, scripts and infrastructure configuration comes from a Telnyx-hosted model. `tools/card.sh` records every agent run, with the models and token counts from OpenCode's own session export, and each accepted card commits that record as `docs/agent-runs.jsonl`.

**Roles.** The measurements are in `DOGFOODING.md`.

- Kimi-K3 implements and writes the tests, because it passed T03 on the first attempt with the strictest code and the strongest tests. On T06 it also refused a tester test that contradicted the card and asked about it instead.
- DeepSeek-V4-Flash-0731 wrote the tests on T02, T04 and T06, chosen because it was the fastest, wrote the most tests with exact reasons, comes from a different family than the implementer, and uses no reasoning tokens. On T02 and T06 its tests contradicted the card, and the implementer followed them, once into a timing bug (DEBUGLOG issue 8) and once into a ticket dedupe key that dropped its category, against ADR-015. Sharper tester instructions after T02 did not stop it. So from T07 on the implementer writes its own tests, and the reviewer and Claude Code check them against the card.
- GLM-5.3 reviews, because its finished reviews were the most precise. It does not write code, because as implementer in the bake-off it stopped at its output cap of 8,192 tokens before writing anything. The agent files now raise that cap to 16,384 (DEBUGLOG issue 7), and `tools/card.sh` fails a step that still reaches it, with one rerun for a cut-off review.

**Consequences.** The model choice is backed by measurements, and the record of who wrote what can be checked commit by commit. Without a separate tester, the code and its tests come from one model, so their mistakes can line up. Two reviews of every diff, GLM-5.3's and Claude Code's, check the tests against the card to make up for it. The loop does not depend on Claude Code. Thiago can run `tools/card.sh` and review by hand with the same evidence, which is also the fallback if a Telnyx-only workflow is preferred. The orchestrator is a cost outside Telnyx, Thiago's subscription, and `DOGFOODING.md` names it next to the inference spend.

## ADR-019. Sessions live in an actor, and hot KV reads go through memory caches

**Status.** Accepted, 10 October, after spike S1. On 12 October a KV read had outgrown the flags' 1,000 ms bound, so every refresh timed out and the flags never applied (DEBUGLOG issue 15). T20 makes each flags cache serve its last good value and refresh it in the background.

**Evidence.** DEBUGLOG issue 11 and the S1 measurements. From inside a function a KV read takes about 0.8 s and a write about 1.4 s. An actor round trip takes 141 ms warm and about 280 ms after a pause.

**Context.** Every call setup writes a session and every MCP tool call reads it. In KV that costs each call setup a 1.4 to 1.8 s write and each MCP call a 0.8 s read. The runtime has no `waitUntil`, so a write cannot finish after the response, and the call setup webhook has 4,000 ms in all. Call setup also reads the flags, the CRM cache and the area status from KV, at about 0.8 s each.

**Decision.** One `Session` actor per call, with the sid as its instance name. `voice-tools` ships the class, and `voice-context` reaches it through a shared actor binding, as with `CustomerAccount`. The actor keeps the session document (ARCHITECTURE, Actors) and creates it idempotently per sid (ADR-015). It returns null once the session has expired, marks the disclosure, sets the verified identity, and counts verification failures for account numbers that do not exist, locking verification in that session for 15 minutes after three. Its alarm deletes the state when the session expires, two hours after creation. In front of the hot KV reads each container keeps a memory cache, 10 seconds for flags and area statuses and 60 seconds for CRM lookup results. The KV CRM cache stays, because the `crm_fail` part of the demo needs it across containers.

**Consequences.** A session costs one actor round trip at call setup and one per MCP call, instead of a KV write and a KV read. One call is one sequential writer, so its instance never queues. Every call leaves a short-lived instance that deletes its own state by alarm. A warm container answers most call setups from memory in about 0.2 s. In exchange, a new area status can take up to 10 seconds longer to reach callers on a warm container, and a flag change up to 10 seconds to apply. KV keeps the CRM cache, the flags, the area status read model, callback requests and the canary results.

## ADR-020. Every prompt node sees the five MCP tools, and its instructions name its own

**Status.** Accepted, 12 October, decided by Thiago.

**Context.** `docs/WORKFLOW.md` gave each prompt node only its own tools. The API sets tools per node only for shared tools, through `shared_tool_ids` and `tools_mode` on a prompt node. Telnyx documents no way for a node to switch an MCP server's tools on or off (https://developers.telnyx.com/docs/inference/ai-assistants/workflows.md and the create-assistant reference).

**Decision.** Every prompt node sees all five tools of the MCP server `duinvezel-voice-tools`, and the payload sets no per-node tool field. Each node's instructions name the tools it may use, and a node without tools names none. The server's identity checks (ADR-013) stay the gate. Transfer, hangup and the disclosure log are shared tools that run only on their tool nodes and are not attached to the assistant.

**Consequences.** The model can call a tool from a node that does not name it, for example `report_outage` from Triage. At worst that is an action the step did not plan, never one on another account or above the caller's identity level. T12 tests that each node's instructions name exactly its tools, and T13's transcripts show whether the model strays. On 14 October it strayed in every call that used an MCP tool, and ran the line check, an outage report and a callback from Verify (DEBUGLOG issue 23). T27 added a base rule that each step uses only the tools its instructions name, and the next call ignored it. Thiago then chose to drop the rule, and T28 moved the rules that must hold in every step into the base instructions. A plainer rule in Verify is the next step after the review, once a call shows whether a step change between two prompt nodes hands the model a turn. A speak node does not (DEBUGLOG issue 24).

## ADR-021. A transfer briefs the engineer, waits for a yes and stops at voicemail

**Status.** Accepted, 14 October, decided by Thiago. Untested until the calls after T29.

**Evidence.** Telnyx's pages on warm transfer acceptance (https://developers.telnyx.com/docs/inference/ai-assistants/warm-transfer-acceptance.md) and on voicemail detection on transfer (https://developers.telnyx.com/docs/inference/ai-assistants/voicemail-detection-on-transfer.md), and the `TransferToolParams` schema in Telnyx's OpenAPI spec (https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json), read on 14 October. DEBUGLOG issue 28.

**Context.** The shared transfer tool set only `targets` and `from`. In the rehearsal the caller heard silence while the engineer's phone rang (DEBUGLOG issue 28). A transfer that reached the engineer's voicemail would have left the caller there. The transfer tool takes three more settings.

- `warm_transfer_instructions` tells the assistant how to brief the person who answers.
- `warm_transfer_acceptance` has the assistant ask that person, on a private leg, whether they take the call. Only a yes bridges the calls, and meanwhile the caller stays with the assistant and hears ringback. A decline, a hang-up or two minutes without an answer bring the assistant back to the caller.
- `voicemail_detection` runs answering machine detection on the transfer. With the action `stop_transfer`, a transfer that reaches voicemail ends and the caller returns to the assistant.

**Decision.** The transfer tool sets all three. The brief is one or two sentences on what the customer needs and what the call has done so far, and it ends by asking whether the engineer can take the call. Acceptance keeps its default private mode, so the exchange with the engineer stays out of the transcript, and `require_acceptance` stays unset. Voicemail detection runs in `premium` mode with `stop_transfer`. The Handoff line tells the caller they will hear ringing, that the call may be recorded, and that they can ask the engineer not to record it.

**Consequences.**

- The docs show these settings only on an assistant's inline transfer tool. The shared tools API leaves the `transfer` object open, so the provisioning runs after T29 show whether the API keeps them. The third run prints `unchanged` only if it does.
- Acceptance is documented only for calls started with `ai_assistant_start`, and not for web calls. The docs do not say whether calls through the assistant's TeXML application and the portal's browser calls count, though both carry the channel `phone_call` in their transcripts. Where acceptance cannot run, the transfer falls back to a warm transfer that plays the brief to the engineer and then bridges.
- The Transfer node's default edge is documented for a transfer that fails. Whether a decline or a stop at voicemail takes it to Take message is not documented, and the calls after T29 show it.
- In private mode the transfer's result is the only record of the outcome in the transcript.
