# Duinvezel fiber support

A Telnyx AI voice assistant for Duinvezel, a fictional fiber provider on the Belgian coast. It runs on Telnyx Edge Compute with a custom MCP server.

## Submission checklist

| Item | Where |
|---|---|
| Repository | https://github.com/noxhex/telnyx-fde |
| Test number | **+1 650 536 0717** |
| How to call | Dial the test number from any phone. Your number is not on file, so the assistant verifies you with a test account from "Call the assistant" below |
| voice-context | https://voice-context-00d2df1a-d.telnyxcompute.com, call setup and the disclosure log |
| voice-tools | https://voice-tools-11c54a81-0.telnyxcompute.com, the MCP server and the actors |
| mock-crm | https://mock-crm-26584f2f-d.telnyxcompute.com, the fake back office |
| MCP server URL | https://voice-tools-11c54a81-0.telnyxcompute.com/mcp, Streamable HTTP. It answers 401 without the per-call token that call setup mints (ADR-008) |
| OpenCode config | `.opencode/opencode.json`, with the three agents in `.opencode/agents/` |

The function URLs and every platform id are also in `infra/ids.json`.

## Call the assistant

Call **+1 650 536 0717**.

- **The start of the call.** You hear a short notice that the call is recorded, and then the assistant asks how it can help.
- **Verification.** Your number is not on file, so the assistant asks for an account number and a postcode before it acts on an account.
- **Four test accounts.** Each one shows one scenario, so a lockout on one never blocks the others.

| Account | Postcode | Name | Try saying | What it shows |
|---|---|---|---|---|
| DV-100004 | 8620 | Lotte | "My internet is slow." | Verification, then a line test that comes back clean |
| DV-100005 | 8660 | Wout | "My connection keeps dropping." | The line test finds a problem. The assistant walks you through a restart and books a repair visit with a time window |
| DV-100006 | 8670 | Anke | "I have no internet at all." | The line test shows the line down. Your outage report is the third from Koksijde, so the area goes into outage with an ETA, and the next caller from 8670 hears an outage notice first |
| DV-100007 | 8600 | Geert | Give a wrong postcode three times | The account locks for 15 minutes, and the assistant transfers you to a support engineer |

Before the review the demo state is reset, and two simulated outage reports are put on 8670.

Thiago shows the recognised-caller path from his own phone. That path is a greeting by name, a postcode-only check and the outage notice for his area.

## How the workflow is built

The full design is in `docs/WORKFLOW.md`, and `assistant/flow.ts` builds it for the provisioning script.

- **Tools per node.** Telnyx can limit a node to some shared tools, but it documents no way to switch an MCP server's tools on or off per node (ADR-020). Every prompt node therefore sees all five MCP tools, and its instructions name the ones it may use. Verify names `verify_account` and `check_area_status`, Diagnose `run_line_diagnostics` and `report_outage`, Outage help `report_outage`, and Repair ticket and Take message `create_ticket`. Triage and Degraded name none. The real gate is the MCP server. Each tool checks the identity level in the call's session, so a tool used from the wrong step still cannot act above what the caller proved (ADR-013). Transfer, hangup and the disclosure log are shared tools, and they run only on their own tool nodes. On calls the model still used tools from Verify (Known issues).
- **Append or replace.** Every prompt node appends its instructions to the base instructions, so the persona and the rules for every step live in one place (ADR-012). Degraded replaces them. It runs when call setup failed and the call has no MCP tools, and base instructions that describe missing tools invite made-up results.
- **Variable or LLM edges.** Facts known before the caller speaks route through variable comparisons, and what the caller means routes through LLM conditions written as decisions (ADR-011). Route call checks `session_ok`, `area_outage`, `repeat_caller` and `needs_verification` in that order, and the first true edge wins. Diagnose checks `diagnostics_enabled` and a 300-second limit on `telnyx_conversation_duration_secs`. Every other choice is an LLM condition, such as "The caller asks to talk to a person, such as an engineer or an agent." Variable edges run before the model's turn, so a fact always wins over the model's reading of the call. They compare the strings `"true"` and `"false"` with the type set explicitly, because the portal types `true` as a Boolean (`docs/WORKFLOW.md`, S2).
- **Routing on a tool node.** Route call is a tool node right after the disclosure. Its webhook records that the disclosure played, and its variable edges route exactly once per call (ADR-010).

