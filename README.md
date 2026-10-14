# Duinvezel fiber support

A Telnyx AI voice assistant for Duinvezel, a fictional fiber provider on the Belgian coast. It runs on Telnyx Edge Compute with a custom MCP server. The rest of this README comes with card T17.

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

## Manual setup

`scripts/provision.ts` creates or updates the assistant, its three shared tools and the MCP server, and attaches the phone number to the assistant's TeXML application. It calls only `/ai/tools`, `/ai/mcp_servers`, `/ai/assistants` and `/phone_numbers`, so one setting stays manual.

- **The outbound voice profile.** The transfer dials `TRANSFER_TO` from the assistant's number, so the outbound voice profile of the connection making the call must allow the target's country. On 14 October it allowed no Belgian number, and both transfers that day failed before anything rang (DEBUGLOG issue 21). Thiago then allowed Europe on the account's default profile, on the portal's Outbound Voice Profiles page. A new account needs the same step before a transfer can ring anyone.

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

- **The model works from Verify.** Every prompt step sees all five MCP tools (ADR-020). After verification the model runs the line check, outage reports and tickets from Verify instead of moving on to Triage and Diagnose. T27 told it to move on and the next call ignored that, so T28 put the rules that must hold into the base instructions instead (DEBUGLOG issue 23). The next step is a plainer rule in Verify that those actions belong to later steps, once a call shows that a step change between two prompt steps leaves no pause.
- **mock-crm can run out of replicas.** On 14 October, after almost six hours without a request, the next lookup waited about 20 s for a new replica. A known caller was greeted as unknown and asked for the full verification (DEBUGLOG issue 22). The warm-up starts a replica, so it runs again just before a demo. The canary below would keep one up all the time.
- **Slow KV can hide an outage notice.** `/dv` reads the five area statuses from KV, behind a 10-second memory cache. On 14 October those reads took about 2 s. A caller whose area read runs past its 2,500 ms limit gets no outage notice. The fix keeps each replica's last good status per area and uses it when a fresh read runs out, the way the flags have worked since T20.
- **A withheld number gets no callback.** A callback request from a withheld number stores no number to call. The fix has Take message ask for one when the caller's number is unknown. On 14 October `#31#` did not withhold Thiago's number, so the withheld-caller path is covered only by tests.

## Next step, a canary

Nothing watches the assistant between calls yet. The next step is a `Canary` actor in voice-tools.

- **Every 30 seconds** its alarm calls voice-context's `/internal/health`, which makes a real CRM lookup. It then creates a session through `POST /internal/sessions` and runs MCP `initialize` and `tools/list` with it.
- **Each run** goes to the KV key `canary/last`, with the latency of every check.
- **After two failed runs in a row** it sends a push notification through ntfy, and one more when it recovers. The topic stays in a secret, `NTFY_TOPIC`. A single failure never alerts, because the health check's KV probe failed on 2 of 22 calls in T10 (DEBUGLOG, T10 measurements).
- **The test of it** is a flag. `scripts/demo.sh flags set crm_fail true` should bring a push within about a minute, and `scripts/demo.sh flags set crm_fail null` the recovery message.
- **It would also warm.** Its requests start the reads on the replicas they reach, so over a few minutes it would do the warm-up's job too.
