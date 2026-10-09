/**
 * Masking helpers for log fields. Phone and account numbers are personal
 * data: the log line keeps just enough of each to recognise it (the country
 * prefix / the account prefix and a short tail) and hides the rest behind a
 * single ellipsis character (U+2026).
 */

const ELLIPSIS = "…";

/**
 * `+32491244713` -> `+32…4713`. Keeps the country prefix (`+` and the first
 * two digits) and the last four digits. Input with fewer than six digits
 * collapses to a bare ellipsis — the kept parts would overlap and leak the
 * full number.
 */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 6) {
    return ELLIPSIS;
  }
  return `+${digits.slice(0, 2)}${ELLIPSIS}${digits.slice(-4)}`;
}

/**
 * `DV-100231` -> `DV-…231`. Keeps the prefix up to and including the dash
 * (that prefix identifies the product, not the customer) and the last three
 * characters.
 */
export function maskAccount(id: string): string {
  const dash = id.indexOf("-");
  const prefix = dash === -1 ? "" : id.slice(0, dash + 1);
  return `${prefix}${ELLIPSIS}${id.slice(-3)}`;
}