## Where state lives

| Home | What lives there | Why |
|---|---|---|
| Function memory | Nothing that must survive. Each replica keeps the flags and the five area statuses for 10 seconds, CRM results for 60 seconds, and its secrets once read | A KV read takes about a second from a function (DEBUGLOG issue 11), so a warm replica answers from memory. Replicas come and go, so nothing here is the only copy |
| Actors | `CustomerAccount` per account, for verification attempts, the lockout, call history and tickets. `AreaIncident` per postcode, for outage reports and the incident decision. `Session` per call, for the caller's identity level | An actor runs one call at a time and its writes are durable, so a count, a lockout or an incident happens exactly once. Alarms lift a lockout and publish an area's status |
| KV | The area status the actor publishes, the CRM cache for ten minutes, the feature flags, and callback requests from callers without an account | Every caller from an area reads the same status, and reading it from the actor would queue them all on one instance. KV is last-write-wins with no compare-and-swap, so it holds only values where that is harmless |

`docs/ARCHITECTURE.md` has the full table, with the timings behind it.

## Detecting breakage within a minute

Nothing alerts on its own yet. The canary under "Next step" below is the designed answer (ADR-017). Until it runs, these signals show a break within a minute, without a search through raw logs.

- **The smoke script.** `scripts/smoke.sh` checks all three functions end to end in seconds. It opens a real MCP session and runs voice-context's dependency check, which makes a real CRM lookup and a KV round trip. It prints one PASS or FAIL line per check, with each dependency's latency.
- **Per-hop latency.** Every log line splits `latency_ms` into `kv`, `actor` and `crm`, so a slow dependency shows by name on the first call after it slows down.
- **The call's `dv` line.** `identity`, `cache`, `outcome` and `reasons` show a call that lost its caller, its area status or its session (`session_error`, `session_timeout`).
- **The transcript.** Telnyx records each reply's `end_user_perceived_latency_ms`, and it adds a `[long silence]` line after about ten seconds in which nobody speaks (DEBUGLOG issue 24).

What to check first, in this order.

1. `scripts/smoke.sh`, for which function or dependency fails.
2. The last call's `dv` line, for what call setup knew and how long it took.
3. voice-tools' lines for the same trace id, for refused tokens and slow tools.
4. The transcript, for what the caller heard.

```bash
source ~/.config/telnyx/env && scripts/smoke.sh
telnyx-edge logs voice-context --since 10m --json \
  | jq -r '.data[].message | fromjson? | select(.event == "dv") | [.ts, .trace_id[0:12], .identity, .cache, .outcome, (.reasons | join(",")), .latency_ms.total] | @tsv'
telnyx-edge logs voice-tools --since 10m --json \
  | jq -r '.data[].message | fromjson? | select(.event == "mcp" or .event == "auth_failed") | [.ts, (.trace_id // "-")[0:12], (.tool // .method // .reason), .status, (.latency_ms | tostring)] | @tsv'
telnyx-edge actors logs AreaIncident --type runtime --since 10m
```

The platform's invocation logs run at least 30 seconds behind, so they serve forensics, not detection (DEBUGLOG issue 4).

## Debugging story

