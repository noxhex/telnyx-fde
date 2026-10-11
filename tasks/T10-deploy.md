# T10. Deploy and smoke-test all three functions

**Phase** 1 · **Depends on** T08, T09, T19 · **Hands-on** Thiago for secrets and ships · **Code by** implementer agent for `scripts/smoke.sh`

## Goal

All three functions live with their secrets, bindings and flags, plus a repeatable smoke test that proves the wiring.

## Before you start (Thiago)

1. **KV namespace.** `duinvezel` exists and its id is in `infra/ids.json`. If you still need it, run `telnyx-edge storage kv create --name duinvezel`. If that times out, check `telnyx-edge storage kv list` before retrying (DEBUGLOG issue 5).
2. **Secrets.** Secrets are shared by every function in the organization. Never paste their values into chat or into a file in the repo.

   ```bash
   gen() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '='; }
   telnyx-edge secrets add MCP_TOKEN_KEY "$(gen)"

   ENC=$(gen); telnyx-edge secrets add MCP_ENC_KEY "$ENC"
   echo "export DUINVEZEL_MCP_ENC_KEY=\"$ENC\"" >> ~/.config/telnyx/env; unset ENC

   INT=$(gen); telnyx-edge secrets add INTERNAL_KEY "$INT"
   echo "export DUINVEZEL_INTERNAL_KEY=\"$INT\"" >> ~/.config/telnyx/env; unset INT

   telnyx-edge secrets add TELNYX_PUBLIC_KEY "$(curl -s -H "Authorization: Bearer $TELNYX_API_KEY" https://api.telnyx.com/v2/public_key | jq -r '.data.public')"

   read -rsp 'Demo caller phone in E.164 ' P; echo
   telnyx-edge secrets add DEMO_CALLER_PHONE "$P"; unset P
   ```

   T11 needs `DUINVEZEL_MCP_ENC_KEY` again for the Telnyx integration secret, and the scripts need `DUINVEZEL_INTERNAL_KEY`. Both stay only in `~/.config/telnyx/env`. The edge secret `MCP_ENC_KEY` and the integration secret must hold the same value, because a mismatch crashes a call at its first tool use (DEBUGLOG issue 13). So both are always written from the one value saved here, and every key change gets a real test call before the demo.

3. **Flags.**

   ```bash
   NS=$(jq -r .kvNamespaceId infra/ids.json)
   telnyx-edge storage kv key put "$NS" flags/global '{"incident_threshold":3,"report_window_secs":1800,"incident_eta_minutes":240,"diagnostics_enabled":true,"dv_force_error":false,"crm_delay_ms":0,"crm_fail":false}'
   ```

## Ship order

Ship `mock-crm` first, then `voice-tools` (it owns the actor types), then `voice-context` (it references `CustomerAccount` and `Session`). Time each one with `time telnyx-edge ship` and add the times to `DEBUGLOG.md`. If the CLI gives up, check `telnyx-edge list` and `telnyx-edge ship status <name>` before shipping again.

## Timing (Thiago)

S1 captured no cold start and did not time a call between functions (DEBUGLOG, S1 measurements). A ship gives both.

1. **Cold start.** Right after each ship, send the function its first request, `GET /healthz`, which touches no state. Record the client time from `curl -s -o /dev/null -w '%{time_total}\n' <url>/healthz` and the server-side duration from `telnyx-edge logs <name> --type invocations`. Then send five more for the warm numbers.
2. **voice-context's calls.** After the voice-context ship, call `GET /internal/health` with the internal key ten times. Its answer holds `latency_ms` for the KV put and get, the CRM lookup and the two actor calls, as seen from inside voice-context. The first call also includes whatever is still cold.

Record both next to S1's numbers in `DEBUGLOG.md`, with the times of day, and say whether any number moves the budget in `docs/ARCHITECTURE.md` (Call setup latency budget). The 1,500 ms that voice-tools allows for `GET /accounts` on mock-crm is an estimate that stays until this measurement, and then gets set from the measured call between functions.

## `scripts/smoke.sh` (agent)

The agent writes `scripts/smoke.sh` and nothing else. It is a bash script, run by Thiago from the repo root, with `curl` and `jq`. It reads the function URLs from `infra/ids.json` and the internal key from `DUINVEZEL_INTERNAL_KEY`, and stops with a clear message before any request when the key is not set. It prints one pass or fail line per check, runs every check even after one fails, and exits non-zero if anything failed.

- The internal key goes in the `x-internal-key` header, on mock-crm, on `/internal/sessions` and on `/internal/health`.
- Every `POST /mcp` sends `Content-Type: application/json` and `Accept: application/json, text/event-stream`, or the SDK answers 406 (DEBUGLOG, S3 findings). `POST /internal/sessions` with the body `{"identity":"anonymous"}` answers `{ token, sid }`, and the token goes in `Authorization: Bearer`.
- `GET /internal/health` answers `{ ok, checks }`, where `checks` holds `kv`, `crm`, `customer_account` and `session`, each with `ok` and `latency_ms`. It answers 503 when any check fails.
- The script never prints the internal key or the token, and never runs with `set -x`.

| Check | Expected |
|---|---|
| `GET /healthz` on all three | 200 |
| mock-crm `GET /customers?phone=3258000001` without the key | 401 |
| the same with the key | 200 |
| voice-context `POST /dv` without a signature | 403 |
| voice-tools `POST /mcp` without a token | 401 |
| voice-tools `POST /internal/sessions`, then `initialize` and `tools/list` with the token | five tools |
| voice-context `GET /internal/health` with the key | 200, and the script prints each check's `latency_ms` |

## Acceptance

- [ ] `scripts/smoke.sh` passes against the deployed functions.
- [ ] `telnyx-edge inspect voice-context` shows the `CustomerAccount` and `Session` actor bindings.
- [ ] Ship times are recorded in `DEBUGLOG.md`.
- [ ] The first request after each ship and voice-context's calls to KV, mock-crm and the actors are timed and recorded next to S1's numbers.
- [ ] `infra/ids.json` is complete.
- [ ] MCP Inspector against the deployed `/mcp`, with a token from `POST /internal/sessions` for a fixture account, lists the five tools and calls `verify_account` with the right postcode. `telnyx-edge logs voice-tools` then shows the actor's log line carrying that session's trace id, `internal-<sid>`.
