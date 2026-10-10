/**
 * The internal-key check. Every route except `/healthz` requires the header
 * `x-internal-key` to equal the `INTERNAL_KEY` secret. The comparison is
 * constant time: both sides are hashed to fixed-length digests before
 * `timingSafeEqual`, so the compare never throws on a length mismatch and
 * its timing never leaks how much of the key an attacker guessed right.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const INTERNAL_KEY_HEADER = "x-internal-key";

export function hasValidInternalKey(
  provided: string | null,
  expected: string | null,
): boolean {
  if (provided === null || expected === null) {
    return false;
  }
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
