import { z } from "zod";

import { findAccountByLineId } from "../domain/fixtures.js";
import type { LineTestResult } from "../domain/line-test.js";
import { lineTestDelayMs, runLineTest } from "../domain/line-test.js";

const lineIdSchema = z.string().regex(/^LN-\d{6}$/);

export interface LineTestDeps {
  random: () => number;
  delay: (ms: number) => Promise<void>;
}

export interface LinesOutcome {
  status: number;
  body: Record<string, unknown>;
  /** Owning account for the masked `account` log field; null on 404. */
  accountNumber: string | null;
}

/**
 * `POST /lines/<lineId>/test`: the owning account's line profile decides the
 * result (`../domain/line-test.ts`). The simulated delay is injected through
 * `deps.delay`, so tests do not wait. Unknown or malformed lines 404 fast,
 * before any waiting.
 */
export async function runLineTestRoute(
  lineId: string,
  deps: LineTestDeps,
): Promise<LinesOutcome> {
  const parsed = lineIdSchema.safeParse(lineId);
  if (!parsed.success) {
    return { status: 404, body: { error: "not_found" }, accountNumber: null };
  }
  const account = findAccountByLineId(parsed.data);
  if (account === null) {
    return { status: 404, body: { error: "not_found" }, accountNumber: null };
  }
  await deps.delay(lineTestDelayMs(deps.random));
  const result: LineTestResult = runLineTest(account.lineProfile, deps.random);
  return {
    status: 200,
    body: { ...result },
    accountNumber: account.accountNumber,
  };
}
