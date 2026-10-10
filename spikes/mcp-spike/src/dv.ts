/**
 * Spike S4 (ADR-008): `POST /dv`, the dynamic variables webhook. It mints a
 * random token id, returns it in the clear as `session_id`, and returns the
 * token `spike-<token id>` encrypted in `mcp_token`. The assistant's MCP
 * credential is `{{mcp_token | mcp_enc_key_spike}}`, so Telnyx decrypts the
 * value and sends the token to `POST /mcp` as its bearer token. The good
 * path is proven when the token id logged here ends with the suffix logged
 * there (the bearer token is `spike-<token id>`, so its last eight
 * characters are the id's last eight).
 *
 * `POST /dv?mode=bad` returns the same shape with one byte of the encrypted
 * value flipped, so Telnyx's decryption fails and the caller-visible
 * behaviour of a dead MCP credential can be observed. Any other mode value
 * takes the good path.
 */

import { randomBytes } from "node:crypto";

import { encryptForTelnyx } from "./telnyx-encrypt.js";

export interface DvResult {
  response: Response;
  /** The generated token id, for the request log line. */
  tokenId: string;
}

/**
 * Flips one bit in the last byte of the decoded value — that byte sits in
 * the 16-byte GCM tag, so decryption fails authentication with certainty,
 * which is the failure mode `mode=bad` exists to produce.
 */
function corruptValue(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
  return bytes.toString("base64url");
}

/**
 * Builds the webhook response. The token id is 12 random bytes in base64url
 * (16 characters, URL- and JSON-safe, long enough that the last eight
 * characters still identify it in the `/mcp` log line). The ciphertext
 * itself is never returned to the caller's model and never logged.
 */
export function handleDv(mode: string | null, key: Uint8Array): DvResult {
  const tokenId = randomBytes(12).toString("base64url");
  let mcpToken = encryptForTelnyx(`spike-${tokenId}`, key);
  if (mode === "bad") {
    mcpToken = corruptValue(mcpToken);
  }
  const response = Response.json({
    dynamic_variables: { session_id: tokenId },
    encrypted_dynamic_variables: { mcp_token: mcpToken },
  });
  return { response, tokenId };
}
