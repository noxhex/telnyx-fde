# T23. The disclosure line once, and the disclosure tool's session id

**Phase** 2 · **Depends on** T11 · **Code by** implementer agent

## Goal

Calls hear the disclosure line once, and the Route call tool node reports the call's session id. Both come from the first calls on 13 October.

- **The line played twice on every call** (DEBUGLOG issue 18). T11 sets the assistant's `greeting` to the Disclosure line. In S2 a speak start node replaced the greeting, but these calls most likely played both.
- **`/tools/disclosure` answered `invalid_sid` on every call** (issue 19). The tool node's model fills `session_id`, and since Thiago's decision of 12 October nothing it can see carries that value.

Telnyx's preset webhook parameters fix the second. They are filled from the dynamic variables and kept out of the model's view (https://developers.telnyx.com/docs/inference/ai-assistants/preset-webhook-parameters).

## Read first

- `DEBUGLOG.md`, issues 18 and 19, and the S2 findings.
- `tasks/T11-provisioning.md`, for the shapes and the comparison rules.
- `docs/WORKFLOW.md`, Principles and Nodes.
- `scripts/provision/desired.ts`, `compare.ts`, `schemas.ts` and their tests in `scripts/test/`.
- The Telnyx page linked above.
- `AGENTS.md`.

## Files

`scripts/provision/desired.ts`, and `compare.ts` and `schemas.ts` where the comparison needs it, with their tests in `scripts/test/`. No new dependency. voice-context already reads `session_id` from the request body, so it does not change.

## 1. The greeting

- **What is sent.** The assistant's managed body sends `greeting` as the empty string, on create and on update.
- **What counts as equal.** A read-back of `""`, `null` or no `greeting` at all counts as equal. Any other text is a difference.

## 2. The disclosure tool

- **The preset.** `duinvezel-log-disclosure` gets `preset_body_fields` `{ "session_id": "{{session_id}}" }`.
- **The schema.** Its `body_parameters` becomes an object schema with no properties, so the model fills nothing.
- **Unchanged.** Everything else stays: the name `log_disclosure`, the description, the URL, the `POST` method and `timeout_ms` 5,000. Preset body fields are dropped on `GET` tools.
- **The comparison.** It treats `preset_body_fields` as a managed field of that tool and compares it like the others.

## Tests

- **The greeting.** The assistant body's `greeting` is `""`. A read-back of `""`, `null` or none is unchanged. A read-back of the old Disclosure line gives `would update (greeting)`.
- **The tool body.** The disclosure tool's body carries the preset and a `body_parameters` without properties.
- **The tool comparison.** A read-back in the old shape, with `session_id` in `body_parameters` and no preset, gives an update. A read-back in the new shape is unchanged.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Thiago runs `node scripts/provision.ts --dry-run`, then for real, then once more.
  - The real run updates the assistant's greeting and the disclosure tool.
  - The third run prints `unchanged` for every resource. That also closes T11's acceptance.
- [ ] **The calls.** A browser test call and a phone call each hear the disclosure line once. Route call reaches `/tools/disclosure` about 8 s sooner than on 13 October. voice-context logs the disclosure with `logged: true`.

## Out of scope

- The workflow's nodes and instructions (T12).
- voice-context.
