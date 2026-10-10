/**
 * Session actor — thin adapter over `../domain/session.ts` (ADR-019, card
 * T18). One instance per call; the instance name (`ctx.id`) is the sid, so
 * `create` takes a `CreateSessionInput` and fills `sid` from the instance
 * name. The whole session lives as one JSON document under the storage key
 * `state`. Every method loads it, runs the pure domain function, saves only
 * when the returned state is a different object, and returns — so a method
 * on a missing or expired session writes nothing, and a guessed sid leaves
 * no state behind.
 *
 * The alarm deletes everything with `deleteAll()` once the stored session
 * has expired, re-arms itself to `expiresAt` when the stored session is
 * live again (one created again after an expiry) and does nothing when
 * there is no state, so it is safe to run twice.
 *
 * Logging: `create`, `markDisclosure`, `setVerified` and
 * `recordVerifyFailure` each write one `actor` line with the method, the
 * trace id (the input's for `create`; the `traceId` argument, else the
 * stored session's, else `null` for the others — `/tools/disclosure` knows
 * only the sid), the sid, the session's account masked (or `null` without
 * one), the outcome and the latency. A method that throws logs outcome
 * `"error"` and rethrows. `get` writes no line, like
 * `CustomerAccount.snapshot`. No line holds the caller's phone number.
 */

import { StatefulActor } from "@telnyx/edge-runtime";
import type { AlarmInfo } from "@telnyx/edge-runtime";

import { createLogger, maskAccount, startTimings } from "@duinvezel/shared";
import type {
  CreateSessionInput,
  CreateSessionResult,
  DisclosureResult,
  Level,
  SessionDoc,
  SetVerifiedResult,
  Timings,
  VerifyFailureResult,
} from "@duinvezel/shared";

import {
  create as createDomain,
  get as getDomain,
  isLive,
  markDisclosure as markDisclosureDomain,
  recordVerifyFailure as recordVerifyFailureDomain,
  setVerified as setVerifiedDomain,
} from "../domain/session.js";

const STATE_KEY = "state";
const ACTOR_NAME = "Session";

const logger = createLogger("voice-tools");

/** The `setVerified` input RPC callers send. */
export interface SetVerifiedInput {
  accountNumber: string;
  postcode: string;
  lineId: string;
  nowMs: number;
}

/** The `recordVerifyFailure` input RPC callers send. */
export interface RecordVerifyFailureInput {
  nowMs: number;
  maxFailures?: number;
  lockMs?: number;
}

export class Session extends StatefulActor {
  async create(input: CreateSessionInput): Promise<CreateSessionResult> {
    const timings = startTimings();
    let stored: SessionDoc | null = null;
    try {
      stored = await timings.time("actor", () => this._load());
      const { state, result } = createDomain(stored, {
        ...input,
        sid: this._instanceName(),
      });
      if (state !== stored) {
        await timings.time("actor", () => this._save(state));
        // The session dies at expiresAt; the alarm deletes the state.
        await timings.time("actor", () => this.ctx.storage.setAlarm(state.expiresAt));
      }
      this._log(
        "info",
        "create",
        input.traceId,
        result.created ? "created" : "existing",
        this._maskedAccount(result.session),
        timings,
      );
      return result;
    } catch (error) {
      this._log(
        "error",
        "create",
        input.traceId,
        "error",
        this._maskedAccount(stored),
        timings,
      );
      throw error;
    }
  }

  /** The live session or `null`; writes nothing and logs nothing. */
  async get(input: { nowMs: number }): Promise<SessionDoc | null> {
    const stored = await this._load();
    return getDomain(stored, input.nowMs);
  }

