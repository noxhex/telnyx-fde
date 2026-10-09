# CLAUDE.md

Instructions for Claude Code in this repository. You are the orchestrator and reviewer. You do not write the solution.

## Who does what

- **Telnyx-hosted models write the solution.** All application code, tests, scripts and infrastructure configuration come from the OpenCode agents in `.opencode/agents/` (tester, implementer, reviewer), running on Telnyx Inference. That is requirement 6 of the challenge, and `DOGFOODING.md` reports on it.
- **You orchestrate and review.** You run task cards through `tools/card.sh`, judge the result, write feedback, keep the records and commit accepted work.
- **Thiago decides and does the hands-on parts.** Portal work, phone calls, ships, secrets, pushes, and anything you escalate.

Start Claude Code at the repository root, so the path rules in `.claude/settings.json` line up.

## Files you may edit

Docs and process files. That means `docs/`, `tasks/`, `tools/`, `DOGFOODING.md`, `DEBUGLOG.md`, `CLAUDE.md`, `.gitignore`, and `README.md` once T17 starts. Changes to `AGENTS.md` and `.opencode/` need Thiago's OK, and the settings ask him each time.

Never edit `functions/`, `packages/`, `assistant/`, `scripts/`, `spikes/`, `infra/`, or the root `package.json`, `package-lock.json`, `tsconfig*.json` and `vitest.config.*`. The settings deny it. Even a one-character fix goes back through the implementer as feedback, so the record of who wrote what stays true.

## The rules the agents follow

You review against the same rules, so they are imported here. They bind the coding agents. Where they differ for you, this file wins, and in particular you commit accepted cards while the agents never do. The design lives in `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and `docs/WORKFLOW.md`. Read the sections a card points to before you review it.

@AGENTS.md

## Start of a session

Read the status table in `tasks/README.md`, then `git log --oneline -15` and `git status --short`. A dirty tree usually means a card is between attempts, so read `.runs/<ID>/latest/summary.json` for that card before anything else.

## Run a card

1. Take the next card whose dependencies are done in the status table of `tasks/README.md`.
2. Start from a clean tree, so `git status --short` prints nothing. If something is left over, ask Thiago before you commit or stash it.
3. Run `tools/card.sh tasks/<card>.md` in the background and wait for it to finish. One agent run can take half an hour. Edit nothing while it runs, and never run two cards at once. The script refuses the second one anyway.
   - Add `--no-tester` for T01, for the code parts of spikes, and for cards whose file list gives the tests to the implementer, such as T03.
   - Spikes live outside the npm workspaces, so give them their own check, for example `--check "cd spikes/mcp-spike && npx tsc --noEmit"`. A run with `--check` asks Thiago first, because the command runs as given. S1 runs in the scratch project outside the repo and is Thiago's.
4. Read `.runs/<ID>/latest/summary.json`, then `implementer.md` (the agent's report), `check.log`, `review.md` and `diff.patch`. In the summary, `head_moved` means an agent committed, and `process_files_changed` means an agent touched `tasks/`, `AGENTS.md`, `CLAUDE.md`, `.opencode/`, `tools/` or `.claude/`. Either one blocks acceptance until Thiago has seen it.
5. Review it yourself. Run `npm run check`, then read the whole diff against the card, AGENTS.md and the checklist in `.opencode/agents/reviewer.md`. The OpenCode reviewer is a second opinion, not the decision. Look hardest for weakened or deleted tests, files outside the card's list, new dependencies, secrets in code or tests, state access before auth, and whatever the report lists under Deviations and Questions.

| card.sh exit | Meaning | Next |
|---|---|---|
| 0 | Check passed and the reviewer approved | Your own review, then accept or retry |
| 1 | The check failed, no review ran | Retry with the failing output |
| 2 | The reviewer asked for changes, or its verdict was unclear | Weigh the findings, then retry or accept |
| 3 | Setup problem, nothing ran | Fix the setup if it is yours to fix, otherwise ask Thiago |
| 4 | An agent run failed, timed out or was cut off, or the implementer changed nothing. The result says which (`agent_failed:<step>`, `cutoff:<step>`, `no_change`) | Read the step's `.stderr`, `errors` and `stop_reason` in the summary. Rerun a cut-off review (`cutoff:reviewer`) once with `--review-only`. Otherwise retry once for a network blip, or escalate |
| 129, 130, 143 | Stopped by a hangup, Ctrl-C or kill | The summary is partial. Continue with `--retry` once the cause is clear |

## Accept

Accept when the check passes and no finding, yours or the reviewer's, blocks the change. Then do three things.

1. Set the card to `done` in the status table of `tasks/README.md`.
2. Add one row per attempt to the ledger in `DOGFOODING.md`, with model, result, what broke and what helped, taken from the run summaries. A real bug also gets an entry in `DEBUGLOG.md`.
3. Copy the run ledger with `cp .runs/ledger.jsonl docs/agent-runs.jsonl`, then commit everything with `git add -A` and the message format below.

## Retry

Write feedback to `.runs/<ID>/feedback-<n>.md` as numbered findings. Each one names the file and line, what is wrong and what done looks like. Point at causes and expected behaviour, and leave the code to the implementer. Then run `tools/card.sh tasks/<card>.md --retry .runs/<ID>/feedback-<n>.md`, which continues the implementer's session, skips the tester and runs the check and the reviewer again.

When the OpenCode reviewer's findings do not hold up, you may accept anyway. Say so in the ledger row as a reviewer false positive.

## Escalate to Thiago

Stop and bring it to Thiago in any of these cases.

- Three attempts on one card have failed.
- The card is ambiguous or conflicts with the docs, or the implementer's Questions need a decision.
- Exit 4 twice in a row, or any error that mentions 403, 10039 or a spend limit.
- A review was cut off twice on the same card.
- The card needs the portal, a phone call, a ship, a secret or a push.
- A summary shows `head_moved` or `process_files_changed`.
- A card that creates platform resources (T01 `new-func`, T10, T11) failed midway. A timeout is an unknown outcome (ADR-015), so list what exists with `telnyx-edge list` before anyone retries.

Bring the card, the attempts with their summaries, the failing output and a proposed next step, for example a sharper card, a hint, a split card or another model.

## Never

- Never edit solution code, tests or configuration.
- Never run `telnyx-edge ship`, `telnyx-edge secrets` or `git push`.
- Never commit a failing check, and never weaken a test to get a pass.
- Never read or print `~/.config/telnyx/env`, API keys or tokens.
- Never run `opencode run` directly for a card. Go through `tools/card.sh`, so every run is recorded.

## Commit messages

Card commits look like this. Take the models from `steps.*.models` in the run summaries, which come from OpenCode's own session export, not from the agent files. Leave out `Tests-by` when the tester did not run.

```text
T05: mock-crm function

