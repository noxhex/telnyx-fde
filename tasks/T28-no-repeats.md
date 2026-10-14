# T28. One name in the opening, no repeats, no pause after the outage notice

**Phase** 2 · **Depends on** T27 · **Code by** implementer agent

## Goal

Thiago's rehearsal on the afternoon of 14 October showed three problems in what callers hear. It also showed that one rule from T27 did not hold.

- The disclosure greets a known caller by name, and the opening question right after it used the name again.
- Speech recognition misheard the caller's first request as words about recording. The assistant repeated the recording notice and the opening question, and the caller had to say it again (DEBUGLOG issue 25).
- After the outage notice the line stayed silent until Telnyx's silence prompt, because a speak node hands the model no turn (DEBUGLOG issue 24).
- The model ignored T27's rule that each step uses only its own tools, and still ran the line check and the report from Verify (DEBUGLOG issue 23).

Thiago approved these changes the same day.

1. The opening question no longer uses the caller's name. The name comes once, in the greeting.
2. The assistant never repeats the recording notice or the opening question. Once the caller has said why they are calling, it acts on that, and asks only about a part that was unclear.
3. The outage notice ends with one follow-up question, so the assistant goes straight on. Outage help then offers to add the caller's report if their service is down completely, or to connect them with a person.
4. T27's tool-scope rule and Verify's line about moving on are removed. The outage rule moves into the base instructions, so it holds in whichever step the model works from.

All of it is workflow text. `docs/WORKFLOW.md` already holds the new text, and this card copies it into `assistant/`. It needs a provisioning run and no ship.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read nothing beyond this card and the files below. `git diff HEAD~1 -- docs/WORKFLOW.md` shows exactly what changed in the document.
- The tests in `assistant/test/flow.test.ts` compare the instruction files and the scripted lines with the document word for word. They fail now, and they pass once the copy is exact.
- Run `npx vitest run assistant` while you work, and `npm run check` once at the end.

## Files

- `assistant/instructions/base.md`, `verify.md`, `triage.md` and `outage-help.md`
- `assistant/flow.ts`, only the Outage notice's `message`

Change no other file. No test should need a change. If one does, stop and say why in your report.

## Changes

- Each instruction file equals its draft in the Instructions section of `docs/WORKFLOW.md`, without the heading and the code fence, as now.
- The Outage notice's `message` in `assistant/flow.ts` equals its line in the Scripted lines section. Keep the node's id, its name and its edges.
- No edge prompt changes.

## Tests

No new tests. The check ran 937 tests before this card, and it runs the same number after it.

## Acceptance

- [ ] `npm run check` passes with 937 tests.
- [ ] The diff touches only the files above.

## Out of scope

- Making the model move on from Verify, which is the next step after the review (README, Known issues).
- The tool descriptions in voice-tools, new nodes or edges, and any change to the variable contract.
