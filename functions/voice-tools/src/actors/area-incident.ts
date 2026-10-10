/**
 * AreaIncident actor — thin adapter over `../domain/area-incident.ts`
 * (ADR-004, ADR-005). One instance per postcode; the instance name is the
 * postcode. The domain state lives as one JSON document under the storage
 * key `state`; a small sidecar document under `meta` holds the housekeeping
 * the alarm needs: the last `windowMs` seen (pruning), the count of
 * consecutive publish failures (the retry backoff), the trace id of the
 * change that set the current outbox (publish logging) and the deadline of
 * a due confirming write.
 *
 * Publishing (ADR-005's outbox): every method that can set the outbox saves
 * the state first — the decision is durable before any KV write — and then
 * tries to publish with a 300 ms budget. A success is confirmed with
 * `markPublished`; a failure is logged as `publish_retry` and retried by the
 * alarm, first after 5 s, then 15 s, then every 60 s, until it lands. The
 * ladder only moves forward: a failed publish never restarts it at 5 s (a
 * success resets it). The caller always gets its result either way.
 *
 * Confirming write (ADR-015): a publish that times out has an unknown
 * outcome — it may still land on the server after a NEWER publish has
 * succeeded and cleared the outbox, leaving KV stale for good. So a timed-
 * out publish marks a confirming write due 30 s later (longer than an actor
 * method's budget, after which no in-flight write from this call can still
 * be running). The alarm then writes the then-current status again, even if
 * a newer publish succeeded in between; only that write clears the marker,
 * and a failed confirming write is retried like any publish.
 *
 * Logging: `report` and `resolve` write one `actor` line each with the
 * method, trace id, area, outcome and latency; each KV write writes a
 * `publish` (or `publish_retry`) line carrying the trace id of the change
 * that set the outbox, including writes made by the alarm.
 */

import { StatefulActor } from "@telnyx/edge-runtime";
import type { AlarmInfo, Env, KvNamespace } from "@telnyx/edge-runtime";

import { createLogger, kvKeys, maskAccount, startTimings } from "@duinvezel/shared";
import type { Fields, Timings } from "@duinvezel/shared";

import {
  currentStatus,
  initialState,
  markPublished,
  pruneReports,
  report as reportDomain,
  resolve as resolveDomain,
} from "../domain/area-incident.js";
import type {
  AreaIncidentState,
  AreaStatus,
  ReportResult,
  ResolveResult,
  Symptom,
} from "../domain/area-incident.js";

const STATE_KEY = "state";
const META_KEY = "meta";
const BRUSSELS_TZ = "Europe/Brussels";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The KV write budget for one publish. */
export const KV_PUBLISH_TIMEOUT_MS = 300;
/** Publish retry backoff: 5 s, then 15 s, then every 60 s. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;
/** A timed-out publish has landed or lost after this; confirm with a rewrite. */
export const CONFIRM_AFTER_MS = 30_000;

const logger = createLogger("voice-tools");

/** The bindings this actor relies on; declared in telnyx.toml. */
export interface AreaIncidentEnv extends Env {
  KV: KvNamespace;
}

/**
 * The `report` input RPC callers send: the domain input minus `formatEta`,
 * which cannot cross RPC (arguments must be JSON-serialisable) and is owned
 * by the actor (`formatEtaBrussels`). `traceId` joins the call's log lines.
 */
export interface AreaReportInput {
  accountId: string;
  symptom: Symptom;
  nowMs: number;
  threshold: number;
  windowMs: number;
  etaMs: number;
  traceId?: string;
}

export interface AreaResolveInput {
  nowMs: number;
  traceId?: string;
}

