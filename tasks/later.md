# Cards T11 to T17 (outlines)

These get written in full once the spikes have answered their questions, because their details depend on what S2, S3 and S4 find. Each outline already names the goal and what done looks like. `telnyx-edge dev` has no secrets, environment variables or KV namespace (DEBUGLOG issue 9), so anything keyed is checked against the deployed functions.

## T11. Assistant provisioning script

**Goal.** One idempotent script, `scripts/provision.ts`, that creates or updates everything on the Telnyx side from the repo, so the assistant is reproducible and reviewable.

It manages the integration secret `mcp_enc_key` (from `DUINVEZEL_MCP_ENC_KEY`), the MCP server (type and URL per S3, credential `{{mcp_token | mcp_enc_key}}`, allowed tools), the shared tools (`log_disclosure` pointing at `voice-context /tools/disclosure`, transfer to the number in `TRANSFER_TO`, hangup), and the assistant itself. The assistant gets model `moonshotai/Kimi-K2.6`, a voice, the base instructions from `assistant/instructions/`, the dynamic variable defaults from the contract, the webhook URL with `dynamic_variables_webhook_timeout_ms` set to 4,000 (approved on 10 October, with the reasoning in `docs/ARCHITECTURE.md`, Call setup latency budget), and the `conversation_flow` from T12. It then assigns the phone number. Every create sends an `Idempotency-Key`, and every id goes into `infra/ids.json`.

**Done when** running the script twice changes nothing the second time, and a test call reaches the Disclosure node.

## T12. Workflow content

**Goal.** `assistant/flow.ts` builds the `conversation_flow` payload from typed definitions that mirror `docs/WORKFLOW.md`, with the instructions in `assistant/instructions/*.md`.

**Done when** a unit test checks the invariants. Every speak node has exactly one default edge, every tool node with edges has exactly one default edge, variable edges come before LLM edges, every referenced node exists, and each node's tools match the table in `docs/WORKFLOW.md`.

## T13. End-to-end path tests

**Goal.** Call every path in `docs/WORKFLOW.md` (A to K) at least once, and record the trace id, the nodes the transcript shows, and the matching log lines in `docs/TEST-PLAN.md`.

**Done when** every path has a passing call with evidence, or a bug entry in `DEBUGLOG.md` and a fix.

## T14. Canary actor and alert

**Goal.** A `Canary` actor in `voice-tools` whose alarm runs every 30 seconds. It calls `voice-context /internal/health` (which includes a real CRM lookup), creates a canary session through `POST /internal/sessions`, and runs MCP `initialize` and `tools/list` with it. It writes the run to `canary/last` with per-check latency, and after two consecutive failures sends a push notification through ntfy (topic in the secret `NTFY_TOPIC`), then one more on recovery. `POST /internal/canary/start` arms it.

**Done when**, against the deployed functions, setting the flag `crm_fail` to true triggers a push within about a minute, and clearing it triggers the recovery message. The README section "How we would know it is broken" describes exactly this.

## T15. Demo tooling

**Goal.** Scripts that make the demo repeatable.
- `scripts/flags.ts get|set <name> <value>` edits `flags/global`.
- `scripts/simulate-reports.ts <postcode> <count>` creates sessions for fixture accounts through `/internal/sessions` and calls `report_outage` over MCP.
- `scripts/resolve-area.ts <postcode>` calls a new internal route that resolves an `AreaIncident`.
- `scripts/tail.sh` tails all three functions' logs with useful `jq` filters.

**Done when** the threshold-crossing demo (path I) runs end to end from these scripts against the deployed functions.

## T16. Stretch goals

Pick in this order, only once T13 and T14 are done.
1. `subscribe_updates`, with the `AreaIncident` alarm recording a notification on resolve or at the ETA (SMS stays behind a flag, since US 10DLC registration is not possible in time).
2. A second-line assistant ("Duinvezel Engineering") reached through an assistant edge from Handoff, with its own persona, model and tools.
3. OTLP log export to a free Grafana Cloud stack, with a dashboard for webhook latency and error rate.

## T17. README and submission

**Goal.** A README with setup steps, the architecture diagram, how to call the assistant with the test accounts, the observability story (including how you would know within a minute that it was broken, and what you would look at first), the debugging story from `DEBUGLOG.md`, and the dogfooding summary. Also finish `docs/DEMO.md`, check that `.opencode/opencode.json` shows the plugin, and make the repo public or invite the reviewers.

**Done when** someone who has never seen the project could call the number and follow the README.

## Cleanup pass

Small open points from accepted cards, done together near the end as follow-up retries on their cards.

- **T02, logger.** Only a real cycle becomes `"[circular]"`, so an object that appears twice in one line is written in full both times. A clock that returns a non-finite value does not make `log()` throw.
- **T05, delay cap.** A `crm_delay_ms` above 10,000 clamps to 10,000 instead of counting as invalid, so a typo during the demo still gives a slow CRM and every route stays far below the 30-second limit. Tests at 10,000 and 10,001. The T05 card gets the same line in that pass.
- **T06, test gaps.** The error path of `recordCall` and the `locked` outcome of `verify` have no logging test, the older actor tests print log lines to stdout, and `customer-account.test.ts` lacks its final newline.
- **T07, publish timeout (needs Thiago's decision).** The inline KV publish has a 300 ms timeout, and S1 measured KV writes at 1.1 to 1.8 s (DEBUGLOG issue 11). Every publish would then likely count as timed out, and the alarm would keep retrying every minute although the writes land. The choice is a longer inline timeout, which makes the declaring `report` about 1.4 s slower, or publishing from the alarm right away.
- **Shared, `kvKeys.session`.** Sessions moved to the `Session` actor (ADR-019), so the helper has no caller. Remove it and its tests, so no later card writes a session to KV.
- **T18, a default and an error path.** A test pins the default lock at exactly 15 minutes instead of computing it from `DEFAULT_LOCK_MS`. The `create` error path must not read a missing input, so the `"error"` line is still written and the original error rethrown. The actor tests capture their log lines instead of printing them.
- **T08, pins and gaps.** A test pins the production cache lifetimes in `CACHE_TTL_MS` (10, 10 and 60 seconds), because the tests build their own caches. The soft budget gets a test at exactly 3,000 ms. The CRM client times its `INTERNAL_KEY` read as the `http` hop instead of inside `crm`, so T10's numbers for the call to mock-crm stay clean. A flags document that is present but malformed is not cached as the defaults. The memory caches drop expired entries on write or have a size bound, so the CRM cache cannot grow with every distinct caller for the life of a container. `/healthz` and unknown paths write one log line, as mock-crm does (AGENTS.md, Logging, and ADR-014).
- **T07, latency on actor lines.** The `actor`, `publish` and `publish_retry` lines log `latency_ms` as a number. They should carry the same object as the request lines, `total` and whichever hops apply.
