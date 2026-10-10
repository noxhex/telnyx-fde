/**
 * Spike S4 (ADR-008): encrypts the per-call token the way Telnyx expects for
 * `encrypted_dynamic_variables` — base64url of a 12-byte random nonce, then
 * the AES-256-GCM ciphertext, then the 16-byte tag, with no associated data
 * and no padding.
 *
 * Written fresh for the spike on purpose: the spike is standalone (not in
 * the npm workspaces), so it keeps its own copy instead of importing
 * @duinvezel/shared. T04's packages/shared/src/telnyx-encrypt.ts replaces
 * this file when the voice-context function mints real session tokens; the
 * wire format is identical, pinned by T04's tests.
 */

import {
  createCipheriv,
  randomBytes as cryptoRandomBytes,
} from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

// Base64url alphabet, optionally closed by one or two padding characters.
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Parses a base64url-encoded AES-256 key, with or without `=` padding (the
 * secret is stored unpadded, the way `openssl rand -base64 32 | tr '+/' '-_'
 * | tr -d '='` writes it). Throws unless the value is clean base64url and
 * decodes to exactly 32 bytes. The alphabet is checked by hand because
 * Node's base64url decoder silently skips invalid characters.
 */
export function parseKey(base64url: string): Uint8Array {
  if (!BASE64URL_KEY_PATTERN.test(base64url)) {
    throw new Error("key is not valid base64url");
  }
  const key = Buffer.from(base64url, "base64url");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `key must decode to exactly ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
}

/**
 * Encrypts a token for `encrypted_dynamic_variables.mcp_token`. Telnyx
 * decrypts it with the matching integration secret before sending it to the
 * MCP server as the bearer token. Throws if the key is not 32 bytes.
 */
export function encryptForTelnyx(plaintext: string, key: Uint8Array): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const nonce = cryptoRandomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]).toString("base64url");
}
