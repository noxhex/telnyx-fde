/**
 * AreaIncident domain — the pure rules behind the per-postcode actor
 * (ADR-004): outage reports inside a sliding window with per-account
 * dedupe, the once-only transition from `ok` to `outage`, and the outbox
 * status the actor publishes to the KV read model (ADR-005).
 *
 * Everything here is pure: state and input in, new state and a result out.
 * No clock, no I/O, no randomness — callers inject `nowMs` and `formatEta`.
 * Time inputs fail closed: a non-finite `nowMs`, `windowMs` or `etaMs`, or a
 * `threshold` that is not a positive whole number, throws a RangeError
 * instead of producing a decision on a broken clock (AGENTS.md, Time inputs
 * fail closed).
 */

export type Symptom = "no_connection" | "slow" | "intermittent" | "other";

/** The area status published to KV and served to call setup (ADR-005). */
export interface AreaStatus {
  state: "ok" | "outage";
  incidentId: string | null;
  /** Speakable ETA, for example "by 18:00 today"; null while ok. */
  eta: string | null;
  version: number;
  updatedAt: number;
}

export interface AreaIncidentState {
  v: 1;
  areaCode: string;
  status: "ok" | "outage";
  /** Reports in the sliding window, keyed by account number. */
  reports: Record<string, { at: number; symptom: Symptom }>;
  /** `reporters` is the distinct-reporter count at declaration time. */
  incident: { id: string; declaredAt: number; etaAt: number; reporters: number } | null;
  version: number;
  /** The newest status, waiting to be published to KV; null once published. */
  outbox: AreaStatus | null;
}

export interface ReportInput {
  accountId: string;
  symptom: Symptom;
  nowMs: number;
  threshold: number;
  windowMs: number;
  etaMs: number;
  formatEta: (etaAt: number) => string;
}

export interface ReportResult {
  reportsInWindow: number;
  threshold: number;
  /** False when this account already had a report in the window. */
  counted: boolean;
  /** True for exactly the one report that declares the incident. */
  incidentDeclared: boolean;
  incidentId: string | null;
  eta: string | null;
}

export interface ResolveResult {
  resolved: boolean;
  incidentId: string | null;
}

export function initialState(areaCode: string): AreaIncidentState {
  return {
    v: 1,
    areaCode,
    status: "ok",
    reports: {},
    incident: null,
    version: 0,
    outbox: null,
  };
}

function requireFiniteMs(fn: string, field: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${fn}: ${field} must be a finite number, got ${String(value)}`);
  }
}

function requirePositiveInt(fn: string, field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${fn}: ${field} must be a positive whole number, got ${String(value)}`);
  }
}

/** Reports strictly older than the window drop out; one exactly `windowMs` old still counts. */
function pruneWindow(
  reports: AreaIncidentState["reports"],
  nowMs: number,
  windowMs: number,
): AreaIncidentState["reports"] {
  const fresh: AreaIncidentState["reports"] = {};
  for (const [accountId, r] of Object.entries(reports)) {
    if (nowMs - r.at <= windowMs) {
      fresh[accountId] = r;
    }
  }
  return fresh;
}

/** `INC-<area>-<UTC yyyyMMddHHmm>`, for example `INC-8630-202610101412`. */
function incidentId(areaCode: string, nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes());
  return `INC-${areaCode}-${stamp}`;
}

/**
 * Record one outage report. Reports strictly older than `windowMs` are
 * dropped first, so a report exactly `windowMs` old still counts.
 * A repeat report from the same account refreshes its timestamp and symptom
 * but is not counted again. While the area is `ok`, the report that brings
 * the distinct reporters in the window to `threshold` declares the incident:
 * the status becomes `outage`, the version increments and the outbox is set.
 * During an outage further reports are counted and stored but never declare
 * again.
 */