/** Housekeeping for the alarm; the domain state stays the doc under `state`. */
export interface AreaIncidentMeta {
  /** The `windowMs` of the most recent `report`, used for alarm pruning. */
  windowMs: number | null;
  /** Consecutive failed publishes; climbs the retry ladder, resets on success. */
  publishFailures: number;
  /** The trace id of the change that set the current outbox/status. */
  changeTraceId: string | null;
  /** When a confirming write becomes due (30 s after a timed-out publish). */
  confirmDueAtMs: number | null;
  /**
   * The status document of the newest change, kept after its publish so the
   * confirming write rewrites exactly it (a derived `currentStatus` would
   * lose the change's `updatedAt` once the outbox is cleared).
   */
  lastStatus: AreaStatus | null;
}

const INITIAL_META: AreaIncidentMeta = {
  windowMs: null,
  publishFailures: 0,
  changeTraceId: null,
  confirmDueAtMs: null,
  lastStatus: null,
};

/** What `withTimeout` rejects with; a timeout means an unknown outcome. */
class PublishTimeoutError extends Error {
  constructor() {
    super("kv_publish_timeout");
    this.name = "PublishTimeoutError";
  }
}

/**
 * `"by HH:mm today"` when `etaAt` falls on `nowMs`'s Europe/Brussels day,
 * `"by HH:mm tomorrow"` on the next. The card only specifies those two —
 * flags keep ETAs to hours — but an ETA further out (or in the past) still
 * gets an honest, unambiguous form: `"by HH:mm on YYYY-MM-DD"`.
 */
export function formatEtaBrussels(etaAt: number, nowMs: number): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: BRUSSELS_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(etaAt));
  const dayDiff = Math.round((brusselsDayMs(etaAt) - brusselsDayMs(nowMs)) / DAY_MS);
  if (dayDiff === 0) {
    return `by ${time} today`;
  }
  if (dayDiff === 1) {
    return `by ${time} tomorrow`;
  }
  const d = new Date(brusselsDayMs(etaAt));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `by ${time} on ${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The UTC instant of midnight on `ms`'s Europe/Brussels calendar day. */
function brusselsDayMs(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BRUSSELS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"));
}

/** Rejects with `PublishTimeoutError` when `promise` has not settled in `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new PublishTimeoutError());
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** The alarm delay after `failures` consecutive failed publishes. */
function retryDelayMs(failures: number): number {
  if (failures <= 1) {
    return RETRY_DELAYS_MS[0];
  }
  if (failures === 2) {
    return RETRY_DELAYS_MS[1];
  }
  return RETRY_DELAYS_MS[2];
}

export class AreaIncident extends StatefulActor<AreaIncidentEnv> {
  async report(input: AreaReportInput): Promise<ReportResult> {
    const timings = startTimings();
    try {
      const s = await this._load();
      const { state, result } = reportDomain(s, { ...input, formatEta: this._formatEta });
      await this._save(state);
      const meta = await this._loadMeta();
      meta.windowMs = input.windowMs;
      if (result.incidentDeclared) {
        meta.changeTraceId = input.traceId ?? null;
        meta.lastStatus = state.outbox;
      }
      await this._publishOutbox(state, meta);
      await this._saveMeta(meta);
      const outcome = result.incidentDeclared
        ? "declared"
        : result.counted
          ? "counted"
          : "duplicate";
      this._logCall({ method: "report", outcome, timings, traceId: input.traceId, account: input.accountId });
      return result;
    } catch (error) {
      this._logCall({ method: "report", outcome: "error", timings, traceId: input.traceId, account: input.accountId, error });
      throw error;
    }
  }

  async resolve(input: AreaResolveInput): Promise<ResolveResult> {
    const timings = startTimings();
    try {
      const s = await this._load();
      const { state, result } = resolveDomain(s, { nowMs: input.nowMs });
      if (result.resolved) {
        await this._save(state);
        const meta = await this._loadMeta();
        meta.changeTraceId = input.traceId ?? null;
        meta.lastStatus = state.outbox;
        await this._publishOutbox(state, meta);
        await this._saveMeta(meta);
      }
      this._logCall({ method: "resolve", outcome: result.resolved ? "resolved" : "unchanged", timings, traceId: input.traceId });
      return result;
    } catch (error) {
      this._logCall({ method: "resolve", outcome: "error", timings, traceId: input.traceId, error });
      throw error;
    }
  }