**A call setup that could miss its deadline (T24, DEBUGLOG issue 20).** Every call starts with a signed webhook to voice-context's `/dv`. The assistant waits 4,000 ms for the answer, and a late answer means Telnyx uses the defaults, so the call goes to Degraded with no tools. On the morning of 14 October the smoke test failed voice-context's KV probe twice, once after 3,981 ms. The logs showed KV at about twice the previous day's latency. Two browser calls took 2,014 and 2,888 ms in `/dv`, and in both the five area reads ran into their 2,000 ms bound. A fresh replica's secret reads cost 890 ms. The 3,000 ms budget only started after the public key read, and a phone call whose caller mock-crm knew also waited for the CRM cache write, a KV put of about 2.3 to 2.5 s. On a fresh replica that came to 3.5 to 4.0 s of server time, against the 4,000 ms timeout. No call had failed yet, and browser calls never look the caller up, so only a real phone call could hit it. T24 starts the budget when the request arrives, cuts the token key reads to what remains, and stops the answer from waiting for the cache write. The 13 call setups on the evening of 14 October took 0.33 to 2.51 s.

**A regression caught in the transcripts (T29, DEBUGLOG issue 29).** T29 moved the opening question into the disclosure line and told the model to wait for the answer. The transcripts of the first two calls after it showed the model speaking anyway, 0.25 and 0.34 s after Route call, before the caller could answer. In one call it read its own reasoning aloud and hung up. Every test had compared the text with the design, and both reviews had approved it, but only a call could show how the model behaves. A `git revert` and a provisioning run put T28 back the same evening.

## How Telnyx inference built it

Telnyx-hosted models wrote the application code, tests, scripts and infrastructure configuration, through OpenCode and the `@telnyx/opencode` plugin. Claude Code wrote the design docs and the task cards, ran every card and reviewed the result (ADR-018). The one exception is a small change in T30, which Claude Code wrote at Thiago's request after the implementer's two runs ended early (`DOGFOODING.md`).

- **Roles.** A bake-off on one card set them. Kimi-K3 implements and writes its own tests, and GLM-5.3 reviews. DeepSeek-V4-Flash-0731 wrote the tests of the first cards.
- **`tools/card.sh`.** It runs one card at a time, the implementer, then `npm run check`, then the reviewer. It records the session, the models that answered and the tokens of every run. Claude Code then reads the whole diff, and it accepts the card or retries it with written feedback.
- **The record.** [`DOGFOODING.md`](DOGFOODING.md) has a ledger row per attempt, with its cost and what broke, the bake-off, and what worked and what did not. [`docs/agent-runs.jsonl`](docs/agent-runs.jsonl) has every run, failed ones included, 55 runs over 28 cards.

## Manual setup

`scripts/provision.ts` creates or updates the assistant, its three shared tools and the MCP server, and attaches the phone number to the assistant's TeXML application. It calls only `/ai/tools`, `/ai/mcp_servers`, `/ai/assistants` and `/phone_numbers`, so one setting stays manual.

- **The outbound voice profile.** The transfer dials `TRANSFER_TO` from the assistant's number, so the outbound voice profile of the connection making the call must allow the target's country. On 14 October it allowed no Belgian number, and both afternoon transfers failed before anything rang (DEBUGLOG issue 21). Thiago then allowed Europe on the account's default profile, on the portal's Outbound Voice Profiles page, and in the evening rehearsal a transfer from a browser call rang his mobile. A new account needs the same step before a transfer can ring anyone.

## Before a demo

Each function runs on several replicas, and a replica reads its secrets and flags on first use. On 13 October those reads took 0.55 to over 1 s, and they made two of the first calls miss the caller's account or a verification (DEBUGLOG issue 17). Since T22 a replica starts those reads on its first request of any kind, and a call that meets a fresh replica still gets through. The warm-up makes that case rarer. Before a demo Thiago runs four steps.

1. `scripts/demo.sh reset` clears every fixture account's call history, failures and lock, and every area's reports and incident.
2. `scripts/smoke.sh` checks each function's health and auth, opens an MCP session with `initialize` and `tools/list`, and runs voice-context's dependency check, which makes a real CRM lookup.
3. MCP Inspector, with a session token from `POST /internal/sessions`, calls `tools/list` and then `verify_account` for DV-100002 on the deployed `/mcp`. The call's line in voice-tools' log confirms the round trip.
4. `scripts/demo.sh reports 8670 2` puts two simulated outage reports on Koksijde, one short of the threshold.

