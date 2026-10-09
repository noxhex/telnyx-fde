/**
 * CustomerAccount actor — thin adapter over `../domain/customer-account.ts`
 * (ADR-006). One instance per CRM account. The whole state lives as a
 * single JSON document under the storage key `state`. Every method loads
 * it, runs the pure domain function, saves the result and returns; all
 * rules live in the domain module.
 */

import { randomInt } from "node:crypto";

import { StatefulActor } from "@telnyx/edge-runtime";
import type { AlarmInfo } from "@telnyx/edge-runtime";

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

/** The createTicket input callers send; the actor generates id and window. */
export type NewTicketInput = Omit<CreateTicketInput, "ticketId" | "window">;

export class CustomerAccount extends StatefulActor {
  async recordCall(input: RecordCallInput): Promise<RecordCallResult> {
    const s = await this._load();
    const { state, result } = recordCall(s, input);
    await this._save(state);
    return result;
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const s = await this._load();
    const { state, result } = verify(s, input);
    await this._save(state);
    // While a lock is active there is an alarm on it, so the lock lifts
    // even if the caller never rings back. Re-arming an alarm that is
    // already scheduled to the same instant is a no-op on the platform.
    if (result.lockedUntil !== null) {
      await this.ctx.storage.setAlarm(result.lockedUntil);
    }
    return result;
  }

  async createTicket(input: NewTicketInput): Promise<CreateTicketResult> {
    const s = await this._load();
    const ticketId = newTicketId();
    const window = nextWorkingDayWindow(input.nowMs);
    const { state, result } = createTicket(s, { ...input, ticketId, window });
    await this._save(state);
    return result;
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
