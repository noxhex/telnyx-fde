/**
 * KV key builders and validation. KV keys allow only `a-z A-Z 0-9 - _ / = .`
 * and at most 256 characters, and these helpers are the only way keys get
 * built (docs/ARCHITECTURE.md, KV keys), so what is impossible to store is
 * impossible to express:
 *
 * - Phone numbers keep digits only — the `+` is dropped (`crm/phone/<digits>`).
 * - Session ids are exactly 32 lowercase hex characters: the first half of
 *   the SHA-256 of the call control id, which itself contains characters KV
 *   forbids (`:`).
 * - Postcodes are exactly four digits.
 *
 * Every invalid input throws, so a bad value fails the request instead of
 * writing under a garbage key.
 */

import { createHash } from "node:crypto";

const SID_PATTERN = /^[0-9a-f]{32}$/;
const POSTCODE_PATTERN = /^\d{4}$/;
const KEY_PATTERN = /^[A-Za-z0-9\-_/=.]+$/;
const MAX_KEY_LENGTH = 256;

function requireSessionId(sid: string): void {
  if (!SID_PATTERN.test(sid)) {
    throw new Error(
      `Invalid session id: expected 32 lowercase hex characters, got ${JSON.stringify(sid)}`,
    );
  }
}

export const kvKeys = {
  /** `crm/phone/32491244713` — digits only, the `+` and any punctuation go. */
  crmPhone(e164: string): string {
    return `crm/phone/${e164.replace(/\D/g, "")}`;
  },
  /** `session/<sid>` for a 32-lowercase-hex session id. */
  session(sid: string): string {
    requireSessionId(sid);
    return `session/${sid}`;
  },
  /** `area/8630/status` for a four-digit postcode. */
  areaStatus(postcode: string): string {
    if (!POSTCODE_PATTERN.test(postcode)) {
      throw new Error(
        `Invalid postcode: expected four digits, got ${JSON.stringify(postcode)}`,
      );
    }
    return `area/${postcode}/status`;
  },
  /** `callback/<sid>` for a 32-lowercase-hex session id. */
  callback(sid: string): string {
    requireSessionId(sid);
    return `callback/${sid}`;
  },
  flags(): string {
    return "flags/global";
  },
  canaryLast(): string {
    return "canary/last";
  },
  canaryProbe(): string {
    return "canary/probe";
  },
};

/**
 * The session id for a call: the first 32 hex characters of SHA-256 over the
 * UTF-8 call control id. Stable per call, safe as a KV key component even
 * though the call control id contains `:`.
 */
export function sessionIdFromCallControlId(callControlId: string): string {
  return createHash("sha256").update(callControlId, "utf8").digest("hex").slice(0, 32);
}

/**
 * Throws unless `key` is a legal KV key: 1–256 characters, all from
 * `a-z A-Z 0-9 - _ / = .`. Use it on any key not built through `kvKeys`
 * (for example one read from an external source) before touching KV.
 */
export function assertValidKey(key: string): void {
  if (key.length === 0) {
    throw new Error("Invalid KV key: must not be empty");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Invalid KV key: ${key.length} characters is longer than ${MAX_KEY_LENGTH}`);
  }
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid KV key: contains characters outside a-z A-Z 0-9 - _ / = . : ${JSON.stringify(key)}`,
    );
  }
}
