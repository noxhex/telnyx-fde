/**
 * The AreaIncident actor client for voice-tools' own binding (T19, ADR-004).
 * One instance per postcode; the instance name is the postcode. voice-tools
 * ships the class, so this client speaks the class's own types directly.
 *
 * `report` carries the session's `traceId` inside its input, so the actor's
 * log lines — and the `publish` lines its alarm writes for an incident this
 * report declared — join the call's trace (docs/ARCHITECTURE.md,
 * Observability). The timeout is the caller's job: the card gives `report`
 * 3,000 ms because it can queue behind other reporters and the actor's own
 * alarm during an outage.
 */

import type { ActorNamespace } from "@telnyx/edge-runtime";

import type { ReportResult, ResetResult } from "../domain/area-incident.js";
import type { AreaReportInput, AreaResetInput } from "../actors/area-incident.js";

export interface AreasClient {
  /** Record one outage report on the postcode's actor; no KV write happens on this path (ADR-005). */
  report(postcode: string, input: AreaReportInput): Promise<ReportResult>;
  /** The demo reset (T15): drop every report and any incident; the alarm publishes the fresh `ok` status. */
  reset(postcode: string, input: AreaResetInput): Promise<ResetResult>;
}

interface AreaIncidentRpc {
  report(input: AreaReportInput): Promise<ReportResult>;
  reset(input: AreaResetInput): Promise<ResetResult>;
}

export function createAreasClient(namespace: ActorNamespace): AreasClient {
  const stubFor = (postcode: string): AreaIncidentRpc =>
    namespace.idFromName(postcode) as unknown as AreaIncidentRpc;
  return {
    report(postcode, input) {
      return stubFor(postcode).report(input);
    },
    reset(postcode, input) {
      return stubFor(postcode).reset(input);
    },
  };
}
