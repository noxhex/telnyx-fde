#!/usr/bin/env bash
# scripts/smoke.sh — smoke test for the three deployed Duinvezel functions
# (card T10). Proves the wiring after a ship:
#
#   1. GET /healthz on mock-crm, voice-tools and voice-context (200).
#   2. mock-crm refuses GET /customers without the internal key (401) and
#      answers the same query with it (200).
#   3. voice-context refuses POST /dv without a Telnyx signature (403).
#   4. voice-tools refuses POST /mcp without a bearer token (401).
#   5. POST /internal/sessions with the internal key returns a token; with
#      it, initialize and tools/list on POST /mcp answer, and tools/list
#      returns the five tools.
#   6. voice-context's GET /internal/health with the internal key is 200,
#      and the script prints each dependency check's latency_ms.
#
# Usage:  source ~/.config/telnyx/env && scripts/smoke.sh
#
# The function URLs come from infra/ids.json and the internal key from
# DUINVEZEL_INTERNAL_KEY; the script stops with a clear message before any
# request when the key is not set. Every check runs even after one fails,
# with one PASS or FAIL line per check, and the exit status is non-zero
# when anything failed. The internal key and the session token are never
# printed, and this script is never run with `set -x`.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDS_JSON="$ROOT/infra/ids.json"
MAX_TIME_SECS=25

die() {
  printf 'smoke: %s\n' "$*" >&2
  exit 2
}

command -v curl >/dev/null 2>&1 || die "curl is required but not on PATH"
command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"
[[ -f $IDS_JSON ]] || die "infra/ids.json not found (looked at $IDS_JSON)"
[[ -n ${DUINVEZEL_INTERNAL_KEY:-} ]] ||
  die "DUINVEZEL_INTERNAL_KEY is not set; source ~/.config/telnyx/env first"

CRM_URL=$(jq -er '.functions["mock-crm"].invokeUrl' "$IDS_JSON") ||
  die 'infra/ids.json has no functions["mock-crm"].invokeUrl'
TOOLS_URL=$(jq -er '.functions["voice-tools"].invokeUrl' "$IDS_JSON") ||
  die 'infra/ids.json has no functions["voice-tools"].invokeUrl'
CONTEXT_URL=$(jq -er '.functions["voice-context"].invokeUrl' "$IDS_JSON") ||
  die 'infra/ids.json has no functions["voice-context"].invokeUrl'

# The MCP SDK answers 406 unless every POST /mcp carries both media types
# in Accept (DEBUGLOG, S3 findings).
MCP_HEADERS=(
  -H "Content-Type: application/json"
  -H "Accept: application/json, text/event-stream"
)
INIT_BODY='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"duinvezel-smoke","version":"1.0.0"}}}'
LIST_BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
BODY="$TMP_DIR/body"
CURL_ERR="$TMP_DIR/curl.err"

checks=0
failed=0

pass() {
  checks=$((checks + 1))
  printf 'PASS %s%s\n' "$1" "${2:+  ($2)}"
}

fail() {
  checks=$((checks + 1))
  failed=$((failed + 1))
  printf 'FAIL %s%s\n' "$1" "${2:+  ($2)}"
}

# req METHOD URL [curl args...] prints the HTTP status on stdout and leaves
# the response body in $BODY. A curl-level failure prints 000 and leaves
# curl's message in $CURL_ERR.
req() {
  local method=$1 url=$2
  shift 2
  : >"$CURL_ERR"
  curl -sS --max-time "$MAX_TIME_SECS" -o "$BODY" -w '%{http_code}' \
    -X "$method" "$@" "$url" 2>"$CURL_ERR"
}

# expect NAME WANT GOT [DETAIL] records one check against an HTTP status.
expect() {
  local name=$1 want=$2 got=$3 detail=${4:-}
  if [[ $got == "$want" ]]; then
    pass "$name" "$detail"
  else
    local err
    err=$(tr '\n' ' ' <"$CURL_ERR")
    fail "$name" "want HTTP $want, got $got${err:+; curl: $err}${detail:+; $detail}"
  fi
}

# --- 1. Liveness on all three functions ------------------------------------

code=$(req GET "$CRM_URL/healthz")
expect "GET /healthz mock-crm" 200 "$code"

