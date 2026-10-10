/**
 * Fixture data for the fake ISP back office. Eight accounts across the five
 * Duinvezel postcodes (8620 Nieuwpoort, 8630 Veurne, 8660 De Panne,
 * 8670 Koksijde, 8600 Diksmuide), three of them in 8630 Veurne so simulated
 * outage reports have more than one account to come from. Every line profile
 * appears at least once.
 *
 * This module is pure: no I/O, no clock, no secrets. The demo account
 * DV-100001 deliberately has an empty `phone`: its number is the real caller
 * number of whoever gives the demo, so it lives only in the
 * DEMO_CALLER_PHONE secret and is never committed. Lookups get the demo
 * number through `findAccountByPhoneDigits`'s `demoCallerPhone` argument.
 */

export type Plan = "Basic" | "Plus" | "Max";
export type LineProfile = "ok" | "degraded" | "down";

export interface CrmAccount {
  /** `DV-1xxxxx`. */
  accountNumber: string;
  firstName: string;
  lastName: string;
  /** E.164, or the empty string for the demo account. */
  phone: string;
  postcode: string;
  areaName: string;
  plan: Plan;
  /** `LN-xxxxxx`. */
  lineId: string;
  lineProfile: LineProfile;
}

/** What `GET /customers?phone=` returns. */
export interface CustomerSummary {
  accountNumber: string;
  firstName: string;
  postcode: string;
  areaName: string;
  lineId: string;
}

/** What `GET /accounts/<accountNumber>` returns: the summary plus more. */
export interface AccountDetails extends CustomerSummary {
  lastName: string;
  plan: Plan;
  lineProfile: LineProfile;
}

/** The demo account. Its line is down so the demo's diagnostics lead to an outage report. */
export const DEMO_ACCOUNT_NUMBER = "DV-100001";

const ACCOUNTS: readonly CrmAccount[] = [
  {
    accountNumber: DEMO_ACCOUNT_NUMBER,
    firstName: "Thiago",
    lastName: "Peeters",
    phone: "",
    postcode: "8630",
    areaName: "Veurne",
    plan: "Max",
    lineId: "LN-000001",
    lineProfile: "down",
  },
  {
    accountNumber: "DV-100002",
    firstName: "Marie",
    lastName: "Vermeulen",
    phone: "+3258000001",
    postcode: "8630",
    areaName: "Veurne",
    plan: "Plus",
    lineId: "LN-000002",
    lineProfile: "ok",
  },
  {
    accountNumber: "DV-100003",
    firstName: "Jan",
    lastName: "De Smet",
    phone: "+3258000002",
    postcode: "8630",
    areaName: "Veurne",
    plan: "Basic",
    lineId: "LN-000003",
    lineProfile: "degraded",
  },
  {
    accountNumber: "DV-100004",
    firstName: "Lotte",
    lastName: "Claeys",
    phone: "+3258000003",
    postcode: "8620",
    areaName: "Nieuwpoort",
    plan: "Plus",
    lineId: "LN-000004",
    lineProfile: "ok",
  },
  {
    accountNumber: "DV-100005",
    firstName: "Wout",
    lastName: "Vandenberghe",
    phone: "+3258000004",
    postcode: "8660",
    areaName: "De Panne",
    plan: "Basic",
    lineId: "LN-000005",
    lineProfile: "degraded",
  },
  {
    accountNumber: "DV-100006",
    firstName: "Anke",
    lastName: "Maes",
    phone: "+3258000005",
    postcode: "8670",
    areaName: "Koksijde",
    plan: "Max",
    lineId: "LN-000006",
    lineProfile: "down",
  },
  {
    accountNumber: "DV-100007",
    firstName: "Geert",
    lastName: "Willems",
    phone: "+3258000006",
    postcode: "8600",
    areaName: "Diksmuide",
    plan: "Basic",
    lineId: "LN-000007",
    lineProfile: "ok",
  },
  {
    accountNumber: "DV-100008",
    firstName: "Els",
    lastName: "Goossens",
    phone: "+3258000007",
    postcode: "8600",
    areaName: "Diksmuide",
    plan: "Plus",
    lineId: "LN-000008",
    lineProfile: "degraded",
  },
];

export function listAccounts(): readonly CrmAccount[] {
  return ACCOUNTS;
}

export function toCustomerSummary(account: CrmAccount): CustomerSummary {
  return {
    accountNumber: account.accountNumber,
    firstName: account.firstName,
    postcode: account.postcode,
    areaName: account.areaName,
    lineId: account.lineId,
  };
}

export function toAccountDetails(account: CrmAccount): AccountDetails {
  return {
    ...toCustomerSummary(account),
    lastName: account.lastName,
    plan: account.plan,
    lineProfile: account.lineProfile,
  };
}

export function findAccountByNumber(accountNumber: string): CrmAccount | null {
  return ACCOUNTS.find((a) => a.accountNumber === accountNumber) ?? null;
}

export function findAccountByLineId(lineId: string): CrmAccount | null {
  return ACCOUNTS.find((a) => a.lineId === lineId) ?? null;
}

/** The digits of an E.164 number: `+3258000001` -> `3258000001`. */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Finds the account behind a caller's digits-only phone number. The demo
 * account only matches through `demoCallerPhone` (the DEMO_CALLER_PHONE
 * secret): with it equal to the queried digits, the demo account is
 * returned; without it, the demo account is unreachable by phone.
 */
export function findAccountByPhoneDigits(
  digits: string,
  demoCallerPhone: string | null,
): CrmAccount | null {
  if (demoCallerPhone !== null && phoneDigits(demoCallerPhone) === digits) {
    const demo = findAccountByNumber(DEMO_ACCOUNT_NUMBER);
    if (demo !== null) {
      return demo;
    }
  }
  return ACCOUNTS.find((a) => a.phone.length > 0 && phoneDigits(a.phone) === digits) ?? null;
}
