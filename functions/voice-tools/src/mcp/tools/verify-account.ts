/**
 * `verify_account` — the state-changing tool behind the Verify account node
 * (card T19, ADR-013). Any identity may call it. The account comes from
 * `account_number` when the model passes one (full mode) and otherwise from
 * the session's matched account (postcode mode); with neither, the answer
 * is `account_number_needed` and nothing is called or counted.
 *
 * Spoken forms are cleaned before anything uses them: the account number is
 * upper-cased with every non-alphanumeric dropped, and `DV` plus six digits
 * or six digits alone becomes `DV-` and the digits (mock-crm's fixture
 * format); the postcode is cleaned the same way with a leading `B` dropped.
 * A value that does not clean answers `account_number_unclear` or
 * `postcode_unclear` — expected outcomes on a phone line, never counted
 * against the caller, so a speech-recognition slip can never lock anyone
 * out. Only the cleaned values go to the CRM, the actor and the session.
 *
 * Flow (each hop inside its own timeout from the card's table, every actor
 * call carrying the session's `traceId`):
 *   1. While the session's verify lock is active, answer locked — no CRM
 *      call and no actor call.
 *   2. Clean the account number, choose the account, clean the postcode.
 *   3. `GET /accounts/<number>` on mock-crm. A 404 means the account does
 *      not exist: the failure is counted on the session
 *      (`SESSION.recordVerifyFailure`, which locks after three), and no
 *      `CustomerAccount` actor is ever created for a guessed number
 *      (ADR-006).
 *   4. A found account goes to `CUSTOMER_ACCOUNT.verify`, which checks the
 *      details against the CRM's own values and enforces the per-account
 *      lockout. The `wrong` that locks the account answers the locked
 *      result rounded up from the lock end the actor returned.
 *   5. On `ok`, `SESSION.setVerified` promotes the session; the answer
 *      carries the caller's first name and the area status from
 *      `../area-status.ts` (T09). A failed area read never fails a
 *      verification that already succeeded — the area fields just degrade,
 *      the way `/dv` degrades its outage notice.
 *
 * Expected business outcomes (locked, wrong details, unclear values,
 * `attempts_left`) are normal results. A failing dependency is one sayable
 * sentence with `isError: true`.
 */

import { z } from "zod";

import { areaNameForPostcode } from "@duinvezel/shared";

import { readAreaStatus } from "../../area-status.js";
import type { CrmAccount } from "../../clients/crm.js";
import { TIMED_OUT, TIMEOUTS } from "../../config.js";
import type { ToolContext, ToolResult } from "../server.js";

/**
 * A JSON number becomes its string as JavaScript writes it, before any other
 * check (T10 follow-up: the model, and MCP Inspector's `--tool-arg`, may send
 * `8630` where the tool expects `"8630"`). After the conversion the value
 * takes exactly the path the same text takes as a string. Every other type
 * stays untouched, so it fails the string check with "must be a string".
 * `z.preprocess` publishes the output side, so `tools/list` still shows the
 * arguments as plain strings.
 */
function numberToString(value: unknown): unknown {
  return typeof value === "number" ? String(value) : value;
}

export const verifyAccountInput = z.strictObject({
  postcode: z.preprocess(
    numberToString,
    z
      .string({ error: "must be a string" })
      .max(32, "must be at most 32 characters")
      .describe(
        "The caller's postcode. Expected format: four digits; spoken forms such as \"86 30\" or \"B-8630\" are cleaned by the tool.",
      ),
  ),
  account_number: z.preprocess(
    numberToString,
    z
      .string({ error: "must be a string" })
      .max(32, "must be at most 32 characters")
      .describe(
        "The caller's account number. Expected format: DV- followed by six digits; spoken forms such as \"dv 100001\" or the six digits alone are cleaned by the tool.",
      ),
  ).optional(),
});

export const VERIFY_ACCOUNT_NAME = "verify_account";

const DESCRIPTION =
  "Verifies the caller's identity before anything that touches their account, such as " +
  "diagnostics or a repair ticket. Use it as soon as an unverified caller needs an account " +
  "action. Ask for their four-digit postcode; ask for the account number as well only when " +
  "the caller was not recognised by phone number. It answers whether the caller is verified, " +
  "how many attempts remain, or how many minutes verification is locked after too many wrong " +
  "answers. If it answers account_number_unclear or postcode_unclear, the value was probably " +
  "misheard: ask the caller to repeat it one character at a time and try again. Never read " +
  "out full account details yourself.";

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

/**
 * The canonical account number behind a spoken form, or null when nothing
 * usable remains: upper-cased with every character that is not a letter or
 * a digit dropped, then `DV` and six digits, or six digits alone, becomes
 * `DV-` and the six digits — mock-crm's fixture format. `dv-100001`,
 * `DV 100001`, `DV100001`, `DV.100.001` and `100001` all clean to
 * `DV-100001`; a five- or seven-digit form does not clean.
 */
function cleanAccountNumber(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const prefixed = /^DV(\d{6})$/.exec(cleaned);
  if (prefixed !== null) {
    return `DV-${prefixed[1] as string}`;
  }
  return /^\d{6}$/.test(cleaned) ? `DV-${cleaned}` : null;
}

/**
 * The four digits behind a spoken postcode, or null: cleaned like the
 * account number, with a leading `B` dropped (`B-1050` → `1050`).
 */
function cleanPostcode(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digits = cleaned.startsWith("B") ? cleaned.slice(1) : cleaned;
  return /^\d{4}$/.test(digits) ? digits : null;
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
  const { postcode: rawPostcode, account_number: rawAccountNumber } =
    args as z.infer<typeof verifyAccountInput>;
  const { deps, session, timings } = context;
  const nowMs = deps.now();

  // 1. The session's own verify lock refuses first, without any call.
  const sessionLock = session.verify.lockedUntil;
  if (sessionLock !== null && sessionLock > nowMs) {
    return lockedResult(sessionLock, nowMs);
  }

  // 2. Clean the account number when the model passed one: a spoken form
  // that does not clean is an expected mishearing, never a call and never
  // counted — the model asks the caller to repeat it.
  let submitted: string | undefined;
  if (rawAccountNumber !== undefined) {
    const cleaned = cleanAccountNumber(rawAccountNumber);
    if (cleaned === null) {
      return json({ verified: false, account_number_unclear: true });
    }
    submitted = cleaned;
  }

  // 3. The account: full mode from the model, postcode mode from the session.
  const accountNumber = submitted ?? session.accountNumber;
  if (accountNumber === null) {
    return json({ verified: false, account_number_needed: true });
  }

  // 4. Clean the postcode the same way, before it touches anything.
  const postcode = cleanPostcode(rawPostcode);
  if (postcode === null) {
    return json({ verified: false, postcode_unclear: true });
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
    // The attempt that reached the limit also locked the account, and the
    // answer carries that lock's end: it answers the locked result, with
    // the minutes rounded up from the lock end the actor returned — never
    // an assumed 15.
    return actorLock === null
      ? json({ verified: false, attempts_left: attemptsLeft })
      : lockedResult(actorLock, nowMs);
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