  /** The current area status, as call setup would read it from KV. */
  async status(): Promise<AreaStatus> {
    return currentStatus(await this._load(), this._formatEta);
  }

  /**
   * Retry a failed publish, run a due confirming write and prune reports
   * older than the last window. Delivery is at-least-once: a redelivered
   * alarm finds the outbox, the marker and the pruning already handled, and
   * changes nothing.
   */
  override async alarm(_info: AlarmInfo): Promise<void> {
    const nowMs = Date.now();
    let s = await this._load();
    const meta = await this._loadMeta();
    if (meta.windowMs !== null) {
      const pruned = pruneReports(s, { nowMs, windowMs: meta.windowMs });
      if (pruned !== s) {
        s = pruned;
        await this._save(s);
      }
    }

    const outbox = s.outbox;
    if (outbox !== null) {
      if (!(await this._tryPublish(s, outbox, meta))) {
        meta.publishFailures += 1;
        await this._saveMeta(meta);
        // The delay runs from the failure, not from when the alarm fired.
        await this.ctx.storage.setAlarm(Date.now() + retryDelayMs(meta.publishFailures));
        return;
      }
      // `_tryPublish` saved the cleared state and zeroed the ladder.
      s = markPublished(s, outbox.version);
      await this._saveMeta(meta);
    }

    if (meta.confirmDueAtMs !== null && nowMs >= meta.confirmDueAtMs) {
      // Write the then-current status again, even when a newer publish
      // already succeeded: the timed-out write may have landed after it.
      const status = meta.lastStatus ?? currentStatus(s, this._formatEta);
      const confirmed = await this._confirmWrite(s.areaCode, status, meta);
      if (confirmed) {
        meta.confirmDueAtMs = null;
        await this._saveMeta(meta);
      } else {
        meta.publishFailures += 1;
        await this._saveMeta(meta);
        // The delay runs from the failure, not from when the alarm fired.
        await this.ctx.storage.setAlarm(Date.now() + retryDelayMs(meta.publishFailures));
      }
      return;
    }

    if (meta.confirmDueAtMs !== null) {
      // The retry ladder is done but a confirming write is still coming.
      await this.ctx.storage.setAlarm(meta.confirmDueAtMs);
      return;
    }

    if (s.outbox === null && meta.publishFailures !== 0) {
      meta.publishFailures = 0;
      await this._saveMeta(meta);
    }
  }

  /**
   * Publish a pending outbox right after its decision. On failure the
   * incident stays durable, and the alarm is armed up the retry ladder from
   * wherever it stands — a failure never restarts the ladder at 5 s.
   */
  private async _publishOutbox(state: AreaIncidentState, meta: AreaIncidentMeta): Promise<void> {
    const outbox = state.outbox;
    if (outbox === null) {
      return;
    }
    if (!(await this._tryPublish(state, outbox, meta))) {
      meta.publishFailures += 1;
      await this.ctx.storage.setAlarm(Date.now() + retryDelayMs(meta.publishFailures));
    }
  }

  /**
   * One outbox publish attempt. On success the decision is confirmed with
   * `markPublished` and saved again, and `publish` is logged. On failure
   * `publish_retry` is logged; a timeout also marks the confirming write
   * due, because that write's outcome is unknown (ADR-015). Never throws.
   */
  private async _tryPublish(
    state: AreaIncidentState,
    outbox: AreaStatus,
    meta: AreaIncidentMeta,
  ): Promise<boolean> {
    const latencyMs = await this._attemptPublish(state.areaCode, outbox, meta, true);
    if (latencyMs === null) {
      return false;
    }
    const cleared = markPublished(state, outbox.version);
    if (cleared !== state) {
      await this._save(cleared);
    }
    this._logPublish("publish", state.areaCode, outbox.version, meta, latencyMs);
    return true;
  }