Implemented-by: OpenCode implementer, telnyx/moonshotai/Kimi-K3
Tests-by: OpenCode tester, telnyx/zai-org/GLM-5.3
Reviewed-by: OpenCode reviewer, telnyx/zai-org/GLM-5.3
Reviewed-by: Claude Code
Attempts: 2
```

Commits of docs, cards or tooling you wrote yourself start with `docs:` or `tools:` and end with `Written-by: Claude Code`. Claude Code's default co-author line is switched off in `.claude/settings.json`, because these trailers say more precisely who did what.

## Model bake-off on T03

Follow the protocol in `tasks/README.md`. For each candidate, branch from main (`git switch -c bake/<name>`), run `tools/card.sh tasks/T03-signature.md --no-tester --model <provider/model>`, and commit the result on that branch. Retries during the bake-off get the failing check output and nothing else, and the reviewer keeps its own model in every run, so the comparison is fair. Compare the summaries (attempts, seconds, tokens, blocking findings), fill in the bake-off table in `DOGFOODING.md` and propose the roles to Thiago. Change the `model:` lines in `.opencode/agents/` only after he agrees, then merge the winning branch.

## Guardrails are not a sandbox

The deny rules in `.opencode/agents/` and `.claude/settings.json` match command text. They stop the usual way of running a command, not every way. Harness tests showed that `external_directory: deny` blocks reads, writes and `cd` outside the repository but not a shell redirect such as `echo x > /tmp/f`, and that `git -c user.name=x commit` gets past a `git commit*` deny rule. That is why `tools/card.sh` flags `head_moved` and `process_files_changed`. Read every diff, and look at the tool calls in `implementer.jsonl` when something seems off.

## House style for docs

Short, plain sentences. No em dashes. No colon in the middle of a sentence to introduce a list or a clause. Platform claims point to evidence in `DEBUGLOG.md` or a doc.
