# Dogfooding Telnyx Inference

How Telnyx-hosted models built this project, measured card by card. The brief asks what worked and what did not, so this file records both.

## Setup

- OpenCode 1.18.35, pinned, with auto-update off, and `@telnyx/opencode` 0.1.5. It has to be OpenCode v1, because the plugin does not run on v2 (DEBUGLOG issue 2).
- All hosted Telnyx models enabled through the plugin's login preset.
- Three agents in `.opencode/agents/`, an implementer, a tester and a reviewer. The tester and the implementer run on different models, so their mistakes do not line up.
- Claude Code, on Thiago's Claude subscription, is the orchestrator and an independent reviewer (ADR-018). Claude wrote the design documents, `AGENTS.md`, `CLAUDE.md`, the agent definitions, the task cards and `tools/card.sh`. In the loop it runs each card through the OpenCode agents, reviews the result and writes the feedback, and `.claude/settings.json` denies it edits to solution code. All application code, tests, scripts and infrastructure configuration come from Telnyx-hosted models through OpenCode.
- `tools/card.sh` records every agent run with its session id, the models that actually answered and the token counts, all taken from OpenCode's own session export. The full record is `docs/agent-runs.jsonl`, one line per run, failed runs included.

## Ledger

One row per attempt at a card, filled in from the run summaries when a card is accepted. `docs/agent-runs.jsonl` has the machine-readable version.

| Date | Card | Agent | Model | Attempts | Result | What broke | What helped |
|---|---|---|---|---|---|---|---|
| 9 Oct | setup | build | Kimi-K3 | 1 | Answered a one-line prompt | | |
| 9 Oct | setup | build | GLM-5.3 | 1 | Chained four tool calls and summarised the repo correctly, including the untracked plugin install | | |

## Model bake-off on T03

Same card, same starting commit, same reviewer.

| Model | Attempts to a passing check | Wall time | Tokens in and out | Blocking review findings | Notes |
|---|---|---|---|---|---|
| Kimi-K3 | | | | | |
| GLM-5.3 | | | | | |
| DeepSeek-V4-Flash-0731 | | | | | |

**Roles chosen.** Filled in after the bake-off, with the reason for each.

## Observations

What worked, what did not, and what made the models more reliable. Each observation names the card it came from.

- **9 Oct, harness test.** `opencode run` falls back to the default `build` agent, with only a warning, when the named agent is missing. `tools/card.sh` therefore checks `opencode agent list` before every run and fails a run that fell back.
- **9 Oct, harness test.** `opencode run --auto` approves every permission that is not explicitly denied, and that includes `external_directory`, which defaults to ask. The agents deny it, which blocks reads, writes and `cd` outside the repo. A shell redirect such as `echo x > /tmp/f` still goes through, because the check looks at paths in commands, not at redirect targets. In the same way `git -c user.name=x commit` gets past a `git commit*` deny rule. The permission rules are guardrails, not a sandbox, so `tools/card.sh` flags a moved HEAD and changes to process files, and every diff gets read.

## Cost

Token use per model from `opencode stats --models`, and inference spend from the portal's Inference dashboard, at the end of each day. Per run and per model, the ledger answers the same question.

```bash
jq -s '[.[] | .steps[] | {model: (.models | join(",")), input: (.tokens.input // 0), output: (.tokens.output // 0)}]
  | group_by(.model) | map({model: .[0].model, runs: length, input: (map(.input) | add), output: (map(.output) | add)})' docs/agent-runs.jsonl
```

The only cost outside Telnyx is Claude Code, which runs on Thiago's existing Claude subscription.

| Day | Tokens in | Tokens out | Spend |
|---|---|---|---|
