/**
 * `verify_account` — the state-changing tool behind the Verify account node
 * (card T19, ADR-013). Any identity may call it. The account comes from
 * `account_number` when the model passes one (full mode) and otherwise from
 * the session's matched account (postcode mode); with neither, the answer
 * is `account_number_needed` and nothing is called or counted.
 *
 * Flow (each hop inside its own timeout from the card's table, every actor
 * call carrying the session's `traceId`):
 *   1. While the session's verify lock is active, answer locked — no CRM
 *      call and no actor call.
 *   2. `GET /accounts/<number>` on mock-crm. A 404 means the account does
 *      not exist: the failure is counted on the session
 *      (`SESSION.recordVerifyFailure`, which locks after three), and no
 *      `CustomerAccount` actor is ever created for a guessed number
 *      (ADR-006).
 *   3. A found account goes to `CUSTOMER_ACCOUNT.verify`, which checks the
 *      details against the CRM's own values and enforces the per-account
 *      lockout.
 *   4. On `ok`, `SESSION.setVerified` promotes the session; the answer
 *      carries the caller's first name and the area status from
 *      `../area-status.ts` (T09). A failed area read never fails a
 *      verification that already succeeded — the area fields just degrade,
 *      the way `/dv` degrades its outage notice.
 *
 * Expected business outcomes (locked, wrong details, `attempts_left`) are
 * normal results. A failing dependency is one sayable sentence with
 * `isError: true`.
 */

import { z } from "zod";

import { areaNameForPostcode } from "@duinvezel/shared";

import { readAreaStatus } from "../../area-status.js";
import type { CrmAccount } from "../../clients/crm.js";
import { TIMED_OUT, TIMEOUTS } from "../../config.js";
import type { ToolContext, ToolResult } from "../server.js";

export const verifyAccountInput = z.object({
  postcode: z.string().regex(/^\d{4}$/, "postcode must be exactly four digits"),
  account_number: z.string().optional(),
});

export const VERIFY_ACCOUNT_NAME = "verify_account";

const DESCRIPTION =
  "Verifies the caller's identity before anything that touches their account, such as " +
  "diagnostics or a repair ticket. Use it as soon as an unverified caller needs an account " +
  "action. Ask for their four-digit postcode; ask for the account number as well only when " +
  "the caller was not recognised by phone number. It answers whether the caller is verified, " +
  "how many attempts remain, or how many minutes verification is locked after too many wrong " +
  "answers. Never read out full account details yourself.";

const FAILURE_SENTENCE = "The verification system is not responding right now.";

const MINUTE_MS = 60_000;

