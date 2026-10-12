# Task cards

Each card is a self-contained prompt for a coding agent. It names the goal, the files to touch, the interface, the behaviour and the checks that define done. Spikes (S1 to S4) prove platform assumptions before we build on them. Cards T01 to T12 and T18 to T20 are written in full. Cards T13 to T17 are outlines in [later.md](later.md), detailed once the spikes have answered their questions.

## The loop for one card

All code is written by Telnyx-hosted models through OpenCode, with the agents defined in `.opencode/agents/`. Claude Code orchestrates and reviews, following [CLAUDE.md](../CLAUDE.md). `tools/card.sh` runs one card from start to finish and keeps the evidence, so the loop is the same whether Claude Code drives it or you do.

```bash
tools/card.sh tasks/T05-mock-crm.md                                               # tester, implementer, check, reviewer
tools/card.sh tasks/T05-mock-crm.md --retry .runs/T05/feedback-1.md               # continue after feedback
tools/card.sh tasks/T03-signature.md --no-tester --model telnyx/zai-org/GLM-5.3   # one bake-off run
tools/card.sh tasks/S3-mcp-transport.md --no-tester --check "cd spikes/mcp-spike && npx tsc --noEmit"   # a spike with its own check
```

- **What it runs.** The tester writes tests from the card, the implementer implements it, the check runs (`npm run check`, or the command given with `--check` for spikes), and the reviewer reads the diff when the check passed. From T07 on, cards run with `--no-tester` and the implementer writes its own tests (ADR-018). `--review-only` runs just the check and the reviewer again, for example after a review that was cut off. It is recorded but is not an attempt. Each agent runs headless with `opencode run --auto`, and its deny rules still hold (commit, push, ship, secrets, files outside the repo). OpenCode is told to ignore `CLAUDE.md`, so the agents work from `AGENTS.md` and their card only.
- **What it keeps.** `.runs/<ID>/<timestamp>/` holds the prompts, each agent's final message, the raw events, OpenCode's session exports, `check.log`, `diff.patch` and `summary.json`, which records models, sessions, tokens, timings and the verdict. `.runs/<ID>/latest` points to the newest run, and `.runs/ledger.jsonl` gets one line per run. Git ignores `.runs/`, so discarding a failed attempt never loses its record. Accepting a card copies the ledger to `docs/agent-runs.jsonl`, which is committed.
- **Exit codes.** 0 approved, 1 check failed, 2 reviewer asked for changes, 3 setup problem and nothing ran, 4 an agent run failed, timed out or was cut off at the output limit, or the implementer changed nothing, and 129, 130 or 143 when the run was stopped. The summary also flags `head_moved` when an agent committed and `process_files_changed` when an agent touched the cards, the agent rules or the tooling.
- **Accept, retry, escalate.** Accepted cards are committed one per card, with trailers that name the models. A retry continues the implementer's session with written feedback. After three failed attempts the card comes to you with a proposal. The details are in `CLAUDE.md`.
- **Log every card** as one row per attempt in `DOGFOODING.md`, and any real bug in `DEBUGLOG.md`.

Spikes that need portal or API work by hand say so in their card. Those steps are yours, and the agents only write the code parts. S1 runs in the scratch project outside the repo, with the prompt in its card.

Before the first card, add the run folder to `.gitignore` once. `tools/card.sh` refuses to run until it is there.

```bash
printf '\n# Card runs from tools/card.sh\n.runs/\n' >> .gitignore
```

## Model bake-off on T03

T03 (the signature verifier) is small, security-critical and fully testable, which makes it a fair comparison.

1. For each candidate model, start from `main` on its own branch, for example `git switch -c bake/kimi-k3`.
2. Run `tools/card.sh tasks/T03-signature.md --no-tester --model <candidate>`. The card asks the implementer for tests too, so the tester does not run. `steps.implementer.models` in the summary confirms which model actually ran.
3. Retry until the check passes, giving every candidate the same kind of feedback, the failing check output and nothing else. Attempts, wall time and tokens come from the run summaries.
4. The reviewer keeps its own model on every branch. Count its blocking findings in `review.md`.
5. Commit each candidate on its branch. Candidates are Kimi-K3, GLM-5.3 and DeepSeek-V4-Flash-0731. Pick the implementer, tester and reviewer models from the results, update the three agent files, merge the best branch and fill in the bake-off table in `DOGFOODING.md`.

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
| S1 | Latency and cold start | none | done |
| S2 | Workflow routing on a tool node | none | done |
| S3 | MCP transport in the edge runtime | none | done |
| S4 | Per-call token round trip | S2, S3 | done |
| T01 | Repo scaffold and workspace bundling | none | done |
| T02 | Logging, timing and test fakes | T01 | done |
| T03 | Telnyx webhook signature verifier (bake-off) | T01 | done |
| T04 | Session tokens and Telnyx encryption | T01 | done |
| T05 | mock-crm function | T02 | done |
| T06 | CustomerAccount domain and actor | T02 | done |
| T07 | AreaIncident domain and actor | T02 | done |
| T18 | Session domain and actor | T02 | done |
| T08 | voice-context function | T03, T04, T05, T06, T18, S1 | done |
| T09 | voice-tools MCP server core | T04, T08, T18, S3, S4 | done |
| T19 | voice-tools MCP tools that change state | T06, T07, T09, T18 | done |
| T10 | Deploy and smoke-test all three functions | T08, T09, T19 | done |
| T12 | Workflow content | T19 | done |
| T11 | Assistant provisioning script | S2, S4, T10, T12 | in progress, script accepted, Thiago provisions and makes the first calls |
| T20 | Flags that refresh in the background, and mock-crm's first request | T10, T11 | written |
| T13 | End-to-end path tests | T12 | outline |
| T14 | Canary actor and alert | T10 | outline |
| T15 | Demo tooling (flags, simulated reports) | T10 | outline |
| T16 | Stretch goals | T13 | outline |
| T17 | README and submission | T13, T14 | outline |
