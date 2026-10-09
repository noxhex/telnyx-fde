import { createPublicKey, verify } from "node:crypto";

// DER SPKI header for an Ed25519 public key: the 32 raw key bytes follow it.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const DEFAULT_MAX_SKEW_SEC = 300;

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
 * Verifies a Telnyx webhook signature (Ed25519 over `{timestamp}|{rawBody}`)
 * without throwing, logging or touching the clock. Returns the first failed
 * check, in the order: headers present, timestamp shape, timestamp fresh,
 * public key length, signature length, signature valid.
 */
export function verifyTelnyxSignature(input: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKey: string;
  nowMs: number;
  maxSkewSec?: number;
}): SignatureCheck {
  const { rawBody, signature, timestamp, publicKey, nowMs } = input;
  const maxSkewMs = (input.maxSkewSec ?? DEFAULT_MAX_SKEW_SEC) * 1000;

  if (!signature || !timestamp) {
    return { ok: false, reason: "missing_headers" };
  }

  if (!/^\d+$/.test(timestamp)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  const timestampMs = Number(timestamp) * 1000;

  if (Math.abs(nowMs - timestampMs) > maxSkewMs) {
    return { ok: false, reason: "stale_timestamp" };
  }

  let publicKeyBytes: Buffer;
  try {
    publicKeyBytes = Buffer.from(publicKey, "base64");
  } catch {
    return { ok: false, reason: "bad_public_key" };
  }
  if (publicKeyBytes.length !== RAW_PUBLIC_KEY_BYTES) {
    return { ok: false, reason: "bad_public_key" };
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return { ok: false, reason: "bad_signature_encoding" };
  }
  if (signatureBytes.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "bad_signature_encoding" };
  }

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    const message = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
    if (!verify(null, message, key, signatureBytes)) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
}