function json(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(): ToolResult {
  return { content: [{ type: "text", text: FAILURE_SENTENCE }], isError: true };
}

/** The locked answer; `locked_minutes` is the time left on the lock, rounded up to whole minutes. */
function lockedResult(lockedUntil: number, nowMs: number): ToolResult {
  return json({
    verified: false,
    locked: true,
    locked_minutes: Math.max(1, Math.ceil((lockedUntil - nowMs) / MINUTE_MS)),
  });
}

/** The verified answer, with the area status woven in when the postcode is one of the five. */
async function verifiedResult(
  context: ToolContext,
  account: CrmAccount,
): Promise<ToolResult> {
  const areaName = areaNameForPostcode(account.postcode);
  let areaOutage = false;
  let outageEta: string | null = null;
  if (areaName !== null) {
    const read = await readAreaStatus(context.deps, context.timings, account.postcode);
    if (read.outcome === "ok" && read.status !== null && read.status.state === "outage") {
      areaOutage = true;
      outageEta = read.status.eta;
    }
  }
  return json({
    verified: true,
    first_name: account.firstName,
    area_name: areaName,
    area_outage: areaOutage,
    outage_eta: outageEta,
  });
}

export async function handleVerifyAccount(
  context: ToolContext,
  args: unknown,
): Promise<ToolResult> {
  const { postcode, account_number: submitted } = args as z.infer<typeof verifyAccountInput>;
  const { deps, session, timings } = context;
  const nowMs = deps.now();

  // 1. The session's own verify lock refuses first, without any call.
  const sessionLock = session.verify.lockedUntil;
  if (sessionLock !== null && sessionLock > nowMs) {
    return lockedResult(sessionLock, nowMs);
  }

  // 2. The account: full mode from the model, postcode mode from the session.
  const accountNumber = submitted ?? session.accountNumber;
  if (accountNumber === null) {
    return json({ verified: false, account_number_needed: true });
  }

  // 3. The CRM decides whether the account exists.
  let account: CrmAccount;
  try {
    const lookedUp = await timings.time("crm", () =>
      deps.timeout(() => deps.crm.getAccount(accountNumber), TIMEOUTS.crmAccountMs),
    );
    if (lookedUp === TIMED_OUT || lookedUp.kind === "failed") {
      return failure();
    }
    if (lookedUp.kind === "not_found") {
      // Guessing a number that does not exist counts on the session, never
      // on an actor — none is created (ADR-006).
      try {
        const counted = await timings.time("actor", () =>
          deps.timeout(
            () =>
              deps.sessions.recordVerifyFailure(session.sid, { nowMs }, session.traceId),
            TIMEOUTS.sessionRecordVerifyFailureMs,
          ),
        );
        if (counted === TIMED_OUT || counted.outcome === "missing") {
          return failure();
        }
        if (counted.outcome === "locked") {
          return counted.lockedUntil === null
            ? failure()
            : lockedResult(counted.lockedUntil, nowMs);
        }
        return json({ verified: false, attempts_left: counted.attemptsLeft });
      } catch {
        return failure();
      }
    }
    account = lookedUp.account;
  } catch {
    return failure();
  }

  // 4. The account's own actor checks the details and the lockout.
  let outcome: "ok" | "wrong" | "locked";
  let attemptsLeft: number;
  let actorLock: number | null;
  try {
    const checked = await timings.time("actor", () =>
      deps.timeout(
        () =>
          deps.accounts.verify(
            account.accountNumber,
            {
              mode: submitted !== undefined ? "full" : "postcode",
              submitted: {
                postcode,
                ...(submitted !== undefined ? { accountNumber: submitted } : {}),
              },
              expected: { postcode: account.postcode, accountNumber: account.accountNumber },
              nowMs,
            },
            session.traceId,
          ),
        TIMEOUTS.accountVerifyMs,
      ),
    );
    if (checked === TIMED_OUT) {
      return failure();
    }
    outcome = checked.outcome;
    attemptsLeft = checked.attemptsLeft;
    actorLock = checked.lockedUntil;
  } catch {
    return failure();
  }
  if (outcome === "locked") {
    return actorLock === null ? failure() : lockedResult(actorLock, nowMs);
  }
  if (outcome === "wrong") {
    return json({ verified: false, attempts_left: attemptsLeft });
  }

  // 5. Promote the session; a session lock appearing here wins over the ok.
  try {
    const promoted = await timings.time("actor", () =>
      deps.timeout(
        () =>
          deps.sessions.setVerified(
            session.sid,
            {
              accountNumber: account.accountNumber,
              postcode: account.postcode,
              lineId: account.lineId,
              nowMs,
            },
            session.traceId,
          ),
        TIMEOUTS.sessionSetVerifiedMs,
      ),
    );
    if (promoted === TIMED_OUT || promoted.outcome === "missing") {
      return failure();
    }
    if (promoted.outcome === "locked") {
      return promoted.lockedUntil === null
        ? failure()
        : lockedResult(promoted.lockedUntil, nowMs);
    }
  } catch {
    return failure();
  }

  return verifiedResult(context, account);
}

export const verifyAccountTool = {
  name: VERIFY_ACCOUNT_NAME,
  description: DESCRIPTION,
  inputSchema: verifyAccountInput,
  handle: handleVerifyAccount,
};
