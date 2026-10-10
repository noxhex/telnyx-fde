/**
 * AreaIncident actor — thin adapter over `../domain/area-incident.ts`
 * (ADR-004, ADR-005). One instance per postcode; the instance name is the
 * postcode. The domain state lives as one JSON document under the storage
 * key `state`; a small sidecar document under `meta` holds the housekeeping
 * the alarm needs (the last `windowMs` seen, for pruning, and the count of
 * consecutive publish failures, for the retry backoff).
 *
 * Publishing (ADR-005's outbox): every method that can set the outbox saves
 * the state first — the decision is durable before any KV write — and then
 * tries to publish with a 300 ms budget. A success is confirmed with
 * `markPublished`; a failure is logged as `publish_retry` and retried by the
 * alarm, first after 5 s, then 15 s, then every 60 s, until it lands. The
 * caller always gets its result either way.
 *
 * A publish that loses its 300 ms race can still land on the server
 * afterwards. It writes the same value as the retry that follows, and KV
 * readers tolerate a beat of staleness (ADR-005), so this is accepted.
 */

import { StatefulActor } from "@telnyx/edge-runtime";
import type { AlarmInfo, Env, KvNamespace } from "@telnyx/edge-runtime";

import { createLogger, kvKeys } from "@duinvezel/shared";

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

const logger = createLogger("voice-tools");

/** The bindings this actor relies on; declared in telnyx.toml. */
export interface AreaIncidentEnv extends Env {
  KV: KvNamespace;
}

/**
 * The `report` input RPC callers send: the domain input minus `formatEta`,
 * which cannot cross RPC (arguments must be JSON-serialisable) and is owned
 * by the actor (`formatEtaBrussels`).
 */
export interface AreaReportInput {
  accountId: string;
  symptom: Symptom;
  nowMs: number;
  threshold: number;
  windowMs: number;
  etaMs: number;
}

/** Housekeeping for the alarm; the domain state stays the doc under `state`. */
interface AreaIncidentMeta {
  /** The `windowMs` of the most recent `report`, used for alarm pruning. */
  windowMs: number | null;
  /** Consecutive failed publishes of the current outbox. */
  publishFailures: number;
}

const INITIAL_META: AreaIncidentMeta = { windowMs: null, publishFailures: 0 };

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

/** Rejects with `kv_publish_timeout` when `promise` has not settled in `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error("kv_publish_timeout"));
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
    const s = await this._load();
    const { state, result } = reportDomain(s, { ...input, formatEta: this._formatEta });
    await this._save(state);
    const meta = await this._loadMeta();
    meta.windowMs = input.windowMs;
    await this._afterDecision(state, meta);
    return result;
  }

  async resolve(input: { nowMs: number }): Promise<ResolveResult> {
    const s = await this._load();
    const { state, result } = resolveDomain(s, input);
    if (!result.resolved) {
      return result;
    }
    await this._save(state);
    const meta = await this._loadMeta();
    await this._afterDecision(state, meta);
    return result;
  }

  /** The current area status, as call setup would read it from KV. */
  async status(): Promise<AreaStatus> {
    return currentStatus(await this._load(), this._formatEta);
  }

  /**
   * Retry a failed publish and prune reports older than the last window.
   * Delivery is at-least-once: a redelivered alarm finds the outbox cleared
   * and pruning already done, and changes nothing.
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
    if (s.outbox === null) {
      if (meta.publishFailures !== 0) {
        meta.publishFailures = 0;
        await this._saveMeta(meta);
      }
      return;
    }
    const published = await this._tryPublish(s, s.outbox, meta);
    if (published) {
      // `_tryPublish` zeroed the in-memory counter; persist it.
      await this._saveMeta(meta);
      return;
    }
    meta.publishFailures += 1;
    await this._saveMeta(meta);
    await this.ctx.storage.setAlarm(nowMs + retryDelayMs(meta.publishFailures));
  }

  /**
   * Publish a pending outbox. On success the decision is confirmed with
   * `markPublished` and saved again; on failure the incident stays durable,
   * `publish_retry` is logged and the alarm takes over.
   */
  private async _afterDecision(
    state: AreaIncidentState,
    meta: AreaIncidentMeta,
  ): Promise<void> {
    if (state.outbox !== null && !(await this._tryPublish(state, state.outbox, meta))) {
      meta.publishFailures = 1;
      await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAYS_MS[0]);
    }
    await this._saveMeta(meta);
  }

  /** One bounded publish attempt; true on success. Never throws. */
  private async _tryPublish(
    state: AreaIncidentState,
    outbox: AreaStatus,
    meta: AreaIncidentMeta,
  ): Promise<boolean> {
    try {
      await withTimeout(
        this.env.KV.put(kvKeys.areaStatus(state.areaCode), JSON.stringify(outbox)),
        KV_PUBLISH_TIMEOUT_MS,
      );
    } catch (error) {
      logger.log("warn", "publish_retry", {
        area: state.areaCode,
        version: outbox.version,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const cleared = markPublished(state, outbox.version);
    if (cleared !== state) {
      await this._save(cleared);
    }
    meta.publishFailures = 0;
    return true;
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