code=$(req GET "$TOOLS_URL/healthz")
expect "GET /healthz voice-tools" 200 "$code"

code=$(req GET "$CONTEXT_URL/healthz")
expect "GET /healthz voice-context" 200 "$code"

# --- 2. mock-crm and the internal key --------------------------------------

code=$(req GET "$CRM_URL/customers?phone=3258000001")
expect "GET /customers without the internal key" 401 "$code"

code=$(req GET "$CRM_URL/customers?phone=3258000001" \
  -H "x-internal-key: $DUINVEZEL_INTERNAL_KEY")
expect "GET /customers with the internal key" 200 "$code"

# --- 3. voice-context refuses an unsigned webhook ---------------------------

code=$(req POST "$CONTEXT_URL/dv" \
  -H "Content-Type: application/json" --data '{}')
expect "POST /dv without a Telnyx signature" 403 "$code"

# --- 4. voice-tools refuses an unauthenticated MCP request ------------------

code=$(req POST "$TOOLS_URL/mcp" "${MCP_HEADERS[@]}" --data "$INIT_BODY")
expect "POST /mcp without a bearer token" 401 "$code"

# --- 5. A session token, then the MCP path end to end -----------------------

token=""
code=$(req POST "$TOOLS_URL/internal/sessions" \
  -H "x-internal-key: $DUINVEZEL_INTERNAL_KEY" \
  -H "Content-Type: application/json" --data '{"identity":"anonymous"}')
if [[ $code == 200 ]]; then
  token=$(jq -r '.token // empty' "$BODY" 2>/dev/null)
  sid=$(jq -r '.sid // empty' "$BODY" 2>/dev/null)
fi
if [[ -n $token && -n ${sid:-} ]]; then
  pass "POST /internal/sessions" "sid $sid (trace internal-$sid)"
else
  token=""
  fail "POST /internal/sessions" "want HTTP 200 with token and sid, got $code"
fi

if [[ -n $token ]]; then
  code=$(req POST "$TOOLS_URL/mcp" "${MCP_HEADERS[@]}" \
    -H "Authorization: Bearer $token" --data "$INIT_BODY")
  proto=$(jq -r '.result.protocolVersion // empty' "$BODY" 2>/dev/null)
  if [[ $code == 200 && $proto == "2025-11-25" ]]; then
    pass "POST /mcp initialize" "protocolVersion $proto"
  else
    fail "POST /mcp initialize" \
      "want HTTP 200 protocolVersion 2025-11-25; got HTTP $code, protocolVersion ${proto:-missing}"
  fi

  code=$(req POST "$TOOLS_URL/mcp" "${MCP_HEADERS[@]}" \
    -H "Authorization: Bearer $token" --data "$LIST_BODY")
  count=$(jq -r '(.result.tools // []) | length' "$BODY" 2>/dev/null)
  names=$(jq -r '[(.result.tools // [])[].name] | join(", ")' "$BODY" 2>/dev/null)
  if [[ $code == 200 && $count == 5 ]]; then
    pass "POST /mcp tools/list" "five tools: $names"
  else
    fail "POST /mcp tools/list" "want HTTP 200 with five tools, got $code with ${count:-0}${names:+ ($names)}"
  fi
else
  fail "POST /mcp initialize" "skipped: no session token"
  fail "POST /mcp tools/list" "skipped: no session token"
fi

# --- 6. voice-context's deep health check -----------------------------------

code=$(req GET "$CONTEXT_URL/internal/health" \
  -H "x-internal-key: $DUINVEZEL_INTERNAL_KEY")
latencies=$(jq -r '(.checks // {}) | to_entries
  | map("\(.key) \(.value.latency_ms) ms") | join(", ")' "$BODY" 2>/dev/null)
ok=$(jq -r '.ok // false' "$BODY" 2>/dev/null)
if [[ $code == 200 && $ok == "true" ]]; then
  pass "GET /internal/health voice-context" "$latencies"
else
  fail "GET /internal/health voice-context" \
    "want HTTP 200 with ok true, got $code${latencies:+; $latencies}"
fi

# --- Summary ----------------------------------------------------------------

if [[ $failed -gt 0 ]]; then
  printf 'smoke: %d of %d checks failed\n' "$failed" "$checks" >&2
  exit 1
fi
printf 'smoke: all %d checks passed\n' "$checks"
