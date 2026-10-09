#!/usr/bin/env bash
# Runs one task card through the OpenCode agents and keeps the evidence.
#
#   tools/card.sh tasks/T05-mock-crm.md
#   tools/card.sh tasks/T03-signature.md --no-tester --model telnyx/zai-org/GLM-5.3
#   tools/card.sh tasks/T05-mock-crm.md --retry .runs/T05/feedback-1.md
#   tools/card.sh tasks/S3-mcp-transport.md --no-tester --check "cd spikes/mcp-spike && npx tsc --noEmit"
#
# Steps. The tester writes tests from the card (skipped with --no-tester and on retries).
# The implementer implements the card. On a retry it continues its session from the last
# run of this card on this branch, with the feedback. Then the check, `npm run check` unless
# --check names another command (spikes). Then the reviewer reads the change, only if the
# check passed.
#
# Output goes to .runs/<card id>/<timestamp>/, with summary.json, each agent's final message,
# raw events, session exports, check.log and diff.patch. .runs/<card id>/latest points to
# the newest finished run. One line per run is appended to .runs/ledger.jsonl. Git ignores
# .runs/, so a reset never loses a run. Accepting a card copies the ledger to
# docs/agent-runs.jsonl.
#
# Exit codes
#   0  check passed and the reviewer approved
#   1  the check failed, no review
#   2  the reviewer asked for changes, or its verdict was unclear
#   3  usage or setup problem, nothing ran
#   4  an agent run failed or timed out (model, network, spend limit)
#   129, 130, 143  stopped by a hangup, Ctrl-C or kill, with a partial summary
#
# Environment
#   CARD_STEP_TIMEOUT   time limit per agent run, default 45m
#   CARD_CHECK_TIMEOUT  time limit for the check, default 15m
#   OPENCODE_BIN        opencode binary, default opencode

# Backticks in the prompt texts are literal markdown, not command substitution.
# shellcheck disable=SC2016
set -uo pipefail

die() {
  local code=$1
  shift
  printf 'card.sh: %s\n' "$*" >&2
  exit "$code"
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  exit "$1"
}

# ---------------------------------------------------------------- arguments