export function report(
  s: AreaIncidentState,
  i: ReportInput,
): { state: AreaIncidentState; result: ReportResult } {
  requireFiniteMs("report", "nowMs", i.nowMs);
  requireFiniteMs("report", "windowMs", i.windowMs);
  requireFiniteMs("report", "etaMs", i.etaMs);
  requirePositiveInt("report", "threshold", i.threshold);

  const fresh = pruneWindow(s.reports, i.nowMs, i.windowMs);
  const counted = !(i.accountId in fresh);
  const reports = { ...fresh, [i.accountId]: { at: i.nowMs, symptom: i.symptom } };
  const reportsInWindow = Object.keys(reports).length;

  if (s.status === "ok" && reportsInWindow >= i.threshold) {
    const id = incidentId(s.areaCode, i.nowMs);
    const etaAt = i.nowMs + i.etaMs;
    const version = s.version + 1;
    const eta = i.formatEta(etaAt);
    const state: AreaIncidentState = {
      ...s,
      status: "outage",
      reports,
      incident: { id, declaredAt: i.nowMs, etaAt, reporters: reportsInWindow },
      version,
      outbox: { state: "outage", incidentId: id, eta, version, updatedAt: i.nowMs },
    };
    return {
      state,
      result: {
        reportsInWindow,
        threshold: i.threshold,
        counted,
        incidentDeclared: true,
        incidentId: id,
        eta,
      },
    };
  }

  if (s.incident !== null) {
    return {
      state: { ...s, reports },
      result: {
        reportsInWindow,
        threshold: i.threshold,
        counted,
        incidentDeclared: false,
        incidentId: s.incident.id,
        eta: i.formatEta(s.incident.etaAt),
      },
    };
  }

  return {
    state: { ...s, reports },
    result: {
      reportsInWindow,
      threshold: i.threshold,
      counted,
      incidentDeclared: false,
      incidentId: null,
      eta: null,
    },
  };
}

/**
 * Resolve the current incident: back to `ok`, reports and incident cleared,
 * version incremented and the outbox set. Resolving an area that is already
 * `ok` changes nothing (the same state object comes back) and reports
 * `resolved: false`.
 */
export function resolve(
  s: AreaIncidentState,
  i: { nowMs: number },
): { state: AreaIncidentState; result: ResolveResult } {
  requireFiniteMs("resolve", "nowMs", i.nowMs);
  if (s.status === "ok") {
    return { state: s, result: { resolved: false, incidentId: null } };
  }
  const version = s.version + 1;
  const state: AreaIncidentState = {
    ...s,
    status: "ok",
    reports: {},
    incident: null,
    version,
    outbox: { state: "ok", incidentId: null, eta: null, version, updatedAt: i.nowMs },
  };
  return { state, result: { resolved: true, incidentId: s.incident?.id ?? null } };
}

/**
 * Clear the outbox after a successful publish, but only when the outbox
 * still holds the version that was published — an older publish finishing
 * late must not clear a newer status. Returns the same object when nothing
 * changes.
 */
export function markPublished(s: AreaIncidentState, version: number): AreaIncidentState {
  if (s.outbox === null || s.outbox.version !== version) {
    return s;
  }
  return { ...s, outbox: null };
}

/**
 * The current area status. A pending outbox is the newest durable decision,
 * so it is returned as-is; otherwise the status is derived from the stored
 * incident (or `ok` with `updatedAt` 0 for an area that never had one, or
 * whose resolve was already published).
 */
export function currentStatus(
  s: AreaIncidentState,
  formatEta: (etaAt: number) => string,
): AreaStatus {
  if (s.outbox !== null) {
    return s.outbox;
  }
  if (s.incident !== null) {
    return {
      state: "outage",
      incidentId: s.incident.id,
      eta: formatEta(s.incident.etaAt),
      version: s.version,
      updatedAt: s.incident.declaredAt,
    };
  }
  return { state: "ok", incidentId: null, eta: null, version: s.version, updatedAt: 0 };
}

/**
 * Drop reports older than `windowMs` without recording anything new — the
 * alarm's housekeeping. Returns the same object when nothing is pruned, so
 * the adapter can skip the write.
 */
export function pruneReports(
  s: AreaIncidentState,
  i: { nowMs: number; windowMs: number },
): AreaIncidentState {
  requireFiniteMs("pruneReports", "nowMs", i.nowMs);
  requireFiniteMs("pruneReports", "windowMs", i.windowMs);
  const fresh = pruneWindow(s.reports, i.nowMs, i.windowMs);
  if (Object.keys(fresh).length === Object.keys(s.reports).length) {
    return s;
  }
  return { ...s, reports: fresh };
}
