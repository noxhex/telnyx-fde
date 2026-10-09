# Dogfooding Telnyx Inference

How Telnyx-hosted models built this project, measured card by card. The brief asks what worked and what did not, so this file records both.

## Setup

- OpenCode 1.18.35, pinned, with auto-update off, and `@telnyx/opencode` 0.1.5. It has to be OpenCode v1, because the plugin does not run on v2 (DEBUGLOG issue 2).
- All hosted Telnyx models enabled through the plugin's login preset.
- Three agents in `.opencode/agents/`, an implementer, a tester and a reviewer. The tester and the implementer run on different models, so their mistakes do not line up.
- Claude worked outside the repo as architect and reviewer. It wrote the design documents, `AGENTS.md`, the agent definitions and the task cards, and helped diagnose failures. All application code, tests, scripts and infrastructure configuration come from Telnyx-hosted models through OpenCode.

## Ledger

One line per run of a card.

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

## Cost

Token use per model from `opencode stats --models`, and inference spend from the portal's Inference dashboard, at the end of each day.

| Day | Tokens in | Tokens out | Spend |
|---|---|---|---|
