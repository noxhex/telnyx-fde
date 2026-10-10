# Cards T11 to T17 (outlines)

These get written in full once the spikes have answered their questions, because their details depend on what S2, S3 and S4 find. Each outline already names the goal and what done looks like. `telnyx-edge dev` has no secrets, environment variables or KV namespace (DEBUGLOG issue 9), so anything keyed is checked against the deployed functions.

## T11. Assistant provisioning script

**Goal.** One idempotent script, `scripts/provision.ts`, that creates or updates everything on the Telnyx side from the repo, so the assistant is reproducible and reviewable.

It manages the integration secret `mcp_enc_key` (from `DUINVEZEL_MCP_ENC_KEY`), the MCP server (type and URL per S3, credential `{{mcp_token | mcp_enc_key}}`, allowed tools), the shared tools (`log_disclosure` pointing at `voice-context /tools/disclosure`, transfer to the number in `TRANSFER_TO`, hangup), and the assistant itself. The assistant gets model `moonshotai/Kimi-K2.6`, a voice, the base instructions from `assistant/instructions/`, the dynamic variable defaults from the contract, the webhook URL and the timeout chosen in S1, and the `conversation_flow` from T12. It then assigns the phone number. Every create sends an `Idempotency-Key`, and every id goes into `infra/ids.json`.

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
