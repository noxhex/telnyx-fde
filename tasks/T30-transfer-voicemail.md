# T30. The Handoff line and voicemail detection on the transfer

**Phase** 2 · **Depends on** T28 · **Code by** implementer agent

## Goal

T29 was rolled back on 14 October, because its opening failed on the first two calls (DEBUGLOG issue 29). Its transfer settings went back with it, untested. Thiago approved bringing back only two of its changes the same evening.

1. The Handoff line tells the caller that an engineer is being connected, that it may be quiet for a moment, that the call may be recorded, and that they can tell the engineer if they would rather it was not.
2. The transfer runs voicemail detection, so a transfer that reaches the engineer's voicemail stops and the caller comes back to the assistant. The engineer's acceptance is sent switched off, and there is no brief (ADR-021, the amendment for T30).

Change 1 is workflow text, and `docs/WORKFLOW.md` already holds it. Change 2 is the transfer tool's body in the provisioning script. The card needs a provisioning run and no ship.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read nothing beyond this card and the files below. `git diff HEAD~1 -- docs/WORKFLOW.md` shows exactly what changed in the document.
- The tests in `assistant/test/flow.test.ts` compare the scripted lines with the document word for word. One fails now, and it passes once the Handoff line is exact.
- Run `npx vitest run assistant scripts` while you work, and `npm run check` once at the end.

## Files

- `assistant/flow.ts`, only the `message` of Handoff
- `scripts/provision/desired.ts`, only the transfer tool's body in `sharedToolBodies` and that function's doc comment
- `scripts/test/provision-first-run.test.ts`, only the expected transfer body
- `scripts/test/provision-updates.test.ts`, two new tests

Change no other file. Every other node, edge and line stays as it is, the opening included. No other test should need a change. If one does, stop and say why in your report.

## Changes

- The `message` of Handoff in `assistant/flow.ts` equals its line in the Scripted lines section of `docs/WORKFLOW.md`. Keep the node's id, name and edges.
- The transfer tool's body becomes this one. `to` and `from` come from `input.transferTo` and `input.phoneNumber` as now, and the two new keys are exactly as written.

```json
{
  "display_name": "duinvezel-transfer",
  "type": "transfer",
  "timeout_ms": 5000,
  "transfer": {
    "targets": [{ "name": "Duinvezel support engineer", "to": "<input.transferTo>" }],
    "from": "<input.phoneNumber>",
    "voicemail_detection": {
      "detection_mode": "premium",
      "on_voicemail_detected": { "action": "stop_transfer" }
    },
    "warm_transfer_acceptance": { "enabled": false }
  }
}
```

- The doc comment of `sharedToolBodies` says in one or two sentences that the transfer stops at voicemail, and that acceptance is sent switched off rather than left out, because the script compares only the keys it sends (ADR-021, DEBUGLOG issue 29).
- `scripts/provision/compare.ts` needs no change.

## Tests

- In `provision-first-run.test.ts`, the expected transfer body is the one above.
- Two new tests in `provision-updates.test.ts`, in the style of the tests under "the state the T11 run left". Each starts with a first run, then sets the stored transfer tool's body to an earlier shape.
  1. T28's shape, with only `targets` and `from` in its `transfer` object.
  2. T29's shape, which adds three keys to T28's: `warm_transfer_instructions` with any short text, `warm_transfer_acceptance` as `{ "enabled": true }`, and `voicemail_detection` exactly as above.
- In both, a real run then prints `tool duinvezel-transfer (tool-0002-uuid): updated (transfer)`. It sends exactly one write, a PATCH to `/ai/tools/tool-0002-uuid` whose `transfer` object equals the one above, and it prints `unchanged` for every other resource. A run after that prints `unchanged` for every resource and sends only GET requests.

The check ran 937 tests before this card, and it runs 939 after it.

## Acceptance

- [ ] `npm run check` passes with 939 tests.
- [ ] The diff touches only the files above.

## Out of scope

- Every other node's text, the opening included, and every edge.
- `warm_transfer_instructions`, `require_acceptance`, `end_user_target_context_mode`, `warm_message_delay_ms` and `detection_config` (ADR-021).
- Any change to `compare.ts` or to the variable contract.
