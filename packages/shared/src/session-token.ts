import { createHmac, timingSafeEqual } from "node:crypto";

/** Claims carried by the per-call bearer token (ADR-008). `exp` is ms since epoch. */
export interface SessionClaims {
  v: 1;
  sid: string;
  exp: number;
}

export type TokenCheck =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "unsupported_version" };

const VERSION = "v1";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function hmacSha256(message: string, hmacKey: Uint8Array): Buffer {
  return createHmac("sha256", hmacKey).update(message, "utf8").digest();
}

/**
 * Decodes a base64url part strictly: characters outside the alphabet make the
 * whole part invalid, because `Buffer.from(part, "base64url")` silently skips
 * them instead of failing.
 */
function decodeBase64Url(part: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(part)) {
    return null;
  }
  return Buffer.from(part, "base64url");
}

function isSessionClaims(value: unknown): value is SessionClaims {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const claims = value as Record<string, unknown>;
  return (
    claims.v === 1 &&
    typeof claims.sid === "string" &&
    typeof claims.exp === "number" &&
    Number.isFinite(claims.exp)
  );
}

/**
 * Mints a session token of the form
 * `v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256 over "v1." + payload)>`
 * with no padding anywhere. Deterministic for the same claims and key.
 */
export function mintSessionToken(claims: { sid: string; exp: number }, hmacKey: Uint8Array): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, sid: claims.sid, exp: claims.exp } satisfies SessionClaims),
    "utf8",
  ).toString("base64url");
  const message = `${VERSION}.${payload}`;
  const signature = hmacSha256(message, hmacKey).toString("base64url");
  return `${message}.${signature}`;
}

/**
 * Verifies a session token and never throws: every failure is a TokenCheck.
 * Checks run in a fixed order: part count, version prefix, HMAC, payload
 * shape, then expiry.
 *
 * Only the canonical unpadded base64url of the expected HMAC verifies: the
 * received signature string is compared with the encoded recomputed HMAC
 * through `timingSafeEqual`, so a variant that differs only in the unused
 * padding bits of the last character (and would decode to the same bytes) is
 * rejected. A token whose `exp` is at or before `nowMs` is expired, and a
 * non-finite `nowMs` counts as expired too, so a broken clock fails closed.
 */
export function verifySessionToken(token: string, hmacKey: Uint8Array, nowMs: number): TokenCheck {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "malformed" };
    }
    const [version, payload, signature] = parts;

    if (version !== VERSION) {
      return { ok: false, reason: "unsupported_version" };
    }

    // Compare the received signature against the canonical unpadded base64url
    // encoding of the recomputed HMAC, not against its decoded bytes: decoding
    // would accept any of the variants that differ only in padding bits.
    const expectedSignature = hmacSha256(`${version}.${payload}`, hmacKey).toString("base64url");
    const receivedSignature = Buffer.from(signature, "utf8");
    const expectedBytes = Buffer.from(expectedSignature, "utf8");
    if (
      receivedSignature.length !== expectedBytes.length ||
      !timingSafeEqual(receivedSignature, expectedBytes)
    ) {
      return { ok: false, reason: "bad_signature" };
    }

    // Only authenticated payloads reach JSON parsing.
    const payloadBytes = decodeBase64Url(payload);
    if (payloadBytes === null) {
      return { ok: false, reason: "malformed" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      return { ok: false, reason: "malformed" };
    }

    if (!isSessionClaims(parsed)) {
      return { ok: false, reason: "malformed" };
    }

    // A broken clock fails closed: with a non-finite nowMs the comparison
    // would go the wrong way or nowhere, so count it as expired.
    if (!Number.isFinite(nowMs) || parsed.exp <= nowMs) {
      return { ok: false, reason: "expired" };
    }

    return { ok: true, claims: { v: 1, sid: parsed.sid, exp: parsed.exp } };
  } catch {
    // Fail closed on anything unexpected.
    return { ok: false, reason: "malformed" };
  }
}
