# Cards T13 to T17 (outlines)

These get written in full once the spikes have answered their questions, because their details depend on what S2, S3 and S4 find. Each outline already names the goal and what done looks like. `telnyx-edge dev` has no secrets, environment variables or KV namespace (DEBUGLOG issue 9), so anything keyed is checked against the deployed functions.

## T13. End-to-end path tests

**Goal.** Call every path in `docs/WORKFLOW.md` (A to K) at least once, and record the trace id, the nodes the transcript shows, and the matching log lines in `docs/TEST-PLAN.md`.

Path G, the time guard, is tested by phone, because browser test calls never fire a time-based edge (S2). A call with the mock-crm flag `crm_fail` set shows how Telnyx treats a tool result with `isError: true`, which every failing dependency and every invalid argument now returns (T19). That matters because S4 saw Telnyx crash a call on an MCP failure its docs said the call would survive (DEBUGLOG issue 13), so the transcript and the call's end state go into the evidence. `verify_account` and `check_area_status` take a postcode or an account number sent as a JSON number (T10 follow-up of 12 October), so a call where the model sends one still verifies, and the transcripts show how often it happens. Before the first call, check that every variable edge in the provisioned workflow has its value type set explicitly, String for `"true"` and `"false"` and Number for the duration, since a Boolean `true` never matches the string a variable holds. Actor lines are in `telnyx-edge actors logs <Type>`, and the platform may redact trace ids in runtime logs (DEBUGLOG issue 16), so each call's evidence also names its time window.

**Done when** every path has a passing call with evidence, or a bug entry in `DEBUGLOG.md` and a fix.

## T14. Canary actor and alert

**Goal.** A `Canary` actor in `voice-tools` whose alarm runs every 30 seconds. It calls `voice-context /internal/health` (which includes a real CRM lookup), creates a canary session through `POST /internal/sessions`, and runs MCP `initialize` and `tools/list` with it. It writes the run to `canary/last` with per-check latency, and after two consecutive failures sends a push notification through ntfy (topic in the secret `NTFY_TOPIC`), then one more on recovery. `POST /internal/canary/start` arms it. The health check's KV probe timed out on 2 of 22 calls in T10, about one call in ten (DEBUGLOG, T10 measurements), so the canary alerts only on consecutive failures, never on a single one.

**Done when**, against the deployed functions, setting the flag `crm_fail` to true triggers a push within about a minute, and clearing it triggers the recovery message. The README section "How we would know it is broken" describes exactly this.

## T15. Demo tooling

**Goal.** Scripts that make the demo repeatable.
- `scripts/flags.ts get|set <name> <value>` edits `flags/global`.
- `scripts/simulate-reports.ts <postcode> <count>` creates sessions for fixture accounts through `/internal/sessions` and calls `report_outage` over MCP.
- `scripts/resolve-area.ts <postcode>` calls a new internal route that resolves an `AreaIncident`.
- `scripts/tail.sh` tails all three functions' logs and the three actor types' logs (`telnyx-edge actors logs <Type> --tail`) with useful `jq` filters.

After the report that crosses the threshold, the script waits about 15 seconds before the next call, because the alarm publishes the new status a few seconds later and warm containers keep area statuses in memory for 10 seconds (ADR-005, ADR-019).

**Done when** the threshold-crossing demo (path I) runs end to end from these scripts against the deployed functions.

## T16. Stretch goals

Pick in this order, only once T13 and T14 are done.
1. `subscribe_updates`, with the `AreaIncident` alarm recording a notification on resolve or at the ETA (SMS stays behind a flag, since US 10DLC registration is not possible in time). Outage help's instructions get back their line offering it, which T12 leaves out until the tool exists.
2. A second-line assistant ("Duinvezel Engineering") reached through an assistant edge from Handoff, with its own persona, model and tools. S2 left open how an edge targets another assistant, because the portal offered only Workflow node while one assistant existed, so the API reference settles it before this starts.
3. OTLP log export to a free Grafana Cloud stack, with a dashboard for webhook latency and error rate.

## T17. README and submission

**Goal.** A README with setup steps, the architecture diagram, how to call the assistant with the test accounts, the observability story (including how you would know within a minute that it was broken, and what you would look at first), the debugging story from `DEBUGLOG.md`, and the dogfooding summary. Also finish `docs/DEMO.md`, check that `.opencode/opencode.json` shows the plugin, and make the repo public or invite the reviewers.

