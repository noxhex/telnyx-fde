# Path tests

The evidence for card T13. Each call has one row. Times are UTC. A trace id is the start of the call's call control id, which is enough to find its lines in the logs with `grep`. Account numbers are masked as in the logs.

- The `dv` line comes from `telnyx-edge logs voice-context --type runtime`, and the MCP calls from `telnyx-edge logs voice-tools --type runtime`.
- Actor lines come from `telnyx-edge actors logs <Type> --type runtime`.
- What the call sounded like comes from Thiago and from the transcript, read with `GET /v2/ai/conversations/{id}/messages`.

## Evening rehearsal, 14 October

T28 was live. Before the calls Thiago ran the steps in the README's "Before a demo".

- 15:11:45, `scripts/demo.sh reset` reset the eight accounts and five areas.
- 15:11:51, the health check failed its KV probe after 3,912 ms. The CRM lookup and both actors answered within 24 ms.
- 15:11:56, MCP Inspector's `verify_account` for DV-100002 came back verified.
- 15:12:28, `scripts/demo.sh reports 8670 2` put 8670 at 2 of 3.

| # | Call | Window | Trace id | `dv` | MCP calls | Actor lines | What it sounded like |
|---|---|---|---|---|---|---|---|
| 1 | Thiago's mobile, path C | 15:14:34 to 15:15:42 | `v3:-yEoElvacvaTG86my` | `number_match`, CRM cache miss, no outage, not a repeat caller, 2,000 ms | `verify_account` with the postcode, verified, 1,971 ms. `run_line_diagnostics`, line down, 983 ms. `report_outage`, counted, 642 ms | `recordCall` recorded, `verify` ok, report on 8630 counted as 1 of 3 | Greeting by name, then "How can I help you today?" without the name. Postcode only. The line had been down 63 minutes, and the report came after he said it was completely down. No count was said. Goodbye and hang-up. Every tool ran from Verify (README, Known issues) |
| 2 | Thiago's mobile, path A not reached | 15:16:08 to 15:16:20 | `v3:R5Xu3-j92TIH8IiPK` | `number_match`, no outage, not a repeat caller | none | `recordCall` recorded | The opening question, and then Thiago hung up. 8630 had only call 1's report, since the only simulated reports so far had gone to 8670 |
| 3 | Thiago's mobile, path A | 15:16:47 to 15:17:36 | `v3:PtoaPhPC3h51qS0ql` | `number_match`, CRM from memory, outage, repeat caller | none | `recordCall` recorded | Before it, at 15:16:37, `reports 8630 3` declared the incident with its second report, and its third answered 503 but landed (DEBUGLOG issue 26). This was his third mobile call since the reset, and the outage edge comes first. The notice came 0.7 s after the disclosure and ended with its question. Outage help offered his report or a person in one sentence. He only wanted an update, and it gave the ETA again |
| 4 | Browser, Lotte, path B | 15:18:05 to 15:19:10 | `v3:cxx_OuaZts_9ue6pd` | `anonymous`, no outage | `verify_account` with DV-100004 and 8620, verified, 2,372 ms. `run_line_diagnostics`, line fine, 1,121 ms | `verify` ok | Full verification, a clean line check and the advice to restart the fiber box |
| 5 | Browser, Wout, path B with a fault | 15:19:38 to 15:21:11 | `v3:dM7cpKXOP080dcYzT` | `anonymous`, no outage, 329 ms | `verify_account` with DV-100005 and 8660, verified, 2,485 ms. `run_line_diagnostics`, line degraded, 1,325 ms. `create_ticket`, repair visit, 285 ms | `verify` ok, `createTicket` created | A browser call at 15:19:34 ended before the disclosure, with a session and no conversation. Then full verification, a degraded line and a repair visit, ticket T-5905 for 15 October 08:00 to 12:00. The assistant said his afternoon preference was noted |
| 6 | Browser, Anke, path I | 15:21:23 to 15:22:38 | `v3:-syUNHEsH7o89hn8_` | `anonymous`, no outage | `verify_account` with DV-100006 and 8670, verified, 2,309 ms. `run_line_diagnostics`, line down, 991 ms. `report_outage`, incident declared, 419 ms | `verify` ok, report on 8670 declared as 3 of 3, publish of 8670 in 2,634 ms | Full verification, a line down for 69 minutes, a report she agreed to, and the incident declared with an ETA of 21:22 |
| 7 | Browser, Geert, path H | 15:23:01 to 15:25:07 | `v3:GYnkWkvVtr40w_1Ig` | `anonymous`, no outage | `verify_account` three times, wrong, wrong, then locked for 15 minutes | `verify` wrong three times | The lock, an offer of a person, and the Handoff line. The transfer rang Thiago's mobile, and its result read `Transfer completed` 16.4 s after the tool call. The caller heard silence while it rang (DEBUGLOG issue 28) |
| 8 | Browser, Geert again | 15:25:29 to 15:25:54 | `v3:C8uBfvQePGjeTaIcf` | `anonymous`, no outage | none | none | The caller asked for a person, and the Handoff line came straight away, before any verification (T27). The transfer completed after 5.4 s. The caller did not try to verify, so this call did not show the lock again |

## Still open after 14 October

- Path D, the repeat caller, was not run. Its transfer would ring the phone already on the call (DEBUGLOG issue 21).
- Path H's second call did not show the lock, because the caller asked for a person first.
- T29 changes the opening of every path and the transfer, so the calls after its provisioning and the final rehearsal on 15 October run the main paths again.
