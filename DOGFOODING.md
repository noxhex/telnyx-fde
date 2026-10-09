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
| 9 Oct | T01 | implementer, reviewer | Kimi-K3, GLM-5.3 | 1 | Check passed. The reviewer approved, but its verdict came after a preamble, so `card.sh` called it unclear (exit 2). Implementer 4m33s, reviewer 3m06s | `telnyx-edge dev` could not start its Docker network (DEBUGLOG issue 6). The implementer worked around it with host networking instead of stopping. `@telnyx/edge-runtime` stayed at `"latest"`, and `npm run check` skipped the root config | The implementer created the three functions one at a time and reported the workaround under Deviations. The reviewer checked the staged bundles itself and listed every gap as a numbered finding |
| 9 Oct | T01 | implementer, reviewer | Kimi-K3, GLM-5.3 | 2 | Approved (exit 0). Implementer 1m51s in its continued session, reviewer 2m23s | The reviewer again wrote a preamble before its verdict, despite the sharper instruction. `verdict_of` found APPROVE on the ninth non-empty line | Numbered feedback with a file, a line and a done condition for each point. The implementer addressed all five points in seven changed lines, and proved the root typecheck with a deliberate type error that it then removed |
| 9 Oct | T03 | implementer, reviewer | Kimi-K3, GLM-5.3 | 1 | Bake-off. Check passed, implementer 1m22s. The reviewer was cut off and wrote nothing, so the run read as unclear (exit 2). A later `--review-only` run approved with no blocking findings | The reviewer's last step was 8,193 tokens of reasoning and no text (DEBUGLOG issue 7) | Strict timestamp parsing and a single try/catch. All 48 probe cases as intended, and its tests caught 13 of the 15 broken variants |
| 9 Oct | T03 | implementer, reviewer | GLM-5.3, GLM-5.3 | 1 | Bake-off. Failed, cut off before writing any code. The check passed on the unchanged tree and the reviewer asked for the missing files (exit 2). Implementer 2m06s | Its last step was 8,193 tokens of reasoning and no text. `card.sh` passed the empty change on as a passing check (DEBUGLOG issue 7) | |
| 9 Oct | T03 | implementer, reviewer | DeepSeek-V4-Flash-0731, GLM-5.3 | 1 | Bake-off. Approved (exit 0) with three non-blocking findings. Implementer 0m43s, reviewer 2m30s | Lenient `Number()` timestamp parsing accepts `0x…`, `+…`, ` …` and `….0`. One test name and comment get the skew direction wrong | The most tests (17), each with the exact reason. The reviewer's two main findings were exactly the two gaps the broken-variant run found |
| 9 Oct | T03 | implementer, reviewer | Kimi-K3, GLM-5.3 | 2 | Hardening after the bake-off, not a bake-off attempt. Approved (exit 0) with no findings. Implementer 1m35s in its continued session, reviewer 2m10s | Nothing | Three numbered points, each with a file, a line and a done condition. The tests then caught all 16 broken variants of the extended set |

## Model bake-off on T03

Same card, same starting commit (`b067ec1`), same reviewer (GLM-5.3), no tester, on 9 October. Wall time and tokens are the implementer's, from the run summaries. Blocking findings are counted separately for the OpenCode reviewer and for Claude Code.

| Model | Attempts to a passing check | Wall time | Tokens in and out | Blocking findings, reviewer / Claude Code | Probe, card / open cases | Broken variants caught, required / extra | Notes |
|---|---|---|---|---|---|---|---|
| Kimi-K3 | 1 | 1m22s | 15.2k in (+134k cached), 3.6k out (+5.1k reasoning) | 0 / 0 | 34 of 34 / 14 of 14 | 9 of 9 / 4 of 6 | Strictest code. Its first review was cut off, and the rerun with `--review-only` approved |
| GLM-5.3 | Failed, cut off before writing code | 2m06s | 48.8k in (+70k cached), 0.5k out (+8.4k reasoning) | 4 / none, no code | none | none | Stopped at its output cap of 8,192 tokens (DEBUGLOG issue 7). Not rerun under that cap, which the agent files lifted afterwards |
| DeepSeek-V4-Flash-0731 | 1 | 0m43s | 23.5k in (+298k cached), 6.1k out (no reasoning) | 0 / 0 | 34 of 34 / 9 of 14 | 9 of 9 / 2 of 6 | Fastest, and the most tests (17). Lenient timestamp parsing, one misnamed test |

