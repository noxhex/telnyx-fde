import { z } from "zod";

import {
  findAccountByPhoneDigits,
  toCustomerSummary,
} from "../domain/fixtures.js";

const querySchema = z.object({
  phone: z.string().regex(/^\d+$/),
});

export interface CustomersOutcome {
  status: number;
  body: Record<string, unknown>;
  /** Phone for the masked `caller` log field; null when nothing matched. */
  callerPhone: string | null;
}

/**
 * `GET /customers?phone=<digits>`. A malformed query is answered like an
 * unknown number, 404 `{ "error": "not_found" }`. When the digits match no
 * fixture account and `DEMO_CALLER_PHONE` could not be read (a timeout, an
 * error, or an empty or missing value) the answer is 503
 * `{ "error": "unavailable" }` — the answer `crm_fail` gives — instead of
 * 404: the queried digits may be the demo number, and voice-context treats
 * a 503 as a failed lookup, so it caches no "not found" for what may be the
 * demo number (T20). Digits that match a fixture account still answer 200
 * in that state.
 */
export function getCustomer(
  searchParams: URLSearchParams,
  demoCallerPhone: string | null,
): CustomersOutcome {
  const parsed = querySchema.safeParse({ phone: searchParams.get("phone") });
  if (!parsed.success) {
    return { status: 404, body: { error: "not_found" }, callerPhone: null };
  }
  const account = findAccountByPhoneDigits(parsed.data.phone, demoCallerPhone);
  if (account === null) {
    // No fixture matched: the demo number was never checked without the
    // secret, so an unreadable DEMO_CALLER_PHONE is an outage here, not a
    // miss.
    if (demoCallerPhone === null) {
      return { status: 503, body: { error: "unavailable" }, callerPhone: null };
    }
    return { status: 404, body: { error: "not_found" }, callerPhone: null };
  }
  // The demo account has no phone in the fixtures by design; log the queried
  // digits (that is the demo caller's real number).
  const callerPhone =
    account.phone.length > 0 ? account.phone : `+${parsed.data.phone}`;
  return {
    status: 200,
    body: { ...toCustomerSummary(account) },
    callerPhone,
  };
}
