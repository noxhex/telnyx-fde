# T27. Transfer first, and each step keeps to its tools

**Phase** 2 · **Depends on** T25 · **Code by** implementer agent

## Goal

Thiago's check calls on the afternoon of 14 October showed three problems in what callers hear.

- After verification the model never moved on. It ran the line check, an outage report and a callback from Verify, so the rules of Diagnose and Take message were not in its prompt (DEBUGLOG issue 23).
- A caller who asked for an engineer and then for a live agent was offered a callback twice. The assistant created one the caller had not agreed to, and only then offered a person.
- The caller's preferred time went into a second `create_ticket` call. That call returned the first ticket unchanged, so the time never reached the ticket.

The assistant also read "117 minutes" digit by digit. Thiago approved these changes the same day.

1. Each step uses only the tools its instructions name, and Verify moves on as soon as the caller is verified.
2. When the caller asks to talk to a person, the assistant goes to Handoff straight away, even before verification. It offers a callback only if the transfer fails.
3. It creates a callback ticket only after the caller agrees to one.
4. It asks what time suits the caller before it creates a ticket, puts that time in the summary and creates the ticket once. It reads back the window from the result.
5. Only account numbers, postcodes and ticket numbers are read digit by digit.

All of it is workflow text. `docs/WORKFLOW.md` already holds the new text, and this card copies it into `assistant/`. It needs a provisioning run and no ship.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read nothing beyond this card and the files below. `git diff HEAD~1 -- docs/WORKFLOW.md` shows exactly what changed in the document.
- The tests in `assistant/test/flow.test.ts` compare the instruction files and the edge prompts with the document word for word. They fail now, and they pass once the copy is exact.
- Run `npx vitest run assistant` while you work, and `npm run check` once at the end.

## Files

- `assistant/instructions/base.md`, `verify.md`, `triage.md`, `repair-ticket.md` and `take-message.md`
- `assistant/flow.ts`, only the LLM edge prompts that changed

Change no other file. No test should need a change. If one does, stop and say why in your report.

## Changes

- Each instruction file equals its draft in the Instructions section of `docs/WORKFLOW.md`, without the heading and the code fence, as now.
- Each changed LLM edge prompt in `edgeDefinitions` equals its sentence in the Edges section. Keep every id, the order and the targets. Seven prompts change. They are the edges into Handoff from Verify account, Outage help, Triage, Diagnose and Repair ticket, Triage's edge into Diagnose, and Take message's edge into End call.

## Tests

No new tests. The check ran 937 tests before this card, and it runs the same number after it.

## Acceptance

- [ ] `npm run check` passes with 937 tests.
- [ ] The diff touches only the files above.

## Out of scope

- The tool descriptions in voice-tools, including `create_ticket`'s, because they need a ship.
- New nodes or edges, the Degraded node, and any change to the variable contract.