**How Claude Code measured.** Besides `npm run check` and a reading of every diff, two checks ran the same way on each branch, in a scratch copy outside the repo. A probe fed 48 inputs to the verifier. The card decides the result for 34 of them, such as each check in its order, non-ASCII and 1 MB bodies, and a key that is not a curve point. It leaves 14 open, such as a timestamp in hex or one exactly 300 seconds old. Then each branch's own tests ran against a reference verifier with 15 broken variants, one fault each. The card's required tests should catch 9 of them, such as a missing freshness check or a message encoded as latin1. The other 6 go beyond the card, such as failing open when crypto throws or two checks in swapped order. Both working verifiers returned ok for a `nowMs` of `NaN`, which the card did not cover at the time.

**After the bake-off.** Kimi-K3's branch got its missing review from a `--review-only` run, which approved with no blocking findings, and one hardening retry. The card now makes a non-finite `nowMs` or `maxSkewSec` fail closed. The retry added that guard, a test that forces an exception inside verification, and a two-fault test for each pair of neighbouring checks. Its tests then caught all 16 variants of an extended set, and the verifier gave the intended result on all 54 cases of an extended probe. The ledger also holds a review-only run on `main` at 18:26 UTC, which reviewed an uncommitted `card.sh` change by mistake while the new option was tested. It is not part of the bake-off.

**Roles chosen.**

- **Implementer, Kimi-K3.** It passed on the first attempt with the strictest code, gave the intended result on all 48 probe cases including the 14 the card leaves open, and wrote the strongest tests. It also did T01.
- **Tester, DeepSeek-V4-Flash-0731.** It passed on the first attempt in 43 seconds and wrote the most tests, each asserting the exact reason. It comes from a different family than the implementer, so their mistakes are less likely to line up. Its tests missed boundaries and optional parameters, and the tester instructions now ask for both.
- **Reviewer, GLM-5.3.** When it finishes, its reviews are the most precise in the loop. On DeepSeek's branch it named exactly the two gaps the broken-variant run found. It does not write code, because as implementer it stopped at its output cap before writing anything. The agent files now lift that cap from 8,192 to 16,384 tokens (DEBUGLOG issue 7). A cut-off review gets one rerun with `--review-only`, and a second one on the same card goes to Thiago.

## Observations

What worked, what did not, and what made the models more reliable. Each observation names the card it came from.

- **9 Oct, harness test.** `opencode run` falls back to the default `build` agent, with only a warning, when the named agent is missing. `tools/card.sh` therefore checks `opencode agent list` before every run and fails a run that fell back.
- **9 Oct, T01.** GLM-5.3, as the reviewer, opened its final message with a summary before the verdict in both attempts, even after its instruction asked for a first line that holds only the verdict. `tools/card.sh` now takes the first verdict among the first ten non-empty lines, and `tools/card.sh --verdict <file>` shows what it reads. In attempt 2 the verdict was on the ninth non-empty line, so a slightly longer preamble would still read as unclear.
- **9 Oct, harness test.** `opencode run --auto` approves every permission that is not explicitly denied, and that includes `external_directory`, which defaults to ask. The agents deny it, which blocks reads, writes and `cd` outside the repo. A shell redirect such as `echo x > /tmp/f` still goes through, because the check looks at paths in commands, not at redirect targets. In the same way `git -c user.name=x commit` gets past a `git commit*` deny rule. The permission rules are guardrails, not a sandbox, so `tools/card.sh` flags a moved HEAD and changes to process files, and every diff gets read.
- **9 Oct, T03.** GLM-5.3 stopped at the output cap twice in one afternoon, as the reviewer and as the implementer, each time after about 8,192 tokens of reasoning in a single step and no text. OpenCode exits 0 when that happens, so `tools/card.sh` now checks the stop reason and the final message of every step, and fails an implementer run that changes nothing. A `max_tokens` option in the agent files lifts GLM-5.3's cap from 8,192 to 16,384 tokens per reply (DEBUGLOG issue 7).

## Cost

Token use per model from `opencode stats --models`, and inference spend from the portal's Inference dashboard, at the end of each day. Per run and per model, the ledger answers the same question.

```bash
jq -s '[.[] | .steps[] | {model: (.models | join(",")), input: (.tokens.input // 0), output: (.tokens.output // 0)}]
  | group_by(.model) | map({model: .[0].model, runs: length, input: (map(.input) | add), output: (map(.output) | add)})' docs/agent-runs.jsonl
```

The only cost outside Telnyx is Claude Code, which runs on Thiago's existing Claude subscription.

| Day | Tokens in | Tokens out | Spend |
|---|---|---|---|
