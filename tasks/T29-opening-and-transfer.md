# T29. The opening question in the disclosure, and a warm transfer

**Phase** 2 · **Depends on** T28 · **Code by** implementer agent

## Goal

Thiago's rehearsal on the evening of 14 October went through every path, and it showed two problems in what callers hear.

- The opening question came 0.5 to 1.4 s after the disclosure, as the model's first reply in Verify. That pause is long enough that callers start to talk (DEBUGLOG issue 27).
- While a transfer rang the engineer's phone, the caller heard silence. A transfer that reached the engineer's voicemail would have left the caller there (DEBUGLOG issue 28).

Thiago approved these changes the same day.

1. The disclosure line ends with "How can I help you today?", for known and unknown callers. Verify and Triage no longer ask it, and the model waits for the caller's answer.
2. The Handoff line tells the caller that an engineer is being connected and they will hear ringing, that the call may be recorded, and that they can tell the engineer if they would rather it was not.
3. The transfer is a warm transfer. The assistant briefs the engineer and asks whether they take the call, while the caller hears ringback. A transfer that reaches voicemail stops and comes back to the assistant (ADR-021).

Changes 1 and 2 are workflow text, and `docs/WORKFLOW.md` already holds them. Change 3 is the transfer tool's body in the provisioning script. The card needs a provisioning run and no ship.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read nothing beyond this card and the files below. `git diff HEAD~1 -- docs/WORKFLOW.md` shows exactly what changed in the document.
- The tests in `assistant/test/flow.test.ts` compare the instruction files and the scripted lines with the document word for word. They fail now, and they pass once the copy is exact.
- Run `npx vitest run assistant scripts` while you work, and `npm run check` once at the end.

## Files

- `assistant/instructions/verify.md` and `triage.md`
- `assistant/flow.ts`, only the `message` of Disclosure and of Handoff
- `scripts/provision/desired.ts`, only the transfer tool's body in `sharedToolBodies` and that function's doc comment
- `scripts/test/provision-first-run.test.ts`, only the expected transfer body
- `scripts/test/provision-updates.test.ts`, one new test

Change no other file. No other test should need a change. If one does, stop and say why in your report.

## Changes

- Each instruction file equals its draft in the Instructions section of `docs/WORKFLOW.md`, without the heading and the code fence, as now.
- The `message` of Disclosure and of Handoff in `assistant/flow.ts` equals its line in the Scripted lines section. Keep each node's id, name and edges.
- The transfer tool's body becomes this one. `to` and `from` come from `input.transferTo` and `input.phoneNumber` as now, and the three new keys are exactly as written.

```json
{
  "display_name": "duinvezel-transfer",
  "type": "transfer",
  "timeout_ms": 5000,
  "transfer": {
    "targets": [{ "name": "Duinvezel support engineer", "to": "<input.transferTo>" }],
    "from": "<input.phoneNumber>",
    "warm_transfer_instructions": "Tell the engineer in one or two short sentences what the customer needs and what has been done on this call, such as verification, a line check or a ticket. Give the customer's first name only if they were verified, and never read out a full account number. Then ask whether they can take the call now.",
    "warm_transfer_acceptance": { "enabled": true },
    "voicemail_detection": {
      "detection_mode": "premium",
      "on_voicemail_detected": { "action": "stop_transfer" }
    }
  }
}
```

- The doc comment of `sharedToolBodies` says in one or two sentences that the transfer is warm, waits for the engineer's acceptance and stops at voicemail (ADR-021).
- `scripts/provision/compare.ts` needs no change. It compares every key the script sends with the API's `tool_definition`, so a transfer tool read back without the new keys already counts as changed.

## Tests

- In `provision-first-run.test.ts`, the expected transfer body is the one above.
- One new test in `provision-updates.test.ts`, in the style of the tests under "the state the T11 run left". After a first run, set the stored transfer tool's body back to the shape the runs before T29 left, with only `targets` and `from` in its `transfer` object. A real run then prints `tool duinvezel-transfer (tool-0002-uuid): updated (transfer)`, sends exactly one write, a PATCH to `/ai/tools/tool-0002-uuid` whose `transfer` object equals the one above, and prints `unchanged` for every other resource. A run after that prints `unchanged` for every resource and sends only GET requests.

The check ran 937 tests before this card, and it runs 938 after it.

## Acceptance

- [ ] `npm run check` passes with 938 tests.
- [ ] The diff touches only the files above.

## Out of scope

- The outage notice, the Degraded instructions and every other node's text.
- `require_acceptance`, `end_user_target_context_mode`, `warm_message_delay_ms` and `detection_config`, which keep their defaults (ADR-021).
- New nodes or edges, and any change to the variable contract.
