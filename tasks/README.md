# Task cards

Each card is a self-contained prompt for a coding agent. It names the goal, the files to touch, the interface, the behaviour and the checks that define done. Spikes (S1 to S4) prove platform assumptions before we build on them. Cards T01 to T10 are written in full. Cards T11 to T17 are outlines in [later.md](later.md), detailed once the spikes have answered their questions.

## The loop for one card

All code is written by Telnyx-hosted models through OpenCode, with the agents defined in `.opencode/agents/`. Check once with `opencode agent list` that `implementer`, `tester` and `reviewer` appear. If they don't, rename the folder to `.opencode/agent/`, since the OpenCode docs use both names. Start a server once per work session so each run skips the startup cost.

```bash
opencode serve --port 4096 &
OC="opencode run --attach http://localhost:4096"

CARD=tasks/T03-signature.md
$OC --agent tester      --title "T03 tests"  "$(cat $CARD)"
$OC --agent implementer --title "T03 impl"   "$(cat $CARD)"
npm run check
$OC --agent reviewer    --title "T03 review" "Review the current diff against $CARD"
git add -A && git commit -m "T03: Telnyx webhook signature verifier"
```

- **Retry.** If `npm run check` fails or the reviewer says CHANGES, continue the implementer's session with the output, using `$OC --session <id> --agent implementer "<failing output or findings>"`. `opencode session list` shows the ids.
- **Escalate after two failed attempts.** Bring the card, `git diff` and the error to Claude, then put the sharpened card or hint back through the implementer.
- **Log every card** as one line in `DOGFOODING.md` (model, attempts, what broke, what helped), and any real bug in `DEBUGLOG.md`.
- **Commit once per accepted card**, so the history reads card by card.

Spikes that need portal or API work by hand say so in their card. Those steps are yours, and the agents only write the code parts.

## Model bake-off on T03

T03 (the signature verifier) is small, security-critical and fully testable, which makes it a fair comparison.

1. For each candidate model, start from `main` on its own branch, for example `git switch -c bake/kimi-k3`.
2. Run the implementer on the whole card with the model overridden, for example `time $OC --agent implementer --model telnyx/moonshotai/Kimi-K3 "$(cat tasks/T03-signature.md)"`. The first line of the output shows the agent and model in use, so check it names the candidate. The card asks for tests too, so no tester run is needed here.
3. Record attempts to a passing `npm run check`, wall time and the token delta from `opencode stats --models`.
4. Run the reviewer on each branch's diff with one fixed model, and count blocking findings.
5. Candidates are Kimi-K3, GLM-5.3 and DeepSeek-V4-Flash-0731. Pick the implementer, tester and reviewer models from the results, update the three agent files, merge the best branch and fill in the bake-off table in `DOGFOODING.md`.

## Suggested schedule

This assumes the review on Wednesday 14 October. Shift it if the slot differs.

| Day | Work |
|---|---|
| Fri 9 Oct | S1 and S3 started, T01 |
| Sat 10 Oct | S2 and S4 (with your portal work), T02 to T04 including the bake-off |
| Sun 11 Oct | T05 to T07 |
| Mon 12 Oct | T08 to T10, then T11 and T12, first real calls |
| Tue 13 Oct | T13 path tests, T14 canary, T15 demo tooling, T17 README, rehearsal in the evening |
| Wed 14 Oct | Review. Stretch work (T16) only if Tuesday morning is clear |

## Status

| Card | Title | Depends on | Status |
|---|---|---|---|
| S1 | Latency and cold start | none | todo |
| S2 | Workflow routing on a tool node | none | todo |
| S3 | MCP transport in the edge runtime | none | todo |
| S4 | Per-call token round trip | S2, S3 | todo |
| T01 | Repo scaffold and workspace bundling | none | todo |
| T02 | Logging, timing and test fakes | T01 | todo |
| T03 | Telnyx webhook signature verifier (bake-off) | T01 | todo |
| T04 | Session tokens and Telnyx encryption | T01 | todo |
| T05 | mock-crm function | T02 | todo |
| T06 | CustomerAccount domain and actor | T02 | todo |
| T07 | AreaIncident domain and actor | T02 | todo |
| T08 | voice-context function | T03, T04, T05, T06, S1 | todo |
| T09 | voice-tools MCP server | T04, T06, T07, S3 | todo |
| T10 | Deploy and smoke-test all three functions | T08, T09 | todo |
| T11 | Assistant provisioning script | S2, S4, T10 | outline |
| T12 | Workflow content | T11 | outline |
| T13 | End-to-end path tests | T12 | outline |
| T14 | Canary actor and alert | T10 | outline |
| T15 | Demo tooling (flags, simulated reports) | T10 | outline |
| T16 | Stretch goals | T13 | outline |
| T17 | README and submission | T13, T14 | outline |
