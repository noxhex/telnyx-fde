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

import type { ReportResult } from "../domain/area-incident.js";
import type { AreaReportInput } from "../actors/area-incident.js";

export interface AreasClient {
  /** Record one outage report on the postcode's actor; no KV write happens on this path (ADR-005). */
  report(postcode: string, input: AreaReportInput): Promise<ReportResult>;
}

interface AreaIncidentRpc {
  report(input: AreaReportInput): Promise<ReportResult>;
}

export function createAreasClient(namespace: ActorNamespace): AreasClient {
  const stubFor = (postcode: string): AreaIncidentRpc =>
    namespace.idFromName(postcode) as unknown as AreaIncidentRpc;
  return {
    report(postcode, input) {
      return stubFor(postcode).report(input);
    },
  };
}
