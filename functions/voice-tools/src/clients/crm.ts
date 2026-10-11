/**
 * The mock-crm HTTP client for voice-tools. `POST {CRM_URL}/lines/<lineId>/test`
 * with the internal key, behind `run_line_diagnostics`. A 200 carries the
 * line test result and is the only answer. Any other status, a network
 * error, a missing key or an invalid body is `{ ok: false }`, and the tool
 * turns that into the sentence the model can say aloud.
 *
 * T19 adds `getAccount` — `GET {CRM_URL}/accounts/<number>` behind
 * `verify_account`. Unlike the line test it has three honest outcomes:
 * `found` (200), `not_found` (404, so the account does not exist and the
 * guess is counted on the session) and `failed` (everything else — a tool
 * error, not a business outcome).
 *
 * The internal key is read per call through `readInternalKey`: memoised per
 * container in production (index.ts), null in dev, and a null key means the
 * call is never made (mock-crm would 401, which is just another failure).
 */

import { z } from "zod";

/** What mock-crm's line test returns (functions/mock-crm/src/domain/line-test.ts). */
export interface LineTestResult {
  lineState: "ok" | "degraded" | "down";
  signalDbm: number | null;
  lastSeenMinutes: number;
  suggestion: string;
  nearbyOutageSuspected: boolean;
}

const lineTestResultSchema = z.object({
  lineState: z.enum(["ok", "degraded", "down"]),
  signalDbm: z.number().nullable(),
  lastSeenMinutes: z.number(),
  suggestion: z.string(),
  nearbyOutageSuspected: z.boolean(),
});

export type LineTestOutcome = { ok: true; result: LineTestResult } | { ok: false };

/** The account fields `verify_account` needs from `GET /accounts/<number>`; the rest of the details document is ignored. */
export interface CrmAccount {
  accountNumber: string;
  firstName: string;
  postcode: string;
  lineId: string;
}

const accountSchema = z.object({
  accountNumber: z.string(),
  firstName: z.string(),
  postcode: z.string(),
  lineId: z.string(),
});

export type GetAccountOutcome =
  | { kind: "found"; account: CrmAccount }
  | { kind: "not_found" }
  | { kind: "failed" };

export interface CrmClient {
  /** `POST /lines/<lineId>/test`; `ok` is false for every non-answer. */
  testLine(lineId: string): Promise<LineTestOutcome>;
  /** `GET /accounts/<number>`; 404 is `not_found`, every other non-answer is `failed`. */
  getAccount(accountNumber: string): Promise<GetAccountOutcome>;
}

export function createCrmClient(input: {
  crmUrl: string;
  readInternalKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): CrmClient {
  const doFetch = input.fetchImpl ?? fetch;
  return {
    async testLine(lineId: string): Promise<LineTestOutcome> {
      const internalKey = await input.readInternalKey();
      if (internalKey === null) {
        return { ok: false };
      }
      const url = `${input.crmUrl.replace(/\/+$/, "")}/lines/${encodeURIComponent(lineId)}/test`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "x-internal-key": internalKey },
        });
      } catch {
        return { ok: false };
      }
      if (res.status !== 200) {
        return { ok: false };
      }
      try {
        const parsed = lineTestResultSchema.safeParse(await res.json());
        if (!parsed.success) {
          return { ok: false };
        }
        return { ok: true, result: parsed.data };
      } catch {
        return { ok: false };
      }
    },

    async getAccount(accountNumber: string): Promise<GetAccountOutcome> {
      const internalKey = await input.readInternalKey();
      if (internalKey === null) {
        return { kind: "failed" };
      }
      const url = `${input.crmUrl.replace(/\/+$/, "")}/accounts/${encodeURIComponent(accountNumber)}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers: { "x-internal-key": internalKey },
        });
      } catch {
        return { kind: "failed" };
      }
      if (res.status === 404) {
        return { kind: "not_found" };
      }
      if (res.status !== 200) {
        return { kind: "failed" };
      }
      try {
        const parsed = accountSchema.safeParse(await res.json());
        if (!parsed.success) {
          return { kind: "failed" };
        }
        return { kind: "found", account: parsed.data };
      } catch {
        return { kind: "failed" };
      }
    },
  };
}
