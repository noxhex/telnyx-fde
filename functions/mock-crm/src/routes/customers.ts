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
 * unknown number — the route table has one failure shape, 404
 * `{ "error": "not_found" }`.
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
