/**
 * CustomerAccount actor — thin adapter over `../domain/customer-account.ts`
 * (ADR-006). One instance per CRM account; the account number is the
 * instance name (`ctx.id`). The whole state lives as a single JSON document
 * under the storage key `state`. Every method loads it, runs the pure
 * domain function, saves the result and returns; all rules live in the
 * domain module.
 *
 * Each state-changing method takes an optional `traceId` (the call control
 * id threaded through T08/T09) and writes one log line at the end
 * (docs/ARCHITECTURE.md, Observability): event `"actor"`, the method, the
 * trace id, the masked account, the outcome and the per-hop latency. A
 * method that throws logs outcome `"error"` and rethrows.
 */

import { randomInt } from "node:crypto";

import { StatefulActor } from "@telnyx/edge-runtime";
import type { AlarmInfo } from "@telnyx/edge-runtime";

import { createLogger, maskAccount, startTimings } from "@duinvezel/shared";
import type { Level, Timings } from "@duinvezel/shared";

import {
  clearExpiredLock,
  createTicket,
  initialState,
  recordCall,
  verify,
} from "../domain/customer-account.js";
import type {
  CreateTicketInput,
  CreateTicketResult,
  CustomerAccountState,
  RecordCallInput,
  RecordCallResult,
  VerifyInput,
  VerifyResult,
} from "../domain/customer-account.js";

const STATE_KEY = "state";
const DAY_MS = 24 * 60 * 60 * 1000;
const BRUSSELS_TZ = "Europe/Brussels";
const ACTOR_NAME = "CustomerAccount";

const logger = createLogger("voice-tools");

/** The createTicket input callers send; the actor generates id and window. */
export type NewTicketInput = Omit<CreateTicketInput, "ticketId" | "window">;

export class CustomerAccount extends StatefulActor {
  async recordCall(input: RecordCallInput, traceId?: string): Promise<RecordCallResult> {
    const timings = startTimings();
    try {
      const s = await timings.time("actor", () => this._load());
      const { state, result } = recordCall(s, input);
      await timings.time("actor", () => this._save(state));
      this._log("info", "recordCall", traceId, "recorded", timings);
      return result;
    } catch (error) {
      this._log("error", "recordCall", traceId, "error", timings);
      throw error;
    }
  }

  async verify(input: VerifyInput, traceId?: string): Promise<VerifyResult> {
    const timings = startTimings();
    try {
      const s = await timings.time("actor", () => this._load());
      const { state, result } = verify(s, input);
      await timings.time("actor", () => this._save(state));
      // While a lock is active there is an alarm on it, so the lock lifts
      // even if the caller never rings back. Re-arming an alarm that is
      // already scheduled to the same instant is a no-op on the platform.
      const lockedUntil = result.lockedUntil;
      if (lockedUntil !== null) {
        await timings.time("actor", () => this.ctx.storage.setAlarm(lockedUntil));
      }
      this._log("info", "verify", traceId, result.outcome, timings);
      return result;
    } catch (error) {
      this._log("error", "verify", traceId, "error", timings);
      throw error;
    }
  }

  async createTicket(input: NewTicketInput, traceId?: string): Promise<CreateTicketResult> {
    const timings = startTimings();
    try {
      const s = await timings.time("actor", () => this._load());
      const ticketId = newTicketId();
      const window = nextWorkingDayWindow(input.nowMs);
      const { state, result } = createTicket(s, { ...input, ticketId, window });
      await timings.time("actor", () => this._save(state));
      this._log("info", "createTicket", traceId, result.created ? "created" : "existing", timings);
      return result;
    } catch (error) {
      this._log("error", "createTicket", traceId, "error", timings);
      throw error;
    }
  }

  /** Debug view of the stored state; the storage codec hands back a copy. */
  async snapshot(): Promise<CustomerAccountState> {
    return this._load();
  }

  /**
   * Lift the verification lock once its time has passed. Delivery is
   * at-least-once; `clearExpiredLock` on an unlocked account is a no-op, so
   * a redelivered alarm does nothing.
   */
  override async alarm(_info: AlarmInfo): Promise<void> {
    const s = await this._load();
    const next = clearExpiredLock(s, Date.now());
    if (next !== s) {
      await this._save(next);
    }
  }

  // Helpers start with "_" so the runtime never exposes them over RPC.
  private async _load(): Promise<CustomerAccountState> {
    return (await this.ctx.storage.get<CustomerAccountState>(STATE_KEY)) ?? initialState();
  }

  private async _save(s: CustomerAccountState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, s);
  }

  /** One line per call; the account is the masked instance name, never raw. */
  private _log(
    level: Level,
    method: string,
    traceId: string | undefined,
    outcome: string,
    timings: Timings,
  ): void {
    logger.log(level, "actor", {
      actor: ACTOR_NAME,
      method,
      trace_id: traceId ?? null,
      account: maskAccount(this._instanceName()),
      outcome,
      latency_ms: timings.snapshot(),
    });
  }

  private _instanceName(): string {
    // The runtime sets ctx.id from idFromName(name). A bare-bones test
    // double may carry no id; a missing name must never break a log line.
    const id: unknown = this.ctx.id;
    return typeof id === "string" ? id : "";
  }
}

/** `T-` plus four random digits, e.g. `T-0427`. */
function newTicketId(): string {
  return `T-${String(randomInt(0, 10_000)).padStart(4, "0")}`;
}

/**
 * The next working day between 8 and 12 on the Europe/Brussels calendar,
 * e.g. `"2026-10-12 08:00-12:00"`. "Next" never means today, and Saturdays
 * and Sundays are skipped. Calendar arithmetic runs on the UTC-midnight
 * copy of the Brussels civil date, so DST never shifts the day count.
 */
function nextWorkingDayWindow(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BRUSSELS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const civil = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value);
  let dayMs = Date.UTC(civil("year"), civil("month") - 1, civil("day")) + DAY_MS;
  for (;;) {
    const weekday = new Date(dayMs).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      break;
    }
    dayMs += DAY_MS;
  }
  const date = new Date(dayMs);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} 08:00-12:00`;
}