  async markDisclosure(input: { nowMs: number }, traceId?: string): Promise<DisclosureResult> {
    const timings = startTimings();
    let stored: SessionDoc | null = null;
    try {
      stored = await timings.time("actor", () => this._load());
      const { state, result } = markDisclosureDomain(stored, input);
      if (state !== stored) {
        await timings.time("actor", () => this._save(state as SessionDoc));
      }
      this._log(
        "info",
        "markDisclosure",
        traceId ?? stored?.traceId ?? null,
        result.outcome,
        result.outcome === "missing" ? null : this._maskedAccount(state),
        timings,
      );
      return result;
    } catch (error) {
      this._log(
        "error",
        "markDisclosure",
        traceId ?? stored?.traceId ?? null,
        "error",
        this._maskedAccount(stored),
        timings,
      );
      throw error;
    }
  }

  async setVerified(input: SetVerifiedInput, traceId?: string): Promise<SetVerifiedResult> {
    const timings = startTimings();
    let stored: SessionDoc | null = null;
    try {
      stored = await timings.time("actor", () => this._load());
      const { state, result } = setVerifiedDomain(stored, input);
      if (state !== stored) {
        await timings.time("actor", () => this._save(state as SessionDoc));
      }
      this._log(
        "info",
        "setVerified",
        traceId ?? stored?.traceId ?? null,
        result.outcome,
        result.outcome === "missing" ? null : this._maskedAccount(state),
        timings,
      );
      return result;
    } catch (error) {
      this._log(
        "error",
        "setVerified",
        traceId ?? stored?.traceId ?? null,
        "error",
        this._maskedAccount(stored),
        timings,
      );
      throw error;
    }
  }

  async recordVerifyFailure(
    input: RecordVerifyFailureInput,
    traceId?: string,
  ): Promise<VerifyFailureResult> {
    const timings = startTimings();
    let stored: SessionDoc | null = null;
    try {
      stored = await timings.time("actor", () => this._load());
      const { state, result } = recordVerifyFailureDomain(stored, input);
      if (state !== stored) {
        await timings.time("actor", () => this._save(state as SessionDoc));
      }
      this._log(
        "info",
        "recordVerifyFailure",
        traceId ?? stored?.traceId ?? null,
        result.outcome,
        result.outcome === "missing" ? null : this._maskedAccount(state),
        timings,
      );
      return result;
    } catch (error) {
      this._log(
        "error",
        "recordVerifyFailure",
        traceId ?? stored?.traceId ?? null,
        "error",
        this._maskedAccount(stored),
        timings,
      );
      throw error;
    }
  }

  /**
   * Delete the state once the session behind it has expired. Delivery is
   * at-least-once: an expired session is deleted again (a no-op), a live
   * one (created again after an expiry) just gets its alarm set again to
   * the same `expiresAt`, and empty storage is left alone, so a
   * redelivered alarm does nothing.
   */
  override async alarm(_info: AlarmInfo): Promise<void> {
    const s = await this._load();
    if (s === null) {
      return;
    }
    if (isLive(s, Date.now())) {
      await this.ctx.storage.setAlarm(s.expiresAt);
      return;
    }
    await this.ctx.storage.deleteAll();
  }

  // Helpers start with "_" so the runtime never exposes them over RPC.
  private async _load(): Promise<SessionDoc | null> {
    return (await this.ctx.storage.get<SessionDoc>(STATE_KEY)) ?? null;
  }

  private async _save(s: SessionDoc): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, s);
  }

  /** The session's account masked, or `null` when the session has none. */
  private _maskedAccount(session: SessionDoc | null): string | null {
    if (session === null || session.accountNumber === null) {
      return null;
    }
    return maskAccount(session.accountNumber);
  }

  /** One line per call; the phone number never appears in any field. */
  private _log(
    level: Level,
    method: string,
    traceId: string | null,
    outcome: string,
    account: string | null,
    timings: Timings,
  ): void {
    logger.log(level, "actor", {
      actor: ACTOR_NAME,
      method,
      trace_id: traceId,
      sid: this._instanceName(),
      account,
      outcome,
      latency_ms: timings.snapshot(),
    });
  }

  private _instanceName(): string {
    // The runtime sets ctx.id from idFromName(sid). A bare-bones test
    // double may carry no id; a missing name must never break a log line.
    const id: unknown = this.ctx.id;
    return typeof id === "string" ? id : "";
  }
}
