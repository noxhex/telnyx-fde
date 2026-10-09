import {
  createCipheriv,
  createDecipheriv,
  randomBytes as cryptoRandomBytes,
} from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 8192;
// Base64url alphabet, optionally closed by one or two padding characters.
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Parses a base64url-encoded AES-256 key, with or without `=` padding. Throws
 * unless the value is clean base64url and decodes to exactly 32 bytes. The
 * alphabet is checked by hand because Node's base64url decoder silently skips
 * invalid characters.
 */
export function parseKey(base64url: string): Uint8Array {
  if (!BASE64URL_KEY_PATTERN.test(base64url)) {
    throw new Error("key is not valid base64url");
  }
  const key = Buffer.from(base64url, "base64url");
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must decode to exactly ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
}

/**
 * Encrypts a value the way Telnyx expects for `encrypted_dynamic_variables`
 * (ADR-008): base64url of a 12-byte random nonce, then the AES-256-GCM
 * ciphertext, then the 16-byte tag, with no associated data and no padding.
 *
 * Throws if the UTF-8 plaintext exceeds 8192 bytes, the key is not 32 bytes,
 * or the supplied `randomBytes` does not return a 12-byte nonce. `randomBytes`
 * is injectable so tests and spikes can pin the nonce and get a deterministic
 * output.
 */
export function encryptForTelnyx(
  plaintext: string,
  key: Uint8Array,
  randomBytes: (n: number) => Uint8Array = (n) => cryptoRandomBytes(n),
): string {
  const plaintextBytes = Buffer.from(plaintext, "utf8");
  if (plaintextBytes.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(
      `plaintext must be at most ${MAX_PLAINTEXT_BYTES} bytes, got ${plaintextBytes.length}`,
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`randomBytes must return a ${NONCE_BYTES}-byte nonce, got ${nonce.length}`);
  }

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]).toString("base64url");
}

/**
 * Reverses `encryptForTelnyx`, throwing on a wrong key or tampered data. It
 * exists for tests and spikes only; production code paths must not call it,
 * because Telnyx is the one that decrypts these values.
 */
export function decryptForTests(value: string, key: Uint8Array): string {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error(
      `value must decode to at least ${NONCE_BYTES + TAG_BYTES} bytes, got ${bytes.length}`,
    );
  }
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const ciphertext = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
