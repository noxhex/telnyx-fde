/**
 * `create_ticket` — creates a repair visit, a callback request or another
 * follow-up (card T19). `repair_visit` and `other` need `attested` or
 * `verified`; a `callback` is allowed for any identity (ADR-013).
 *
 * With an account in the session the ticket goes to
 * `CUSTOMER_ACCOUNT.createTicket`, idempotent per dedupe key
 * `<sid>/<category>` — a retry from Telnyx, the model or our own code can
 * never create it twice (ADR-015). The actor mints the ticket id and the
 * window.
 *
 * Without an account (a callback only) the request is written to KV under
 * `callback/<sid>` for seven days, idempotent per sid: the ticket id is
 * deterministic — `T-` plus four digits derived from the sid — so a repeat
 * for the same call produces the same id and overwrites the same key
 * without a read. The window comes from `nextWorkingDayWindow`, the same
 * helper `CustomerAccount.createTicket` uses, so both paths promise the
 * next working day between 08:00 and 12:00. The write gets 2,500 ms (a KV
 * write takes about 1.4 s — DEBUGLOG issue 11).
 *
 * A failing dependency is one sayable sentence with `isError: true`.
 */

import { z } from "zod";

import { kvKeys } from "@duinvezel/shared";

import { nextWorkingDayWindow } from "../../actors/customer-account.js";
import { CALLBACK_TTL_SEC, TIMED_OUT, TIMEOUTS } from "../../config.js";
import type { ToolContext, ToolResult } from "../server.js";

export const createTicketInput = z.strictObject({
  category: z.enum(["repair_visit", "callback", "other"], {
    error: "must be one of repair_visit, callback or other",
  }),
  summary: z.string({ error: "must be a string" }).max(300, "must be at most 300 characters"),
});

export const CREATE_TICKET_NAME = "create_ticket";

const DESCRIPTION =
  "Creates a ticket: a repair visit for a technician, a callback request, or another " +
  "follow-up. Use it when the caller needs a technician, asks to be called back, or an issue " +
  "needs a person to follow up. Repair visits and other follow-ups need a confirmed identity; " +
  "a callback request can be taken from anyone, even without verification. It answers with " +
  "the ticket id and the visit window; read both back to the caller before ending the call.";

const FAILURE_SENTENCE = "The ticket system is not responding right now.";

function json(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(): ToolResult {
  return { content: [{ type: "text", text: FAILURE_SENTENCE }], isError: true };
}

/** Identity levels that may create repair and other tickets (docs/ARCHITECTURE.md, Identity levels). */
function mayCreate(identity: string): boolean {
  return identity === "attested" || identity === "verified";
}

/**
 * The deterministic ticket id of an anonymous callback: `T-` plus four
 * digits derived from the sid (32 hex characters), so a repeat for the same
 * call gives the same id — the KV write under the same key stays idempotent
 * without a read.
 */
export function callbackTicketId(sid: string): string {
  const digits = Number.parseInt(sid.slice(0, 8), 16) % 10_000;
  return `T-${String(digits).padStart(4, "0")}`;
}

export async function handleCreateTicket(
  context: ToolContext,
  args: unknown,
): Promise<ToolResult> {
  const { category, summary } = args as z.infer<typeof createTicketInput>;
  const { deps, session, timings } = context;
  const nowMs = deps.now();

  if (category !== "callback" && !mayCreate(session.identity)) {
    return json({ needs_verification: true });
  }
  const accountNumber = session.accountNumber;
  if (accountNumber === null && category !== "callback") {
    // Only callbacks exist without an account; an identity this session
    // could not have in practice (attested without a match) still gets a
    // business answer, never an error.
    return json({ needs_verification: true });
  }

  if (accountNumber !== null) {
    // With an account the ticket lives on the account's actor, whatever the
    // category — a callback from a recognised caller is still their ticket.
    try {
      const created = await timings.time("actor", () =>
        deps.timeout(
          () =>
            deps.accounts.createTicket(
              accountNumber,
              {
                dedupeKey: `${session.sid}/${category}`,
                category,
                summary,
                nowMs,
              },
              session.traceId,
            ),
          TIMEOUTS.accountCreateTicketMs,
        ),
      );
      if (created === TIMED_OUT) {
        return failure();
      }
      return json({ ticket_id: created.ticketId, window: created.window });
    } catch {
      return failure();
    }
  }

  // Without an account: the anonymous callback request in KV, idempotent
  // per sid, kept for seven days.
  const kv = deps.kv;
  if (kv === undefined) {
    // `telnyx-edge dev` has no KV binding (DEBUGLOG issue 9); fail closed.
    return failure();
  }
  if (!Number.isFinite(nowMs)) {
    // Time inputs fail closed (AGENTS.md): a broken clock would write a
    // window like "NaN-NaN-NaN 08:00-12:00" into callback/<sid> and read it
    // back to the caller. (The actor path above needs no guard: the domain
    // rejects a non-finite nowMs and the tool answers the same sentence.)
    return failure();
  }
  const ticketId = callbackTicketId(session.sid);
  const window = nextWorkingDayWindow(nowMs);
  try {
    const written = await timings.time("kv", () =>
      deps.timeout(
        () =>
          kv.put(
            kvKeys.callback(session.sid),
            JSON.stringify({
              phone: session.callerPhone,
              summary,
              ticketId,
              window,
            }),
            { expirationTtl: CALLBACK_TTL_SEC },
          ),
        TIMEOUTS.callbackWriteMs,
      ),
    );
    if (written === TIMED_OUT) {
      return failure();
    }
    return json({ ticket_id: ticketId, window });
  } catch {
    return failure();
  }
}

export const createTicketTool = {
  name: CREATE_TICKET_NAME,
  description: DESCRIPTION,
  inputSchema: createTicketInput,
  handle: handleCreateTicket,
};