CARD="" NO_TESTER=0 MODEL="" FEEDBACK="" CHECK_CMD=""
while (($#)); do
  case $1 in
    --no-tester) NO_TESTER=1 ;;
    --model)
      (($# >= 2)) || die 3 "--model needs a value like telnyx/zai-org/GLM-5.3"
      MODEL=$2
      shift
      ;;
    --retry)
      (($# >= 2)) || die 3 "--retry needs a feedback file"
      FEEDBACK=$2
      shift
      ;;
    --check)
      (($# >= 2)) || die 3 "--check needs a command"
      CHECK_CMD=$2
      shift
      ;;
    -h | --help) usage 0 ;;
    -*) die 3 "unknown option $1" ;;
    *)
      [[ -z $CARD ]] || die 3 "one card per run"
      CARD=$1
      ;;
  esac
  shift
done
[[ -n $CARD ]] || usage 3
[[ -f $CARD ]] || die 3 "card not found: $CARD"
[[ -z $FEEDBACK || -f $FEEDBACK ]] || die 3 "feedback file not found: $FEEDBACK"

CARD_ABS=$(realpath "$CARD")
FEEDBACK_ABS=""
[[ -z $FEEDBACK ]] || FEEDBACK_ABS=$(realpath "$FEEDBACK")

ROOT=$(git -C "$(dirname "$CARD_ABS")" rev-parse --show-toplevel 2>/dev/null) || die 3 "the card is not inside a git repository"
cd "$ROOT" || die 3 "cannot cd to $ROOT"
CARD_REL=$(realpath --relative-to="$ROOT" "$CARD_ABS")
CARD_BASE=$(basename "$CARD_REL" .md)
ID=${CARD_BASE%%-*}
[[ $ID =~ ^[A-Z][0-9]+$ ]] || die 3 "card file names start with an id like T05-, got $CARD_BASE"

# ---------------------------------------------------------------- setup checks

OC=${OPENCODE_BIN:-opencode}
STEP_TIMEOUT=${CARD_STEP_TIMEOUT:-45m}
CHECK_TIMEOUT=${CARD_CHECK_TIMEOUT:-15m}
DURATION_RE='^[0-9]+[smhd]?$'
[[ $STEP_TIMEOUT =~ $DURATION_RE ]] || die 3 "CARD_STEP_TIMEOUT must look like 45m, got $STEP_TIMEOUT"
[[ $CHECK_TIMEOUT =~ $DURATION_RE ]] || die 3 "CARD_CHECK_TIMEOUT must look like 15m, got $CHECK_TIMEOUT"

command -v "$OC" >/dev/null || die 3 "opencode not found on PATH"
command -v jq >/dev/null || die 3 "jq not found (sudo pacman -S jq)"
command -v npm >/dev/null || die 3 "npm not found"
command -v timeout >/dev/null || die 3 "timeout not found (coreutils)"

# The agents follow AGENTS.md and their card only. CLAUDE.md and anything under .claude/ is
# for the orchestrator, so OpenCode must not load it.
export OPENCODE_DISABLE_AUTOUPDATE=true
export OPENCODE_DISABLE_CLAUDE_CODE=true
export OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=true
export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true

# Short opencode calls get a time limit too, so a stuck database cannot hang the script.
oc_quick() { timeout -k 10s 120s "$OC" "$@" </dev/null; }

OC_VERSION=$(oc_quick --version 2>/dev/null | tail -n 1)
[[ $OC_VERSION == 1.* ]] || die 3 "OpenCode ${OC_VERSION:-unknown} found. The Telnyx plugin needs OpenCode v1 (DEBUGLOG issue 2)"

mkdir -p .runs
git check-ignore -q .runs/ledger.jsonl || die 3 ".runs/ is not ignored by git. Add the line .runs/ to .gitignore first"
if command -v flock >/dev/null; then
  exec 9>.runs/.lock
  flock -n 9 || die 3 "another card run is in progress in this repository"
fi

AGENT_LIST=$(oc_quick agent list 2>&1) || die 3 "opencode agent list failed: $AGENT_LIST"
for a in implementer tester reviewer; do
  grep -q "^$a (primary)" <<<"$AGENT_LIST" || die 3 "agent $a not found as a primary agent, check .opencode/agents/"
done

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || die 3 "the repository has no commit yet"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo none)

# A fresh card starts from a clean tree, so the diff is exactly this card's work.
if [[ -z $FEEDBACK ]]; then
  DIRTY=$(git status --porcelain -- . ':(exclude).runs')
  [[ -z $DIRTY ]] || die 3 "the working tree is not clean. Commit or stash first, or continue the last attempt with --retry <feedback file>"
fi

