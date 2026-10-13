/**
 * The mock-crm HTTP client. Only what /dv and /internal/health need:
 * `GET {CRM_URL}/customers?phone=<digits>` with the internal key. A 200
 * carries the customer, a 404 means no account has that number — both are
 * answers. Any other status, a network error or an invalid body is a failed
 * call, and the caller decides what a failure means (the race in
 * routes/dv.ts keeps waiting for the KV side).
 *
 * The internal key is read per call through `readInternalKey`: on the
 * deployed function that read joins the container's shared read (T22 — it
 * is not cut at SECRET_READ_TIMEOUT_MS anymore; the route's own lookup
 * bound covers key read plus fetch), in dev it answers null, and a null
 * key means the call is never made (mock-crm would 401, which is just
 * another failure).
 */

import { crmCustomerSchema } from "../config.js";
import type { CrmAnswer } from "../config.js";

export type CrmCallResult = { ok: true; answer: CrmAnswer } | { ok: false };

export interface CrmClient {
  /** `GET /customers?phone=<digits>`; `ok` is false for every non-answer. */
  lookupByPhone(digits: string): Promise<CrmCallResult>;
}

export function createCrmClient(input: {
  crmUrl: string;
  readInternalKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): CrmClient {
  const doFetch = input.fetchImpl ?? fetch;
  return {
    async lookupByPhone(digits: string): Promise<CrmCallResult> {
      const internalKey = await input.readInternalKey();
      if (internalKey === null) {
        return { ok: false };
      }
      const url = `${input.crmUrl.replace(/\/+$/, "")}/customers?phone=${encodeURIComponent(digits)}`;
      let res: Response;
      try {
        res = await doFetch(url, { headers: { "x-internal-key": internalKey } });
      } catch {
        return { ok: false };
      }
      if (res.status === 404) {
        return { ok: true, answer: { kind: "not_found" } };
      }
      if (res.status !== 200) {
        return { ok: false };
      }
      try {
        const parsed = crmCustomerSchema.safeParse(await res.json());
        if (!parsed.success) {
          return { ok: false };
        }
        return { ok: true, answer: { kind: "customer", customer: parsed.data } };
      } catch {
        return { ok: false };
      }
    },
  };
}
