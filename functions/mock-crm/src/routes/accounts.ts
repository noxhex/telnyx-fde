import { z } from "zod";

import { findAccountByNumber, toAccountDetails } from "../domain/fixtures.js";

const accountNumberSchema = z.string().regex(/^DV-1\d{5}$/);

export interface AccountsOutcome {
  status: number;
  body: Record<string, unknown>;
  /** Account number for the masked `account` log field; null on 404. */
  accountNumber: string | null;
}

/**
 * `GET /accounts/<accountNumber>`. An id that does not look like a Duinvezel
 * account number is a 404, same as one that is merely unknown.
 */
export function getAccount(accountNumber: string): AccountsOutcome {
  const parsed = accountNumberSchema.safeParse(accountNumber);
  if (!parsed.success) {
    return { status: 404, body: { error: "not_found" }, accountNumber: null };
  }
  const account = findAccountByNumber(parsed.data);
  if (account === null) {
    return { status: 404, body: { error: "not_found" }, accountNumber: null };
  }
  return {
    status: 200,
    body: { ...toAccountDetails(account) },
    accountNumber: account.accountNumber,
  };
}