  /**
   * The confirming write: the then-current status, written by the alarm at
   * or after its due time. Success clears nothing but the marker (the alarm
   * does that) — there is no outbox to confirm. Never throws.
   */
  private async _confirmWrite(
    areaCode: string,
    status: AreaStatus,
    meta: AreaIncidentMeta,
  ): Promise<boolean> {
    const latencyMs = await this._attemptPublish(areaCode, status, meta, false);
    if (latencyMs === null) {
      return false;
    }
    this._logPublish("publish", areaCode, status.version, meta, latencyMs);
    return true;
  }

  /**
   * One bounded KV write of `status`. Returns the write's latency in ms on
   * success and logs `publish_retry`, returning null, on failure. When
   * `markTimeout` is set, a timeout also arms the confirming write (only
   * outbox publishes mark; a confirming write IS the correction). Success
   * resets the retry ladder.
   */
  private async _attemptPublish(
    areaCode: string,
    status: AreaStatus,
    meta: AreaIncidentMeta,
    markTimeout: boolean,
  ): Promise<number | null> {
    const timings = startTimings();
    try {
      await timings.time("kv", () =>
        withTimeout(
          this.env.KV.put(kvKeys.areaStatus(areaCode), JSON.stringify(status)),
          KV_PUBLISH_TIMEOUT_MS,
        ),
      );
    } catch (error) {
      if (markTimeout && error instanceof PublishTimeoutError) {
        meta.confirmDueAtMs = Date.now() + CONFIRM_AFTER_MS;
      }
      const fields: Fields = {
        area: areaCode,
        version: status.version,
        trace_id: meta.changeTraceId,
        error: error instanceof Error ? error.message : String(error),
        latency_ms: timings.snapshot().kv ?? timings.snapshot().total,
      };
      logger.log("warn", "publish_retry", fields);
      return null;
    }
    meta.publishFailures = 0;
    return timings.snapshot().kv ?? timings.snapshot().total;
  }

  private _logPublish(
    event: "publish",
    areaCode: string,
    version: number,
    meta: AreaIncidentMeta,
    latencyMs: number,
  ): void {
    logger.log("info", event, {
      area: areaCode,
      version,
      trace_id: meta.changeTraceId,
      latency_ms: latencyMs,
    });
  }

  /** One `actor` line per `report`/`resolve` call; errors log before the rethrow. */
  private _logCall(i: {
    method: "report" | "resolve";
    outcome: string;
    timings: Timings;
    traceId?: string;
    account?: string;
    error?: unknown;
  }): void {
    const fields: Fields = {
      actor: "AreaIncident",
      method: i.method,
      trace_id: i.traceId ?? null,
      area: this.ctx.id,
      outcome: i.outcome,
      latency_ms: i.timings.snapshot().total,
    };
    if (i.account !== undefined) {
      fields.account = maskAccount(i.account);
    }
    if (i.error !== undefined) {
      fields.error = i.error instanceof Error ? i.error.message : String(i.error);
    }
    logger.log(i.error === undefined ? "info" : "error", "actor", fields);
  }

  private readonly _formatEta = (etaAt: number): string => formatEtaBrussels(etaAt, Date.now());

  // Helpers start with "_" so the runtime never exposes them over RPC.
  private async _load(): Promise<AreaIncidentState> {
    return (await this.ctx.storage.get<AreaIncidentState>(STATE_KEY)) ?? initialState(this.ctx.id);
  }

  private async _save(s: AreaIncidentState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, s);
  }

  private async _loadMeta(): Promise<AreaIncidentMeta> {
    return (await this.ctx.storage.get<AreaIncidentMeta>(META_KEY)) ?? { ...INITIAL_META };
  }

  private async _saveMeta(meta: AreaIncidentMeta): Promise<void> {
    await this.ctx.storage.put(META_KEY, meta);
  }
}

