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

**Status.** Accepted

**Context.** Every call setup needs the caller's area status. Routing those reads through the actor would queue every caller from the outage area on one single-threaded instance at the worst possible moment, and the smoke test measured an actor round trip at about 150 ms warm and about 290 ms after a pause.

**Decision.** The actor publishes `area/<postcode>/status` to KV whenever the status changes. Call setup reads KV only. Publishing uses an outbox. The pending status is saved in actor storage in the same turn as the decision, the KV write follows, and the actor's alarm retries until it succeeds.

**Consequences.** Reads fan out from KV. The announcement can be up to a second or two stale, which is fine for "there is an outage in your area". The outbox closes the dual-write gap between actor storage and KV.

## ADR-006. CustomerAccount actor for limits, history and tickets

**Status.** Accepted

**Context.** Verification attempts must survive a hang-up, and two parallel calls guessing the same account must not both get a third attempt. Repeat-caller detection needs a per-account call count. Tickets must not be created twice.

**Decision.** One `CustomerAccount` actor per account. `verify` checks and updates the attempt counter in one turn and locks the account for 15 minutes after three failures. An alarm lifts the lock. `recordCall` counts calls in the last 24 hours and is idempotent per call id. `createTicket` is idempotent per dedupe key. `voice-tools` ships the class and `voice-context` reaches it through a shared actor binding.

**Consequences.** Read-modify-write without a lock, on exactly the operations that need it. Actors are created only for accounts that exist in the CRM, so random account numbers cannot spawn instances.

## ADR-007. Sessions, caches and flags live in KV

**Status.** Accepted

**Context.** A call is one sequential conversation, so its session has a single writer. CRM lookups are re-queryable data. Flags must change without a redeploy.

**Decision.** Sessions in KV with a two-hour TTL, CRM lookups cached for ten minutes, and flags in `flags/global`.

**Consequences.** KV is used for exactly the workloads the brief lists. No counters or coordination ever go in KV.

## ADR-008. Per-call capability token through encrypted dynamic variables

**Status.** Pending (spike S4)

**Context.** The MCP server must know which call, account and area a request belongs to. Passing an account id as a tool argument would let a prompt-injected caller ask for someone else's account.

**Decision.** At call setup `voice-context` mints an HMAC-signed token naming the session, encrypts it with AES-256-GCM under a key shared with Telnyx as an integration secret, and returns it in `encrypted_dynamic_variables.mcp_token`. The MCP server is configured with `api_key_ref: "{{mcp_token | mcp_enc_key}}"`, so Telnyx sends the decrypted token as the bearer token.

**Consequences.** The model never sees the token, and every MCP request carries the trace id. If decryption fails, Telnyx excludes the MCP server for that call instead of connecting unauthenticated, so the prompts must handle missing tools.

## ADR-009. Stateless MCP over Streamable HTTP

**Status.** Pending (spike S3)

**Context.** Containers recycle and scale to zero, any request can land on any container, and requests are capped at 30 seconds. Long-lived SSE streams and in-memory MCP sessions do not fit.

**Decision.** Every MCP request is a self-contained POST answered with a JSON response. Session state lives in KV and actors. We use the official SDK only if spike S3 shows it runs inside the edge fetch handler. Otherwise we implement the small JSON-RPC subset Telnyx uses (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`).

**Consequences.** No sticky sessions, nothing to lose on a restart, and MCP Inspector can test every request in isolation.

## ADR-010. Route on a tool node right after the disclosure

**Status.** Pending (spike S2)

**Context.** A speak node must have exactly one default edge, so routing has to happen in the next node. On calls, variable edges on a prompt node are evaluated before each model turn. If that turn waits for the caller to speak, routing would stall until they say something, and coming back to that node later would fire the same edges again. S2 checks how this behaves in practice.

**Decision.** The disclosure speak node leads to a Route call tool node. Its shared webhook tool records that the disclosure played, and its variable edges route on the call setup variables, followed by one default edge.

**Consequences.** Routing happens immediately after the disclosure, runs exactly once per call, and leaves an audit record that the disclosure was delivered.

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

**Status.** Accepted

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

**Status.** Accepted. The model roles come from the bake-off on T03, on 9 October.

**Context.** Requirement 6 asks for the solution to be built with Telnyx Inference through OpenCode, and allows comparing other tools. The review asks which models we chose and why. Three facts shaped the setup. The `@telnyx/opencode` plugin runs only on OpenCode v1 (DEBUGLOG issue 2). Telnyx Inference hosts open-weight models only, so Claude is not available through it. Anthropic's terms allow a Claude subscription only in Claude's own apps and in Claude Code, so connecting the subscription to OpenCode is not an option.

**Decision.** OpenCode 1.18.35 with `@telnyx/opencode` 0.1.5, and three agents with separate roles. The implementer runs on Kimi-K3, the tester on DeepSeek-V4-Flash-0731 and the reviewer on GLM-5.3, as chosen by the bake-off on T03. Claude Code, on Thiago's Claude subscription, is the orchestrator and an independent reviewer. It runs each card through `tools/card.sh`, reviews the result, writes feedback and commits accepted work, following `CLAUDE.md`. `.claude/settings.json` denies it edits to solution code, so every line of application code, tests, scripts and infrastructure configuration comes from a Telnyx-hosted model. `tools/card.sh` records every agent run, with the models and token counts from OpenCode's own session export, and each accepted card commits that record as `docs/agent-runs.jsonl`.

**Roles.** The measurements are in `DOGFOODING.md`.

- Kimi-K3 implements, because it passed T03 on the first attempt with the strictest code and the strongest tests.
- DeepSeek-V4-Flash-0731 writes the tests, because it was the fastest, wrote the most tests with exact reasons, comes from a different family than the implementer, and uses no reasoning tokens, so it cannot hit the output cap. Its instructions ask for boundaries and optional parameters, which its T03 tests missed.
- GLM-5.3 reviews, because its finished reviews were the most precise. It does not write code, because its steps can stop at an output cap of about 8,192 tokens (DEBUGLOG issue 7). `tools/card.sh` fails such a step, and a cut-off review gets one rerun.

**Consequences.** The model choice is backed by measurements, and the record of who wrote what can be checked commit by commit. The loop does not depend on Claude Code. Thiago can run `tools/card.sh` and review by hand with the same evidence, which is also the fallback if a Telnyx-only workflow is preferred. The orchestrator is a cost outside Telnyx, Thiago's subscription, and `DOGFOODING.md` names it next to the inference spend.
