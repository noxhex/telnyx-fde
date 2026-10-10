# S4. Per-call token round trip

**Type** Spike · **Code by** implementer agent · **Hands-on** Thiago sets secrets and assistant config · **Needs** S2 and S3 · **Decides** ADR-008

## Goal

Prove that a token returned in `encrypted_dynamic_variables` arrives at our MCP server as the bearer token, and see exactly what a call looks like when decryption fails.

## Files

- `spikes/mcp-spike/src/index.ts` and helpers in `spikes/mcp-spike/src/`. The encryption code is written fresh here and replaced by T04 later.

## Behaviour

- New route `POST /dv` (no signature check in this spike). It generates a random token id, logs it, and returns the following.

  ```json
  {
    "dynamic_variables": { "session_id": "<token id>" },
    "encrypted_dynamic_variables": { "mcp_token": "<ciphertext>" }
  }
  ```

  The ciphertext is base64url of a 12-byte random nonce, then the AES-256-GCM ciphertext of `spike-<token id>`, then the 16-byte tag, with no associated data. The key comes from the secret `MCP_ENC_KEY_SPIKE`, a base64url-encoded 32-byte key.
- `POST /dv?mode=bad` returns the same shape with a corrupted ciphertext (one byte flipped).
- `POST /mcp` now also logs the last eight characters of the bearer token it receives, never the full token.

## Steps

1. Thiago generates the key and stores it twice, once as a Telnyx integration secret and once as an edge secret.

   ```bash
   KEY=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
   curl -sS -X POST https://api.telnyx.com/v2/integration_secrets \
     -H "Authorization: Bearer $TELNYX_API_KEY" -H "Content-Type: application/json" \
     -d "{\"identifier\":\"mcp_enc_key_spike\",\"type\":\"bearer\",\"token\":\"$KEY\"}" | jq '.data.identifier'
   telnyx-edge secrets add MCP_ENC_KEY_SPIKE "$KEY"
   unset KEY
   ```

2. The agent adds the behaviour above, and Thiago ships.
3. On the `spike-mcp` assistant from S3, which has the MCP server attached, set the dynamic variables webhook URL to the deployed `/dv`, and set the MCP server's credential to `{{mcp_token | mcp_enc_key_spike}}`.
4. **Good path.** Call the number and ask for the echo tool. The token id logged by `/dv` must match the suffix logged by `/mcp`.
5. **Bad path.** Change the webhook URL to `/dv?mode=bad` and call again. Expect no `/mcp` requests at all, and note what the assistant says when asked to use the tool.

## Done when

- The good path shows the same token on both sides.
- The bad path is described in `DEBUGLOG.md`, including what the caller hears, so the prompts can handle it.
- ADR-008 is marked Accepted, or rewritten if the round trip does not work.

## Result

Done on 10 October, on the `spike-mcp` assistant. The good path showed the same token on both sides, and every MCP request carried it, `initialize` included. The bad path crashed the browser call at the first tool use, against Telnyx's per-caller credentials docs (DEBUGLOG issue 13). The phone path was not tested. ADR-008 is accepted, with the consequence that both copies of the key are written together from one value.
