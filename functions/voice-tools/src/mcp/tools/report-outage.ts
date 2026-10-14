/**
 * `report_outage` — records that the caller's own connection is out or
 * degraded on the postcode's `AreaIncident` actor (card T19, ADR-004). The
 * tool acts on the session and nothing else: the postcode and the account
 * come from the session, never from the model. It needs `number_match`,
 * `attested` or `verified` identity plus an account and a postcode in the
 * session; anything less answers `{ needs_verification: true }`, a normal
 * result, not an error (ADR-013).
 *
 * The threshold, window and ETA come from the flags (`../flags.ts`), which
 * never fail the call — a KV wobble just means the defaults. The report
 * itself gets 3,000 ms, because during an outage it can queue behind other
 * reporters and the actor's own alarm (the alarm's KV publish is about
 * 1.4 s). `report` never waits for KV: the alarm publishes the status
 * (ADR-005). A timeout or any other failure is one sayable sentence with
 * `isError: true`, never a made-up count.
 */

import { z } from "zod";

import { TIMED_OUT, TIMEOUTS } from "../../config.js";
import { readFlags } from "../../flags.js";
import type { ToolContext, ToolResult } from "../server.js";

export const reportOutageInput = z.strictObject({
  symptom: z.enum(["no_connection", "slow", "intermittent", "other"], {
    error: "must be one of no_connection, slow, intermittent or other",
  }),
});

export const REPORT_OUTAGE_NAME = "report_outage";

const DESCRIPTION =
  "Reports that the caller's own internet is down completely, so the engineers can see that " +
  "their area is affected. Use it only when the caller says their service is down completely " +
  "and has agreed to report it as an outage. Never use it for slow or dropping internet. It " +
  "answers whether the report was counted, whether it declared an incident, and the estimated " +
  "fix time. Only a caller recognised by phone number or verified can report. If the result " +
  "says needs_verification, verify the caller first.";

const FAILURE_SENTENCE = "The outage reporting system is not responding right now.";

function json(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(): ToolResult {
  return { content: [{ type: "text", text: FAILURE_SENTENCE }], isError: true };
}

/** Identity levels that may report an outage without verifying first (docs/ARCHITECTURE.md, Identity levels). */
function mayReport(identity: string): boolean {
  return identity === "number_match" || identity === "attested" || identity === "verified";
}

export async function handleReportOutage(
  context: ToolContext,
  args: unknown,
): Promise<ToolResult> {
  const { symptom } = args as z.infer<typeof reportOutageInput>;
  const { deps, session, timings } = context;
  if (!mayReport(session.identity) || session.accountNumber === null || session.postcode === null) {
    return json({ needs_verification: true });
  }

  const flags = await readFlags(deps, timings);
  try {
    const reported = await timings.time("actor", () =>
      deps.timeout(
        () =>
          deps.areas.report(session.postcode as string, {
            accountId: session.accountNumber as string,
            symptom,
            nowMs: deps.now(),
            threshold: flags.incidentThreshold,
            windowMs: flags.reportWindowSecs * 1_000,
            etaMs: flags.incidentEtaMinutes * 60_000,
            traceId: session.traceId,
          }),
        TIMEOUTS.areaReportMs,
      ),
    );
    if (reported === TIMED_OUT) {
      return failure();
    }
    // T26: the model never hears the raw count — saying "three reports make
    // an outage" to a caller confused it. The count and the threshold stay
    // on the AreaIncident actor's `report` log line for the demo and T13's
    // evidence.
    return json({
      counted: reported.counted,
      incident_declared: reported.incidentDeclared,
      incident_id: reported.incidentId,
      eta: reported.eta,
    });
  } catch {
    return failure();
  }
}

export const reportOutageTool = {
  name: REPORT_OUTAGE_NAME,
  description: DESCRIPTION,
  inputSchema: reportOutageInput,
  handle: handleReportOutage,
};
