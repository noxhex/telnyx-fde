import { createPublicKey, verify } from "node:crypto";

export type SignatureCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "bad_timestamp"
        | "stale_timestamp"
        | "bad_signature_encoding"
        | "bad_public_key"
        | "invalid_signature";
    };

/**
 * SPKI DER prefix for a raw 32-byte Ed25519 public key. The org public key
 * from GET /v2/public_key (data.public) is just the raw key bytes, so we wrap
 * them in the DER header to build a usable public key object.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyTelnyxSignature(input: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKey: string;
  nowMs: number;
  maxSkewSec?: number;
}): SignatureCheck {
  const { rawBody, signature, timestamp, publicKey, nowMs } = input;
  const maxSkewSec = input.maxSkewSec ?? 300;

  if (!signature || !timestamp) {
    return { ok: false, reason: "missing_headers" };
  }

  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) {
    return { ok: false, reason: "bad_timestamp" };
  }

  const skewSec = Math.abs(ts - nowMs / 1000);
  if (skewSec > maxSkewSec) {
    return { ok: false, reason: "stale_timestamp" };
  }

  let key: Buffer;
  try {
    key = Buffer.from(publicKey, "base64");
  } catch {
    return { ok: false, reason: "bad_public_key" };
  }
  if (key.length !== 32) {
    return { ok: false, reason: "bad_public_key" };
  }

  let sig: Buffer;
  try {
    sig = Buffer.from(signature, "base64");
  } catch {
    return { ok: false, reason: "bad_signature_encoding" };
  }
  if (sig.length !== 64) {
    return { ok: false, reason: "bad_signature_encoding" };
  }

  let publicKeyObj;
  try {
    publicKeyObj = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
      format: "der",
      type: "spki",
    });
  } catch {
    return { ok: false, reason: "bad_public_key" };
  }

  const message = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
  try {
    const valid = verify(null, message, publicKeyObj, sig);
    if (!valid) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
}