# A retry continues from the newest finished run of this card on this branch. Runs on other
# branches (the bake-off) are skipped.
ATTEMPT=1 PREV_RUN="" IMPL_SESSION=""
if [[ -n $FEEDBACK ]]; then
  PREV_DIR=""
  shopt -s nullglob
  RUN_DIRS=(".runs/$ID"/2*/)
  shopt -u nullglob
  for ((i = ${#RUN_DIRS[@]} - 1; i >= 0; i--)); do
    d=${RUN_DIRS[i]%/}
    if jq -e --arg b "$BRANCH" '.branch == $b' "$d/summary.json" >/dev/null 2>&1; then
      PREV_DIR=$d
      break
    fi
  done
  [[ -n $PREV_DIR ]] || die 3 "no finished run of $ID on branch $BRANCH to retry"
  ATTEMPT=$(($(jq -r '.attempt // 1' "$PREV_DIR/summary.json") + 1))
  PREV_RUN=$(jq -r '.run' "$PREV_DIR/summary.json")
  IMPL_SESSION=$(jq -r '.steps.implementer.session // empty' "$PREV_DIR/summary.json")
  [[ -n $MODEL ]] || MODEL=$(jq -r '.model_override // empty' "$PREV_DIR/summary.json")
  [[ -n $CHECK_CMD ]] || CHECK_CMD=$(jq -r '.check_command // empty' "$PREV_DIR/summary.json")
  NO_TESTER=1
  if [[ -n $IMPL_SESSION ]] && ! oc_quick session list --format json 2>/dev/null |
    jq -e --arg s "$IMPL_SESSION" 'any(.[]; .id == $s)' >/dev/null 2>&1; then
    echo "note: implementer session $IMPL_SESSION is gone, starting a fresh session with the card"
    IMPL_SESSION=""
  fi
fi
[[ -n $CHECK_CMD ]] || CHECK_CMD="npm run check"

STAMP=$(date -u +%Y%m%d-%H%M%S)
RUN=".runs/$ID/$STAMP"
mkdir -p "$RUN"
# Every prompt uses this copy, so an agent that edits the card cannot change what the
# reviewer is told.
cp "$CARD_REL" "$RUN/card.md"
CARD_TEXT="$RUN/card.md"
[[ -z $FEEDBACK_ABS ]] || cp "$FEEDBACK_ABS" "$RUN/feedback.md"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

declare -A STEP_JSON=()
CHECK_JSON='null'
DIFF_JSON='null'
VERDICT=""
RESULT=""
EXIT_CODE=3
SUMMARY_WRITTEN=0
HEAD_MOVED=false
PROCESS_FILES_CHANGED=false
FILES=0 INS=0 DEL=0
NEW_FILES="$RUN/new-files"
: >"$NEW_FILES"

# ---------------------------------------------------------------- helpers

# Files the agents must not touch. A change during the run is flagged, not blocked.
PROCESS_PATHS=(tasks AGENTS.md CLAUDE.md .opencode tools .claude)
process_fingerprint() {
  {
    git diff "$HEAD_SHA" -- "${PROCESS_PATHS[@]}"
    git ls-files --others --exclude-standard -- "${PROCESS_PATHS[@]}"
  } 2>/dev/null | sha256sum | cut -d ' ' -f 1
}

# New files are marked intent-to-add while the run lasts, so `git diff` shows them to the
# reviewer and in diff.patch. The marks come off at the end, because they break `git stash`.
mark_new_files() {
  git ls-files -z --others --exclude-standard -- . ':(exclude).runs' >"$NEW_FILES"
  [[ -s $NEW_FILES ]] || return 0
  git --literal-pathspecs add -N --pathspec-from-file="$NEW_FILES" --pathspec-file-nul 2>>"$RUN/git.log" ||
    echo "             warning: could not mark new files for the diff, see $RUN/git.log"
}
unmark_new_files() {
  [[ -s ${NEW_FILES:-} ]] || return 0
  git --literal-pathspecs reset -q --pathspec-from-file="$NEW_FILES" --pathspec-file-nul 2>>"$RUN/git.log" || true
  : >"$NEW_FILES"
}

write_summary() {
  ((SUMMARY_WRITTEN)) && return
  # Finish the record even if a signal arrives now.
  trap '' HUP INT TERM
  [[ $(git rev-parse HEAD 2>/dev/null) == "$HEAD_SHA" ]] || HEAD_MOVED=true
  local steps='{}' k
  for k in tester implementer reviewer; do
    [[ -n ${STEP_JSON[$k]:-} ]] || continue
    steps=$(jq -c --arg k "$k" --argjson v "${STEP_JSON[$k]}" '. + {($k): $v}' <<<"$steps")
  done
  if jq -n \
    --arg card "$ID" --arg card_file "$CARD_REL" --arg run "$STAMP" --argjson attempt "$ATTEMPT" \
    --arg retry_of "$PREV_RUN" --arg started "$STARTED" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg head "$HEAD_SHA" --arg branch "$BRANCH" --arg opencode "$OC_VERSION" \
    --arg model_override "$MODEL" --arg check_command "$CHECK_CMD" --argjson steps "$steps" \
    --argjson check "$CHECK_JSON" --argjson diff "$DIFF_JSON" --arg verdict "$VERDICT" \
    --arg result "$RESULT" --argjson exit "$EXIT_CODE" --argjson head_moved "$HEAD_MOVED" \
    --argjson process_files_changed "$PROCESS_FILES_CHANGED" \
    '{card: $card, card_file: $card_file, run: $run, attempt: $attempt,
      retry_of: (if $retry_of == "" then null else $retry_of end),
      started: $started, finished: $finished, head: $head, branch: $branch, opencode: $opencode,
      model_override: (if $model_override == "" then null else $model_override end),
      check_command: $check_command, steps: $steps, check: $check, diff: $diff,
      verdict: (if $verdict == "" then null else $verdict end), result: $result, exit: $exit,
      head_moved: $head_moved, process_files_changed: $process_files_changed}' \
    >"$RUN/summary.json.tmp"; then
    mv "$RUN/summary.json.tmp" "$RUN/summary.json"
    jq -c . "$RUN/summary.json" >>.runs/ledger.jsonl
    ln -sfn "$STAMP" ".runs/$ID/latest"
  else
    echo "card.sh: could not write $RUN/summary.json" >&2
  fi
  SUMMARY_WRITTEN=1
}

# shellcheck disable=SC2329 # called through the EXIT trap
on_exit() {
  local rc=$?
  if [[ -d ${RUN:-} ]]; then
    unmark_new_files
    if ((!SUMMARY_WRITTEN)); then
      [[ -n $RESULT ]] || RESULT=aborted
      EXIT_CODE=$rc
      write_summary
    fi
  fi
}
trap on_exit EXIT

# Children run in the background and the script waits for them, so Ctrl-C, a closed
# terminal or a stop from Claude Code takes effect at once. `timeout` sits in its own
# process group and would not see the terminal's signals, so the trap passes them on.
CHILD=""
# shellcheck disable=SC2329 # called through the HUP, INT and TERM traps
on_signal() {
  if [[ -n $CHILD ]]; then
    kill -TERM "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
  fi
  RESULT=aborted
  exit "$1"
}
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# wait_child <pid>. Sets CHILD_RC.
wait_child() {
  CHILD=$1
  wait "$CHILD"
  CHILD_RC=$?
  CHILD=""
}

fmt_secs() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

# run_step <step> <agent> <prompt file> [session id to continue]
# Sets STEP_RC and STEP_SESSION, writes <step>.md (final message), <step>.jsonl, <step>.stderr
# and <step>.export.json, and stores the step's record in STEP_JSON.
run_step() {
  local step=$1 agent=$2 prompt=$3 session=${4:-}
  local args=(run --agent "$agent" --format json --auto)
  if [[ -n $session ]]; then
    args+=(--session "$session")
  else
    args+=(--title "$ID $step a$ATTEMPT $STAMP")
  fi
  [[ $step == implementer && -n $MODEL ]] && args+=(--model "$MODEL")

  printf '%-12s running (%s)\n' "$step" "$(date +%H:%M:%S)"
  local start_ms t0=$SECONDS
  start_ms=$(date +%s%3N)
  timeout -k 30s "$STEP_TIMEOUT" "$OC" "${args[@]}" <"$prompt" >"$RUN/$step.jsonl" 2>"$RUN/$step.stderr" &
  wait_child $!
  STEP_RC=$CHILD_RC
  local secs=$((SECONDS - t0))

  # One JSON object per line. Anything else (warnings, stray output) is skipped.
  local events='fromjson? | objects'

  # The final message is the text of the last assistant message.
  jq -rRn "[inputs | $events | select(.type == \"text\")]
    | if length == 0 then \"\" else (last.part.messageID) as \$m
      | map(select(.part.messageID == \$m) | .part.text) | join(\"\\n\") end" \
    "$RUN/$step.jsonl" >"$RUN/$step.md" 2>/dev/null || : >"$RUN/$step.md"

  STEP_SESSION=$(jq -rRn "[inputs | $events | .sessionID // empty] | first // empty" "$RUN/$step.jsonl" 2>/dev/null)
  [[ -n $STEP_SESSION ]] || STEP_SESSION=$session

  local errors tools fallback=false timed_out=false
  errors=$(jq -cRn "[inputs | $events | select(.type == \"error\") | (.error.data.message // .error.name // \"error\" | tostring)]" "$RUN/$step.jsonl" 2>/dev/null) || errors='[]'
  tools=$(jq -cRn "[inputs | $events | select(.type == \"tool_use\") | .part.tool // \"unknown\"] | group_by(.) | map({key: .[0], value: length}) | from_entries" "$RUN/$step.jsonl" 2>/dev/null) || tools='{}'
  # The fallback warning is a plain line on stdout. JSON lines are skipped, because tool
  # output inside them can quote the same words.
  if grep -qE '^[^{].*Falling back to default agent' "$RUN/$step.jsonl" ||
    grep -q 'Falling back to default agent' "$RUN/$step.stderr"; then
    fallback=true
    STEP_RC=97
  fi
  if ((STEP_RC == 124 || STEP_RC == 137)); then timed_out=true; fi

  # Models and tokens come from OpenCode's own session export, limited to messages from this
  # run. Tokens of explore subagents live in their own sessions and only show up in
  # opencode stats.
  local none='{"models":[],"messages":0,"tokens":null,"cost":null}' usage
  usage=$none
  if [[ -n $STEP_SESSION ]] && oc_quick export "$STEP_SESSION" >"$RUN/$step.export.json" 2>/dev/null; then
    usage=$(jq -c --argjson since "$((start_ms - 1000))" '
      [.messages[]?.info | objects | select(.role == "assistant" and (.time.created // 0) >= $since)] as $a
      | {models: ($a | map("\(.providerID)/\(.modelID)") | unique),
         messages: ($a | length),
         tokens: ($a | reduce .[].tokens as $t ({input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0};
           .input += ($t.input // 0) | .output += ($t.output // 0) | .reasoning += ($t.reasoning // 0)
           | .cache_read += ($t.cache.read // 0) | .cache_write += ($t.cache.write // 0))),
         cost: ($a | map(.cost // 0) | add // 0)}' "$RUN/$step.export.json" 2>/dev/null) || usage=$none
  fi

  STEP_JSON[$step]=$(jq -c -n --arg agent "$agent" --arg session "$STEP_SESSION" --argjson rc "$STEP_RC" \
    --argjson seconds "$secs" --argjson errors "$errors" --argjson fallback "$fallback" \
    --argjson timed_out "$timed_out" --argjson tools "$tools" --argjson usage "$usage" \
    --arg continued "$session" \
    '{agent: $agent, session: (if $session == "" then null else $session end),
      continued_session: ($continued != ""), exit: $rc, seconds: $seconds, timed_out: $timed_out,
      agent_fallback: $fallback, errors: $errors, tool_calls: $tools} + $usage')

  local models
  models=$(jq -r '.models | join(",")' <<<"$usage")
  printf '%-12s %-36s exit %-3s %s\n' "$step" "${models:-?}" "$STEP_RC" "$(fmt_secs "$secs")"
  if [[ $errors != "[]" ]]; then
    jq -r '.[] | "             error: " + .' <<<"$errors"
  fi
  if grep -qiwE '10039|spend limit' <<<"$errors" || grep -qiwE '10039|spend limit' "$RUN/$step.stderr"; then
    echo "             Telnyx spend limit reached (error 10039). Stop and tell Thiago."
  fi
  if $fallback; then echo "             OpenCode fell back to its default agent. Check .opencode/agents/."; fi
  if $timed_out; then echo "             Timed out after $STEP_TIMEOUT."; fi
  return 0
}

fail_agent() {
  RESULT="agent_failed:$1"
  EXIT_CODE=4
  unmark_new_files
  write_summary
  printf 'result       agent run failed (%s), see %s/%s.stderr and %s.jsonl\n' "$1" "$RUN" "$1" "$1"
  exit 4
}

# ---------------------------------------------------------------- prompts

{
  printf 'Task card %s, full text below. Write the tests for this card now, following your instructions. The implementation does not exist yet.\n\n' "$CARD_REL"
  cat "$CARD_TEXT"
} >"$RUN/prompt-tester.md"

if [[ -n $FEEDBACK ]]; then
  {
    printf 'Attempt %s of task card %s. The previous attempt was not accepted. Address every point below, run `%s` until it passes, and finish with your report.\n\n' "$ATTEMPT" "$CARD_REL" "$CHECK_CMD"
    cat "$RUN/feedback.md"
    if [[ -z $IMPL_SESSION ]]; then
      printf '\n\nThe task card follows.\n\n'
      cat "$CARD_TEXT"
    fi
  } >"$RUN/prompt-implementer.md"
else
  {
    printf 'Task card %s, full text below. Implement it now, following your instructions.' "$CARD_REL"
    if [[ $CHECK_CMD != "npm run check" ]]; then
      printf ' For this card the check is `%s` instead of `npm run check`.' "$CHECK_CMD"
    fi
    if ((!NO_TESTER)); then
      printf ' The tester has already written tests for this card in the test folders it names. Read them first, they define done. Never delete or weaken them. If a test contradicts the card, say so under Questions instead of changing it.'
    fi
    printf '\n\n'
    cat "$CARD_TEXT"
  } >"$RUN/prompt-implementer.md"
fi

# ---------------------------------------------------------------- run

echo "$ID attempt $ATTEMPT, run $RUN${MODEL:+, implementer model $MODEL}"
PROCESS_BEFORE=$(process_fingerprint)

if ((!NO_TESTER)); then
  run_step tester tester "$RUN/prompt-tester.md"
  ((STEP_RC == 0)) || fail_agent tester
fi

run_step implementer implementer "$RUN/prompt-implementer.md" "$IMPL_SESSION"
((STEP_RC == 0)) || fail_agent implementer

if [[ $(process_fingerprint) != "$PROCESS_BEFORE" ]]; then
  PROCESS_FILES_CHANGED=true
  echo "             warning: tasks/, AGENTS.md, CLAUDE.md, .opencode/, tools/ or .claude/ changed during this run. See git status."
fi
if [[ $(git rev-parse HEAD) != "$HEAD_SHA" ]]; then
  HEAD_MOVED=true
  echo "             warning: HEAD moved during this run, so an agent committed. See git log. The diff is taken from ${HEAD_SHA:0:7}."
fi

printf '%-12s running (%s)\n' check "$(date +%H:%M:%S)"
T0=$SECONDS
timeout -k 30s "$CHECK_TIMEOUT" bash -c "$CHECK_CMD" </dev/null >"$RUN/check.log" 2>&1 &
wait_child $!
CHECK_RC=$CHILD_RC
CHECK_SECS=$((SECONDS - T0))
CHECK_TIMED_OUT=false
if ((CHECK_RC == 124 || CHECK_RC == 137)); then CHECK_TIMED_OUT=true; fi
CHECK_JSON=$(jq -c -n --argjson rc "$CHECK_RC" --argjson s "$CHECK_SECS" --argjson t "$CHECK_TIMED_OUT" '{exit: $rc, seconds: $s, timed_out: $t}')
printf '%-12s %-36s exit %-3s %s\n' check "$( ((CHECK_RC == 0)) && echo passed || echo FAILED)" "$CHECK_RC" "$(fmt_secs "$CHECK_SECS")"
if $CHECK_TIMED_OUT; then echo "             Timed out after $CHECK_TIMEOUT."; fi

# The diff is taken after the check, from the commit the run started at, so it holds
# everything the card produced, even if an agent committed.
mark_new_files
git diff "$HEAD_SHA" --stat -- . ':(exclude).runs' >"$RUN/diff.stat" 2>>"$RUN/git.log"
git diff "$HEAD_SHA" -- . ':(exclude).runs' >"$RUN/diff.patch" 2>>"$RUN/git.log"
read -r FILES INS DEL < <(git diff "$HEAD_SHA" --numstat -- . ':(exclude).runs' 2>>"$RUN/git.log" |
  awk '{f++; if ($1 != "-") i += $1; if ($2 != "-") d += $2} END {print f + 0, i + 0, d + 0}')
DIFF_JSON=$(jq -c -n --argjson f "$FILES" --argjson i "$INS" --argjson d "$DEL" '{files: $f, insertions: $i, deletions: $d}')

if ((CHECK_RC != 0)); then
  RESULT=check_failed
  EXIT_CODE=1
else
  {
    printf 'Review the change for task card %s. The change is uncommitted in the working tree. See it with `git status` and `git diff %s`, the commit this run started from. New files are marked intent-to-add, so they show up in the diff. Ignore `.runs/`, which belongs to the run harness.' "$CARD_REL" "${HEAD_SHA:0:12}"
    if [[ $CHECK_CMD != "npm run check" ]]; then
      printf ' For this card the check is `%s` instead of `npm run check`, and it has already passed.' "$CHECK_CMD"
    fi
    printf '\n\n'
    if [[ -n $FEEDBACK ]]; then
      printf 'This is attempt %s. Check that every point of the feedback on the previous attempt is addressed. The feedback was this.\n\n' "$ATTEMPT"
      cat "$RUN/feedback.md"
      printf '\n\n'
    fi
    printf 'The implementer reported this.\n\n'
    cat "$RUN/implementer.md"
    printf '\n\nThe task card follows.\n\n'
    cat "$CARD_TEXT"
  } >"$RUN/prompt-reviewer.md"

  run_step reviewer reviewer "$RUN/prompt-reviewer.md"
  ((STEP_RC == 0)) || fail_agent reviewer
  cp "$RUN/reviewer.md" "$RUN/review.md"

  # The verdict must be on the first non-empty line, as the reviewer is instructed.
  FIRST=$(grep -m 1 -v '^[[:space:]]*$' "$RUN/reviewer.md" || true)
  if grep -qwE 'APPROVED?' <<<"$FIRST" && ! grep -qw CHANGES <<<"$FIRST"; then
    VERDICT=APPROVE RESULT=approved EXIT_CODE=0
  elif grep -qw CHANGES <<<"$FIRST" && ! grep -qwE 'APPROVED?' <<<"$FIRST"; then
    VERDICT=CHANGES RESULT=changes_requested EXIT_CODE=2
  else
    VERDICT=UNCLEAR RESULT=verdict_unclear EXIT_CODE=2
  fi
  printf '%-12s %s\n' verdict "$VERDICT"
fi

unmark_new_files
write_summary
printf '%-12s %s files, +%s -%s\n' diff "$FILES" "$INS" "$DEL"
printf 'result       %s (exit %s)\n' "$RESULT" "$EXIT_CODE"
printf 'read         %s/summary.json, implementer.md, check.log%s, diff.patch\n' "$RUN" "$( ((CHECK_RC == 0)) && echo ', review.md')"
exit "$EXIT_CODE"
