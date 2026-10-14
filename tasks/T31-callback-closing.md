# T31. A question after each booking, and a callback number

**Phase** 2 · **Depends on** T30 · **Code by** implementer agent

## Goal

Thiago's calls after T30 showed two gaps in what callers hear (DEBUGLOG issue 30, and the README's known issues).

- After Take message read back a callback ticket, the assistant asked nothing and waited in silence until the caller spoke. Repair ticket's instructions end the same way.
- A callback request from a caller whose number is unknown or withheld stores no number to call.

Thiago approved these changes on the evening of 14 October.

1. Take message and Repair ticket end by asking whether there is anything else the assistant can help with.
2. When the caller is not a known customer, Take message also asks for a number to call back, and the callback's summary carries it. The base instructions already give every step `Known customer {{caller_known}}`, so the step needs no new variable.

Both are instruction text, and `docs/WORKFLOW.md` already holds it. The card needs a provisioning run and no ship.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read nothing beyond this card and the two files below. `git diff HEAD~1 -- docs/WORKFLOW.md` shows exactly what changed in the document.
- The tests in `assistant/test/flow.test.ts` compare each instruction file with its draft in `docs/WORKFLOW.md` word for word. They fail now, and they pass once the copy is exact.
- Run `npx vitest run assistant` while you work, and `npm run check` once at the end.

## Files

- `assistant/instructions/take-message.md`
- `assistant/instructions/repair-ticket.md`

Change no other file. No test should need a change. If one does, stop and say why in your report.

## Changes

- Each of the two files equals its draft in the Instructions section of `docs/WORKFLOW.md`, under "Take message (append)" and "Repair ticket (append)", without the heading and the code fence, as the other instruction files are.

## Tests

No new test. The existing word-for-word tests cover both files. The check ran 947 tests before this card, and it runs 947 after it.

## Acceptance

- [ ] `npm run check` passes with 947 tests.
- [ ] The diff touches only the two files above.

## Out of scope

- Every other step's instructions, the base instructions and the scripted lines.
- Every node and edge, including Take message's one edge to End call.
- `create_ticket` and its arguments, and the variable contract.
