/**
 * The mock-crm HTTP client for voice-tools: `POST {CRM_URL}/lines/<lineId>/test`
 * with the internal key, behind `run_line_diagnostics`. A 200 carries the
 * line test result and is the only answer. Any other status, a network
 * error, a missing key or an invalid body is `{ ok: false }`, and the tool
 * turns that into the sentence the model can say aloud.
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

export interface CrmClient {
  /** `POST /lines/<lineId>/test`; `ok` is false for every non-answer. */
  testLine(lineId: string): Promise<LineTestOutcome>;
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
  };
}