Thiago's runbook wraps steps 2 and 3 as `t10_smoke` and `t10_inspector`. It lives outside the repo, because it also sets the secrets.

The warm-up only reaches the replicas that answer it. mock-crm served eight requests from four replicas on 13 October, so a reviewer's call can still meet a fresh one. That call is the case T22 covers.

## Known issues

These are what a caller can still run into, each with the fix designed for it.

- **A short pause before the opening question.** After the recording notice, the assistant takes 0.5 to 1.4 s to ask "How can I help you today?", and some callers start talking in that gap (DEBUGLOG issue 27). The question is the model's first turn after Route call, the tool step that logs the disclosure and picks the next step. It cannot simply move into the disclosure line, because the model takes a turn as soon as a step starts. T29 tried that with an instruction to wait, and on both calls that evening the model spoke before the caller could answer (issue 29). A fix would end the disclosure with the question and go straight to a prompt step, with no tool step between, the way the outage notice works since T28 (issue 24). Route call's routing and the disclosure log would have to move, so that waits until after the review.
- **The model works from Verify.** Every prompt step sees all five MCP tools (ADR-020). After verification the model runs the line check, outage reports and tickets from Verify instead of moving on to Triage and Diagnose. T27 told it to move on and the next call ignored that, so T28 put the rules that must hold into the base instructions instead (DEBUGLOG issue 23). The next step is a plainer rule in Verify that those actions belong to later steps, once a call shows that a step change between two prompt steps leaves no pause.
- **mock-crm can run out of replicas.** On 14 October, after almost six hours without a request, the next lookup waited about 20 s for a new replica. A known caller was greeted as unknown and asked for the full verification (DEBUGLOG issue 22). The warm-up starts a replica, so it runs again just before a demo. The canary below would keep one up all the time.
- **Slow KV can hide an outage notice.** `/dv` reads the five area statuses from KV, behind a 10-second memory cache. On 14 October those reads took about 2 s. A caller whose area read runs past its 2,500 ms limit gets no outage notice. The fix keeps each replica's last good status per area and uses it when a fresh read runs out, the way the flags have worked since T20.
- **A withheld number gets no callback.** A callback request from a withheld number stores no number to call. The fix has Take message ask for one when the caller's number is unknown. On 14 October `#31#` did not withhold Thiago's number, so the withheld-caller path is covered only by tests.
- **The portal shows an MCP error.** The assistant's page lists "MCP Server Configuration Errors" for duinvezel-voice-tools, "Request failed with status 422". The server's key reference needs the per-call token, which exists only during a call (ADR-008), and no request from the portal's check reached voice-tools in the 24 hours of logs. Calls are not affected, and all 13 calls on the evening of 14 October opened their MCP session.

## Next step, a canary

Nothing watches the assistant between calls yet. The next step is a `Canary` actor in voice-tools.

- **Every 30 seconds** its alarm calls voice-context's `/internal/health`, which makes a real CRM lookup. It then creates a session through `POST /internal/sessions` and runs MCP `initialize` and `tools/list` with it.
- **Each run** goes to the KV key `canary/last`, with the latency of every check.
- **After two failed runs in a row** it sends a push notification through ntfy, and one more when it recovers. The topic stays in a secret, `NTFY_TOPIC`. A single failure never alerts, because the health check's KV probe failed on 2 of 22 calls in T10 (DEBUGLOG, T10 measurements).
- **The test of it** is a flag. `scripts/demo.sh flags set crm_fail true` should bring a push within about a minute, and `scripts/demo.sh flags set crm_fail null` the recovery message.
- **It would also warm.** Its requests start the reads on the replicas they reach, so over a few minutes it would do the warm-up's job too.
