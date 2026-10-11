/**
 * `run_line_diagnostics` — the live line test behind the Diagnose node
 * (card T09). It acts on the caller's session and nothing else: the line id
 * comes from the session, never from the model, so a caller cannot be
 * talked into testing someone else's line. It needs `attested` or
 * `verified` identity and a line id in the session; anything less answers
 * `{ needs_verification: true }`, a normal result, not an error (ADR-013).
 *
 * The call to mock-crm (`POST /lines/<lineId>/test`) has the 5,000 ms
 * timeout from the card's table — the fake back office is slow on purpose
 * (0.8 to 1.5 s). A timeout or any other failure is one sentence the model
 * can say aloud with `isError: true`, not an invented measurement.
 */

import { z } from "zod";

import { TIMEOUTS, TIMED_OUT } from "../../config.js";
import type { ToolContext } from "../server.js";

export const runLineDiagnosticsInput = z.strictObject({});

export const RUN_LINE_DIAGNOSTICS_NAME = "run_line_diagnostics";

const DESCRIPTION =
  "Runs a live diagnostic test on the caller's own fiber line. Use it first when the caller's " +
  "internet is down, slow or unstable, before suggesting fixes. It reports the line state, the " +
  "signal strength, when the line was last seen and what to do next. Only a caller whose identity " +
  "is confirmed can use it; if the result says needs_verification, offer to verify the caller or " +
  "connect them with a person.";

const FAILURE_SENTENCE = "The diagnostics system is not responding right now.";

/** Identity levels that may run account actions (docs/ARCHITECTURE.md, Identity levels). */
function mayRunDiagnostics(identity: string): boolean {
  return identity === "attested" || identity === "verified";
}

export async function handleRunLineDiagnostics(
  context: ToolContext,
  _args: unknown,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const session = context.session;
  if (!mayRunDiagnostics(session.identity) || session.lineId === null) {
    return {
      content: [{ type: "text", text: JSON.stringify({ needs_verification: true }) }],
    };
  }
  try {
    const raced = await context.timings.time("crm", () =>
      context.deps.timeout(
        () => context.deps.crm.testLine(session.lineId as string),
        TIMEOUTS.crmLineTestMs,
      ),
    );
    if (raced === TIMED_OUT || !raced.ok) {
      return { content: [{ type: "text", text: FAILURE_SENTENCE }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(raced.result) }] };
  } catch {
    return { content: [{ type: "text", text: FAILURE_SENTENCE }], isError: true };
  }
}

export const runLineDiagnosticsTool = {
  name: RUN_LINE_DIAGNOSTICS_NAME,
  description: DESCRIPTION,
  inputSchema: runLineDiagnosticsInput,
  handle: handleRunLineDiagnostics,
};
