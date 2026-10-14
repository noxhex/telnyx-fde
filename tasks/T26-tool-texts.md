# T26. What the voice-tools tools tell the model

**Phase** 2 · **Depends on** T24, T25 · **Code by** implementer agent

## Goal

Three items from the later list that a reviewer could hit, all in voice-tools. Thiago asked for them on 14 October, once T25 had changed the workflow's text. They need one voice-tools ship.

1. **`report_outage` pulls against the workflow.** Its description tells the model to report "whenever a recognised caller says their connection has a problem", and its answer carries `reports_in_window` and `threshold`. On 14 October the assistant logged a report after a healthy line check, and told the caller that an outage takes three reports. Since T25 the workflow allows a report only when the caller says the service is down completely and agrees to report it.
2. **`verify_account` calls a missing postcode misheard.** On 14 October the model called it before the caller had given a postcode, got `postcode_unclear` back, and told the caller it had misheard a postcode it never asked for. The description says an unclear value "was probably misheard".
3. **A fresh replica answers an MCP request 503.** The MCP auth gives the token key read 1,000 ms. On 14 October a fresh replica's read took longer (DEBUGLOG issue 20). T24 raised voice-context's bound to 2,000 ms.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read `functions/voice-tools/src/mcp/tools/report-outage.ts`, `functions/voice-tools/src/mcp/tools/verify-account.ts` and `functions/voice-tools/src/config.ts`, and in `functions/voice-tools/src/actors/area-incident.ts` only `report` and `_logCall`.
- Find the tests to change by searching `functions/voice-tools/test/` for `reports_in_window`, `postcode_unclear`, `SECRET_READ_TIMEOUT_MS`, `secret_error` and `"counted"`. You do not need to read whole test files.
- Plan briefly. Run `npx vitest run functions/voice-tools` while you work, and `npm run check` once at the end.
- Do not run `telnyx-edge dev`.

## Files

- `functions/voice-tools/src/mcp/tools/report-outage.ts`
- `functions/voice-tools/src/mcp/tools/verify-account.ts`
- `functions/voice-tools/src/actors/area-incident.ts`
- `functions/voice-tools/src/config.ts`
- The voice-tools tests that pin what changes

Change no other file.

## Changes

1. **`report_outage`'s description** becomes exactly this text.

   > Reports that the caller's own internet is down completely, so the engineers can see that their area is affected. Use it only when the caller says their service is down completely and has agreed to report it as an outage. Never use it for slow or dropping internet. It answers whether the report was counted, whether it declared an incident, and the estimated fix time. Only a caller recognised by phone number or verified can report. If the result says needs_verification, verify the caller first.

2. **`report_outage`'s answer** drops `reports_in_window` and `threshold`, and keeps `counted`, `incident_declared`, `incident_id` and `eta`. The `AreaIncident` actor's `report` log line gains `reports_in_window` and `threshold` from the domain result, so the logs still show the count for the demo and for T13's evidence. Its error line stays as it is. The input schema does not change.
3. **`verify_account`'s description** becomes exactly this text.

   > Verifies the caller's identity before anything that touches their account, such as diagnostics or a repair ticket. Call it only once the caller has given every answer it needs. That is the four-digit postcode, and the account number as well when the caller was not recognised by phone number. If an answer is missing, ask the caller for it first. It answers whether the caller is verified, how many attempts remain, or how many minutes verification is locked after too many wrong answers. If it answers account_number_needed or postcode_needed, ask for that answer and try again. If it answers account_number_unclear or postcode_unclear, ask the caller to repeat that answer one character at a time and try again. Never read out full account details yourself.

4. **An empty postcode is needed, not unclear.** A `postcode` that is empty or only whitespace answers `{ "verified": false, "postcode_needed": true }`, the way a missing account number answers `account_number_needed`. Nothing is called. It counts nothing toward the lockout, the same as `postcode_unclear` (Thiago, 14 October). Any other value that does not clean still answers `postcode_unclear`. The order of the checks stays the same, so a session lock and the account number come first.
5. **Secret reads wait up to 2,000 ms.** `SECRET_READ_TIMEOUT_MS` goes from 1,000 to 2,000 ms. That covers the MCP auth's token key read and the internal key reads, as T24 did in voice-context.
6. **Comments.** Update the doc comments that describe what changed, such as the flow in `verify-account.ts`'s header and the bound in `config.ts`.

## Tests

Follow the rules in AGENTS.md.

- `report_outage`'s answer has exactly `counted`, `incident_declared`, `incident_id` and `eta`. The assertions that pinned the two removed fields change on purpose. Name each one in your report.
- The actor's `report` line carries `reports_in_window` and `threshold` for a counted, a declared and a duplicate report.
- `verify_account` answers `postcode_needed` for `""` and for `"   "`, with no CRM call and no actor call. Three of them in a row leave the session and the account unlocked, with no failure counted. It still answers `postcode_unclear` for `"86"` and `"abcd"`.
- `tools/list` shows each new description word for word.
- A token key read that settles at the 2,000 ms bound authenticates. One still pending at the bound answers 503 `secret_error`, and its late settlement changes nothing.
- Do not delete, skip or loosen any other test. Name every changed test in your report.

## Acceptance

- [ ] `npm run check` passes, and the test count grows by the new tests only.
- [ ] Claude Code's review breaks the change on purpose and a test fails each time. The mutations are the counts back in the answer, the counts missing from the log line, an empty postcode answering `postcode_unclear`, an empty postcode counted as a failure, a 1,000 ms secret bound, and either old description.

## Out of scope

- The input schemas, including `report_outage`'s symptom list.
- voice-context, mock-crm and the workflow.
