# T25. What callers hear

**Phase** 2 · **Depends on** T24 · **Code by** implementer agent

## Goal

Thiago's two browser calls on the morning of 14 October showed four problems in what callers hear. The assistant waited in silence after the disclosure, called `verify_account` before it had the postcode and then said it had misheard it, logged an outage report after a healthy line check and told the caller how many reports an outage takes, and said goodbye without ending the call. Thiago approved these changes the same day.

1. After the disclosure, the assistant asks how it can help without waiting for the caller, by first name when the caller is known.
2. `verify_account` runs only once the caller has given every answer it needs, and a missing answer is asked for instead of being called misheard.
3. Once the caller is verified, the assistant uses their first name.
4. `report_outage` runs only when the caller says the service is down completely and agrees to report it. Never for slow or dropping internet. The assistant never says how many reports an outage needs.
5. The assistant never says goodbye itself. The edges into End call fire when the caller has nothing more to ask or wants to end the call, and End call says goodbye and hangs up.

All of it is workflow text. `docs/WORKFLOW.md` already holds the new text, and this card copies it into `assistant/`. It needs a provisioning run and no ship.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read nothing beyond this card and the files below. `git diff HEAD~1 -- docs/WORKFLOW.md` shows exactly what changed in the document.
- The tests in `assistant/test/flow.test.ts` compare the instruction files and the edge prompts with the document word for word. They fail now, and they pass once the copy is exact.
- Run `npx vitest run assistant` while you work, and `npm run check` once at the end.

## Files

- `assistant/instructions/base.md`, `verify.md`, `outage-help.md`, `triage.md`, `diagnose.md` and `degraded.md`
- `assistant/flow.ts`, only the LLM edge prompts that changed

Change no other file. No test should need a change. If one does, stop and say why in your report.

## Changes

- Each instruction file equals its draft in the Instructions section of `docs/WORKFLOW.md`, without the heading and the code fence, as now.
- Each changed LLM edge prompt in `edgeDefinitions` equals its sentence in the Edges section. Keep every id, the order and the targets. Six prompts change, the edges into End call from Verify account, Outage help, Triage, Diagnose, Repair ticket and Take message.

## Tests

No new tests. The check ran 930 tests before this card, and it runs the same number after it.

## Acceptance

- [ ] `npm run check` passes with 930 tests.
- [ ] The diff touches only the files above.

## Out of scope

- The tool descriptions in voice-tools, which stay on the later list (Thiago, 14 October).
- New nodes or edges, and any change to the variable contract.
