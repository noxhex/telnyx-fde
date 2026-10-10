# T10. Deploy and smoke-test all three functions

**Phase** 1 · **Depends on** T08, T09 · **Hands-on** Thiago for secrets and ships · **Code by** implementer agent for `scripts/smoke.sh`

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

   T11 needs `DUINVEZEL_MCP_ENC_KEY` again for the Telnyx integration secret, and the scripts need `DUINVEZEL_INTERNAL_KEY`. Both stay only in `~/.config/telnyx/env`.

3. **Flags.**

   ```bash
   NS=$(jq -r .kvNamespaceId infra/ids.json)
   telnyx-edge storage kv key put "$NS" flags/global '{"incident_threshold":3,"report_window_secs":1800,"incident_eta_minutes":240,"diagnostics_enabled":true,"dv_force_error":false,"crm_delay_ms":0,"crm_fail":false}'
   ```

## Ship order

Ship `mock-crm` first, then `voice-tools` (it owns the actor types), then `voice-context` (it references `CustomerAccount`). Time each one with `time telnyx-edge ship` and add the times to `DEBUGLOG.md`. If the CLI gives up, check `telnyx-edge list` and `telnyx-edge ship status <name>` before shipping again.

## `scripts/smoke.sh` (agent)

The script reads the function URLs from `infra/ids.json` and the internal key from `DUINVEZEL_INTERNAL_KEY`. It prints one pass or fail line per check and exits non-zero if anything fails.

| Check | Expected |
|---|---|
| `GET /healthz` on all three | 200 |
| mock-crm `GET /customers?phone=3258000001` without the key | 401 |
| the same with the key | 200 |
| voice-context `POST /dv` without a signature | 403 |
| voice-tools `POST /mcp` without a token | 401 |
| voice-tools `POST /internal/sessions`, then `initialize` and `tools/list` with the token | five tools |
| voice-context `GET /internal/health` with the key | 200 with latencies |

## Acceptance

- [ ] `scripts/smoke.sh` passes against the deployed functions.
- [ ] `telnyx-edge inspect voice-context` shows the `CustomerAccount` actor binding.
- [ ] Ship times are recorded in `DEBUGLOG.md`.
- [ ] `infra/ids.json` is complete.
- [ ] MCP Inspector against the deployed `/mcp`, with a token from `POST /internal/sessions` for a fixture account, lists the five tools and calls `verify_account` with the right postcode. `telnyx-edge logs voice-tools` then shows the actor's log line carrying that session's trace id, `internal-<sid>`.
