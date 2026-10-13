#!/usr/bin/env bash
# scripts/demo.sh — drive the voice-tools demo tooling (card T15) so the
# demo can be repeated: set the feature flags, put simulated outage reports
# on an area, and reset the demo state (every fixture account's call
# history, verification failures and lock, and every area's reports and
# incident).
#
#   scripts/demo.sh flags
#   scripts/demo.sh flags set <name> <value>      (<value> is read as JSON:
#                                                  true, false, numbers and
#                                                  null all work)
#   scripts/demo.sh reports <postcode> <count> [symptom]
#   scripts/demo.sh reset
#
# Usage:  source ~/.config/telnyx/env && scripts/demo.sh <command>
#
# The voice-tools URL comes from infra/ids.json and the internal key from
# DUINVEZEL_INTERNAL_KEY; the script stops with a clear message before any
# request when either is missing. The answer is printed through `jq .` and
# the exit status is non-zero on an HTTP status other than 2xx, after the
# answer is printed. The key is never printed, and this script is never run
# with `set -x`.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDS_JSON="$ROOT/infra/ids.json"
MAX_TIME_SECS=25

die() {
  printf 'demo: %s\n' "$*" >&2
  exit 2
}

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/demo.sh flags
  scripts/demo.sh flags set <name> <value>
  scripts/demo.sh reports <postcode> <count> [symptom]
  scripts/demo.sh reset
EOF
  exit 2
}

command -v curl >/dev/null 2>&1 || die "curl is required but not on PATH"
command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"
[[ -f $IDS_JSON ]] || die "infra/ids.json not found (looked at $IDS_JSON)"
[[ -n ${DUINVEZEL_INTERNAL_KEY:-} ]] ||
  die "DUINVEZEL_INTERNAL_KEY is not set; source ~/.config/telnyx/env first"

TOOLS_URL=$(jq -er '.functions["voice-tools"].invokeUrl' "$IDS_JSON") ||
  die 'infra/ids.json has no functions["voice-tools"].invokeUrl'

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
BODY="$TMP_DIR/body"
CURL_ERR="$TMP_DIR/curl.err"

# req METHOD PATH [curl args...] prints the answer through `jq .` and exits
# non-zero when the status is not 2xx. A curl-level failure prints 000 and
# leaves curl's message in $CURL_ERR.
req() {
  local method=$1 path=$2 code err
  shift 2
  : >"$CURL_ERR"
  code=$(curl -sS --max-time "$MAX_TIME_SECS" -o "$BODY" -w '%{http_code}' \
    -X "$method" "$@" "$TOOLS_URL$path" 2>"$CURL_ERR")
  if [[ -s $BODY ]]; then
    jq . "$BODY" 2>/dev/null || cat "$BODY"
  fi
  case $code in
    2*) ;;
    *)
      err=$(tr '\n' ' ' <"$CURL_ERR")
      printf 'demo: %s %s answered HTTP %s%s\n' "$method" "$path" "$code" \
        "${err:+; curl: $err}" >&2
      exit 1
      ;;
  esac
}

case "${1:-}" in
  flags)
    if [[ $# -eq 1 ]]; then
      req GET /internal/demo/flags -H "x-internal-key: $DUINVEZEL_INTERNAL_KEY"
    elif [[ $# -eq 4 && $2 == "set" ]]; then
      payload=$(jq -nc --arg name "$3" --argjson value "$4" '{($name): $value}') ||
        die "flags set: '$4' is not valid JSON (try true, false, a number or null)"
      req PUT /internal/demo/flags -H "x-internal-key: $DUINVEZEL_INTERNAL_KEY" \
        -H "Content-Type: application/json" --data "$payload"
    else
      usage
    fi
    ;;
  reports)
    if [[ $# -ne 3 && $# -ne 4 ]]; then
      usage
    fi
    if [[ $# -eq 4 ]]; then
      payload=$(jq -nc --arg postcode "$2" --argjson count "$3" --arg symptom "$4" \
        '{postcode: $postcode, count: $count, symptom: $symptom}') ||
        die "reports: '$3' is not a number"
    else
      payload=$(jq -nc --arg postcode "$2" --argjson count "$3" \
        '{postcode: $postcode, count: $count}') ||
        die "reports: '$3' is not a number"
    fi
    req POST /internal/demo/reports -H "x-internal-key: $DUINVEZEL_INTERNAL_KEY" \
      -H "Content-Type: application/json" --data "$payload"
    printf 'demo: the new area status reaches calls within about 15 seconds\n'
    printf 'demo: (the alarm publishes it a few seconds after the report; warm replicas keep area statuses for 10 seconds)\n'
    ;;
  reset)
    if [[ $# -ne 1 ]]; then
      usage
    fi
    req POST /internal/demo/reset -H "x-internal-key: $DUINVEZEL_INTERNAL_KEY"
    ;;
  *)
    usage
    ;;
esac
