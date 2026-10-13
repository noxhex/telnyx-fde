# T21. Fictional phone numbers in the tests

**Phase** 2 · **Depends on** T11, and runs last in the batch with the follow-ups from T11's first calls · **Code by** implementer agent

## Goal

Every Belgian phone number in the code and the tests follows the pattern of mock-crm's fixtures, `+325800` and four digits. Today the tests of shared, voice-context, voice-tools and the provisioning script also use numbers in Belgium's mobile and Brussels ranges, and two doc comments in shared use one as their example. Thiago decided on 13 October that they all become fictional numbers in the fixtures' pattern. Only tests and two comments change, so no function needs a ship for this card.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read nothing beyond this card to start with. The pattern is in the table below. mock-crm's accounts use `+3258000001` to `+3258000007`, and its tests' demo phone is `+3258009900`.
- Find the lines to change with the two searches under Acceptance, then search for each old number's masked form and its last four digits. Change those lines in place. You do not need to read whole test files.
- Run `npm run check` once at the end, and again only after a fix.

## Files

- `packages/shared/src/kv-keys.ts` and `packages/shared/src/mask.ts`, their doc comments only.
- `packages/shared/test/kv-keys.test.ts` and `packages/shared/test/mask.test.ts`.
- `functions/voice-context/test/dv.test.ts`, `functions/voice-context/test/container.test.ts` and `functions/voice-context/test/helpers/signed-request.ts`.
- In `functions/voice-tools/test/`, `auth.test.ts`, `container.test.ts`, `internal-sessions.test.ts`, `mcp-protocol.test.ts`, `session.test.ts`, `tools-read.test.ts` and `tools-write.test.ts`.
- `scripts/test/fake-api.ts`, `scripts/test/compare.test.ts` and `scripts/test/provision-safety.test.ts`.
- Any other test that a card earlier in the same batch added with one of the numbers below. Name it in your report.

Change no other file. Leave mock-crm and `tasks/` alone. Claude Code updates the examples in `tasks/T02-shared-logging.md` in the same commit once it accepts this card.

## The numbers

Replace each number one for one, in every form it takes. The forms are E.164 with the plus, digits only, digits with spaces or hyphens, a KV key such as `crm/phone/<digits>`, and the masked form from `maskPhone`, which keeps the plus, the first two digits and the last four.

| Where | What the number is | New number |
|---|---|---|
| shared, voice-context and voice-tools tests, and the two doc comments in shared | The example caller. It is the number in the first case of `mask.test.ts`, the caller in `signed-request.ts` and `dv.test.ts`, and the caller of the voice-tools sessions | `+3258000110` |
| `functions/voice-tools/test/session.test.ts` | The other session's caller, next to `DV-999999` | `+3258000111` |
| `functions/voice-context/test/helpers/signed-request.ts` | The assistant's own number, `telnyx_agent_target` | `+3258000120` |
| `scripts/test/fake-api.ts` and `scripts/test/compare.test.ts` | The fake `TRANSFER_TO` | `+3258000130` |
| `scripts/test/provision-safety.test.ts` | `pn-other-1`, another number on the account | `+3258000131` |
| `scripts/test/provision-safety.test.ts` | The malformed `TRANSFER_TO` cases "no plus" and "spaces" | `3258000132` and `+32 58 00 01 32` |
| `functions/voice-context/test/dv.test.ts` | The two short callers at T22's eight-digit boundary, seven and eight digits long, and the lookup and cache key of the longer one | `+3258000` and `+32580001` |

So the example caller masks to `+32…0110`, and its cache key is `crm/phone/3258000110`.

Places that held the same number still hold the same number afterwards, and places that held different numbers still differ. Every assertion keeps its meaning. Do not delete, skip or loosen a test.

## Tests

No new tests. The check ran 920 tests before this card, and it runs the same number after it.

## Acceptance

- [ ] `npm run check` passes, with the same number of tests as before this card.
- [ ] Outside mock-crm, each of these two searches finds only numbers that read `325800` and four digits once spaces and hyphens are removed, besides the short and lettered inputs of the masking and E.164 tests and the two short callers in `dv.test.ts`. Your report lists every hit outside mock-crm that is not in the pattern.
  - `git grep -nE '\+32[ -]?[0-9]' -- ':!tasks' ':!*.md'`
  - `git grep -nE '(^|[^0-9A-Za-z+])32[0-9]{8,9}([^0-9A-Za-z]|$)' -- ':!tasks' ':!*.md'`
- [ ] Claude Code's review finds none of the replaced numbers in any tracked file, in any form, once the T02 card is updated.

## Out of scope

- mock-crm, whose fixtures and tests already follow the pattern.
- Numbers of other countries in the masking and provisioning tests.
- Any change in behaviour. In `packages/shared/src/` only the doc comments change.