**Done when** someone who has never seen the project could call the number and follow the README.

## Cleanup pass

Small open points from accepted cards, done together near the end as follow-up retries on their cards.

- **T02, logger.** Only a real cycle becomes `"[circular]"`, so an object that appears twice in one line is written in full both times. A clock that returns a non-finite value does not make `log()` throw.
- **T05, delay cap.** A `crm_delay_ms` above 10,000 clamps to 10,000 instead of counting as invalid, so a typo during the demo still gives a slow CRM and every route stays far below the 30-second limit. Tests at 10,000 and 10,001. The T05 card gets the same line in that pass.
- **T06, test gaps.** The error path of `recordCall` and the `locked` outcome of `verify` have no logging test, the older actor tests print log lines to stdout, and `customer-account.test.ts` lacks its final newline.
- **Shared, `kvKeys.session`.** Sessions moved to the `Session` actor (ADR-019), so the helper has no caller. Remove it and its tests, so no later card writes a session to KV.
- **T18, a default and an error path.** A test pins the default lock at exactly 15 minutes instead of computing it from `DEFAULT_LOCK_MS`. The `create` error path must not read a missing input, so the `"error"` line is still written and the original error rethrown. The actor tests capture their log lines instead of printing them.
- **T08, pins and gaps.** A test pins the production cache lifetimes in `CACHE_TTL_MS` (10, 10 and 60 seconds), because the tests build their own caches. The soft budget gets a test at exactly 3,000 ms. The CRM client times its `INTERNAL_KEY` read as the `http` hop instead of inside `crm`, so T10's numbers for the call to mock-crm stay clean. The memory caches drop expired entries on write or have a size bound, so the CRM cache cannot grow with every distinct caller for the life of a container. `/healthz` and unknown paths write one log line, as mock-crm does (AGENTS.md, Logging, and ADR-014).
- **T09, gaps.** The `INTERNAL_KEY` read on the diagnostics path (`buildDeps` in `index.ts`) gets a held-promise test at 1,000 ms, and is timed as the `http` hop instead of inside `crm`, as for T08. A test pins the 32-character sid with a random fake that honours the requested length, and another pins that the line id is URL-encoded. The call to mock-crm is cancelled with an `AbortSignal` when its timeout fires. A test pins the answer to a `tools/call` without a `name`, a malformed request that the SDK answers with -32603.
- **T19, follow-up gaps.** A test sends exactly 32 characters for each of `verify_account`'s strings and gets a normal result, since a cap tightened by mistake would turn a spaced-out spoken form into an error. `DV` followed by five or seven digits answers `account_number_unclear` in a test. Each tool gets a test with an argument it does not define, not only `run_line_diagnostics`. The step comments in `verify-account.ts` are numbered in order again.
- **T07, the alarm after a report.** A test pins that a report which sets no outbox leaves a pending retry alarm alone, because no test fails today when every report re-arms the alarm. A report that finds an outbox pending and no alarm set arms one, so a failure between saving the state and setting the alarm cannot strand an outbox.
- **T08, an unsigned request costs a secret read.** `/dv` reads `TELNYX_PUBLIC_KEY` before it checks that the signature headers are present, so a request without them pays a secret read on a new container. That took 546 ms in T10's smoke run (DEBUGLOG, T10 measurements). Checking for the headers first saves it.
- **T08, the KV health check.** `/internal/health` sums the KV put and get in one `kv` hop, so a KV timeout cannot say which call it was, and T10 could not split their times. Each call gets its own latency in the check's answer.
- **T10 follow-up, the production box.** No test drives mock-crm's `default.fetch` across two requests, so a secret box made per request instead of per container would pass. Claude Code's probe of the real handler showed one read of each secret across four requests.
- **Phone numbers in the platform log.** The platform's invocation log records each request's full path, so mock-crm's `GET /customers?phone=<digits>` leaves every caller's number unmasked there (DEBUGLOG issue 16). Thiago accepted that for the demo on 12 October, and `docs/ARCHITECTURE.md` lists it as a known gap. The production answer sends the number in a POST body, which changes mock-crm's route and its callers, voice-context's lookup and health check and `scripts/smoke.sh`.
