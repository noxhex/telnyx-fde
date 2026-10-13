# T13. Path tests and the rehearsal

**Phase** 2 · **Depends on** T15, T22 and T23 · **Code by** nobody. Thiago calls, and Claude Code reads the logs and records the evidence.

## Goal

Before the review, every path a caller will take has a passing call with evidence in `docs/TEST-PLAN.md`. Thiago decided on 13 October who takes which path in the review.

- **Thiago** calls from his own phone, which is `DEMO_CALLER_PHONE`. So the recognised-caller paths are his to show.
- **The reviewers** call from their own phones, numbers nobody knows in advance. So every reviewer call goes through full verification as an unknown caller, with the fixture accounts in the README's "Call the assistant" section.

This replaces the T13 outline in `tasks/later.md`.

## Before each round of calls

1. `scripts/demo.sh reset`, so no account is a repeat caller or locked and no area is in outage.
2. The warm-up, `t10_smoke` then `t10_inspector` from Thiago's runbook. The README says what they send.
3. For the outage path, `scripts/demo.sh reports 8670 2`, one report short of the default threshold of 3.

## The calls

All the unknown-caller calls come from a second phone, never from `DEMO_CALLER_PHONE`.

| Who calls | Account | Path in `docs/WORKFLOW.md` | What it should show |
|---|---|---|---|
| Thiago | DV-100001, his own | C, number match | Greeting by name, postcode check, diagnostics find the line down, outage report |
| Thiago | DV-100001 | A, outage in his area, after `reports 8630 3` | Outage notice at the start, Outage help |
| Second phone | Lotte, DV-100004, 8620 | B, unknown caller, healthy line | Full verification, diagnostics find no fault |
| Second phone | Wout, DV-100005, 8660 | B, line fault | Full verification, diagnostics find a fault, repair ticket with a visit window |
| Second phone | Anke, DV-100006, 8670 | I, threshold crossing | Her report is the third, the incident is declared once, and the next caller in 8670 hears the outage notice |
| Second phone | Geert, DV-100007, 8600 | H, lockout, then the transfer | Three wrong postcodes lock the account, Handoff transfers the call to Thiago's mobile, and a second call is still locked |

Path D, the repeat caller, comes free on Thiago's third call within 24 hours. Run `reset` before review day so it does not.

## Evidence for each call

`docs/TEST-PLAN.md` gets one row per call, holding:

- the time window in UTC;
- the trace id, which is the call control id and survives in the logs (DEBUGLOG issue 17);
- the `dv` line;
- the MCP tool calls and their outcomes;
- the actor lines from `telnyx-edge actors logs <Type>`;
- what the call sounded like.

Claude Code reads the logs with read-only commands.

## Done when

Every row above has a passing call with evidence, or a bug entry in `DEBUGLOG.md` and a fix. Then a last `reset` and warm-up before the review.
