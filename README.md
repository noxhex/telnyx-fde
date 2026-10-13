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

## Before a demo

Each function runs on several replicas, and a replica reads its secrets and flags on first use. On 13 October those reads took 0.55 to over 1 s, and they made two of the first calls miss the caller's account or a verification (DEBUGLOG issue 17). Since T22 a replica starts those reads on its first request of any kind, and a call that meets a fresh replica still gets through. The warm-up makes that case rarer. Before a demo Thiago runs four steps.

1. `scripts/demo.sh reset` clears every fixture account's call history, failures and lock, and every area's reports and incident.
2. `scripts/smoke.sh` checks each function's health and auth, opens an MCP session with `initialize` and `tools/list`, and runs voice-context's dependency check, which makes a real CRM lookup.
3. MCP Inspector, with a session token from `POST /internal/sessions`, calls `tools/list` and then `verify_account` for DV-100002 on the deployed `/mcp`. The call's line in voice-tools' log confirms the round trip.
4. `scripts/demo.sh reports 8670 2` puts two simulated outage reports on Koksijde, one short of the threshold.

Thiago's runbook wraps steps 2 and 3 as `t10_smoke` and `t10_inspector`. It lives outside the repo, because it also sets the secrets.

The warm-up only reaches the replicas that answer it. mock-crm served eight requests from four replicas on 13 October, so a reviewer's call can still meet a fresh one. That call is the case T22 covers.

## Next step, a canary

Nothing watches the assistant between calls yet. The next step is a `Canary` actor in voice-tools.

- **Every 30 seconds** its alarm calls voice-context's `/internal/health`, which makes a real CRM lookup. It then creates a session through `POST /internal/sessions` and runs MCP `initialize` and `tools/list` with it.
- **Each run** goes to the KV key `canary/last`, with the latency of every check.
- **After two failed runs in a row** it sends a push notification through ntfy, and one more when it recovers. The topic stays in a secret, `NTFY_TOPIC`. A single failure never alerts, because the health check's KV probe failed on 2 of 22 calls in T10 (DEBUGLOG, T10 measurements).
- **The test of it** is a flag. `scripts/demo.sh flags set crm_fail true` should bring a push within about a minute, and `scripts/demo.sh flags set crm_fail null` the recovery message.
- **It would also warm.** Its requests start the reads on the replicas they reach, so over a few minutes it would do the warm-up's job too.
