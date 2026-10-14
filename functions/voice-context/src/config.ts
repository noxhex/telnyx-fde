/**
 * voice-context configuration: every timeout, budget and cache TTL from the
 * call setup latency budget (docs/ARCHITECTURE.md) and the flag document
 * shape. No I/O here — values and pure helpers only.
 *
 * The whole `/dv` call shares `SOFT_BUDGET_MS` from the moment `handleDv`
 * starts, before the body read and the signature check (T24): every awaited
 * dependency timeout is cut to what remains of the budget, so a fresh
 * replica's slow first reads can never push the answer past it (card T08,
 * step 8). Only the fire-and-forget CRM cache write is never cut — the
 * answer does not wait for it.
 */

import { z } from "zod";

import { TIMED_OUT } from "@duinvezel/shared";

/** The signature check is CPU-only and carries no timeout. */
export const SECRET_HANDLES = {
  telnyxPublicKey: "TELNYX_PUBLIC_KEY",
  mcpTokenKey: "MCP_TOKEN_KEY",
  mcpEncKey: "MCP_ENC_KEY",
  internalKey: "INTERNAL_KEY",
} as const;

export const SOFT_BUDGET_MS = 3_000;

/**
 * A secret read is one HTTP hop to the sidecar (DEBUGLOG issue 9); a timeout
 * counts as a failed read. 2,000 ms since T24: a fresh replica's first read
 * has taken over 1,000 ms (DEBUGLOG issue 17, and again on 14 October).
 */
export const SECRET_READ_TIMEOUT_MS = 2_000;

export const TIMEOUTS = {
  flagsMs: 1_000,
  /**
   * The whole CRM lookup race, KV side and mock-crm side. T22: covers two
   * first uses in a row — this replica's `INTERNAL_KEY` read inside the
   * mock-crm call (0.55 to over 1.0 s cold, no longer cut at
   * `SECRET_READ_TIMEOUT_MS`) and mock-crm's own 1,000 ms read window on a
   * cold replica (T20), about 1.7 s together (DEBUGLOG issue 17).
   */
  crmLookupMs: 2_000,
  /**
   * One area status KV read. T24: 2,500 ms — on 14 October KV was about
   * twice as slow as when T22 set 2,000, and the reads ran into that bound.
   */
  areaStatusMs: 2_500,
  recordCallMs: 600,
  sessionCreateMs: 1_000,
  sessionDisclosureMs: 1_000,
  /**
   * The KV write behind a mock-crm answer. Since T24 `/dv` never awaits it
   * and it is never cut by the soft budget; it logs `crm_cache_write` when
   * it settles.
   */
  crmCacheWriteMs: 2_500,
  health: { kvPutMs: 2_500, kvGetMs: 1_500, crmMs: 1_500, actorMs: 1_000 },
} as const;

/** Memory-cache lifetimes inside one container (ADR-019). */
export const CACHE_TTL_MS = {
  flagsMs: 10_000,
  areasMs: 10_000,
  crmMs: 60_000,
} as const;

/** The KV copy of a CRM answer, so other containers find the caller too. */
export const CRM_KV_TTL_SEC = 600;

/** Sessions and the mcp_token both live for the call's two hours. */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export const CANARY_ACCOUNT_NAME = "CANARY-0";
export const CANARY_SESSION_SID = "00000000000000000000000000000000";
/** The canary's customer lookup: fixture account DV-100002 (`+3258000001`). */
export const CANARY_CRM_PHONE_DIGITS = "3258000001";

/**
 * What a `TimeoutRunner` resolves with when its timer wins the race. It is
 * shared's sentinel (T20), re-exported under the name every route and test
 * already uses, so this function's runner plugs straight into
 * `createRefreshingValue`.
 */
export { TIMED_OUT };

/**
 * Races `fn()` against `ms` milliseconds of real time. Settlements of `fn`
 * after the timer won are still handled (the handlers stay attached), so a
 * late call can never surface as an unhandled rejection. Tests inject a
 * manual runner and fire every timer by hand.
 */
export type TimeoutRunner = <T>(fn: () => Promise<T>, ms: number) => Promise<T | typeof TIMED_OUT>;

export const realTimeoutRunner: TimeoutRunner = <T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> =>
  new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });

/**
 * The feature flags voice-context reads. `dv_force_error` is test path E
 * (the call setup webhook "down"), `diagnostics_enabled` goes out as a
 * dynamic variable. Each flag falls back to its default on its own; a whole
 * document that is not an object falls back to both.
 */
export interface DvFlags {
  dvForceError: boolean;
  diagnosticsEnabled: boolean;
}

export const DEFAULT_FLAGS: DvFlags = Object.freeze({
  dvForceError: false,
  diagnosticsEnabled: true,
});

const rawFlagsSchema = z
  .object({
    dv_force_error: z.boolean().catch(false),
    diagnostics_enabled: z.boolean().catch(true),
  })
  .catch({ dv_force_error: false, diagnostics_enabled: true });

export function parseFlags(raw: unknown): DvFlags {
  const parsed = rawFlagsSchema.parse(raw);
  return { dvForceError: parsed.dv_force_error, diagnosticsEnabled: parsed.diagnostics_enabled };
}

/** What mock-crm's `GET /customers?phone=` returns on a 200 (its CustomerSummary). */
export interface CrmCustomer {
  accountNumber: string;
  firstName: string;
  postcode: string;
  areaName: string;
  lineId: string;
}

export const crmCustomerSchema = z.object({
  accountNumber: z.string(),
  firstName: z.string(),
  postcode: z.string(),
  areaName: z.string(),
  lineId: z.string(),
});

/**
 * One CRM lookup answer: the customer, or the not-found marker. Cached in
 * memory for 60 s and in KV for 600 s, so both the customer summary and a
 * negative answer count as answers worth keeping (a timeout or an error
 * never does).
 */
export type CrmAnswer =
  | { kind: "customer"; customer: CrmCustomer }
  | { kind: "not_found" };

/** The KV shape under `crm/phone/<digits>`: the summary itself or the marker. */
const crmCacheValueSchema = z.union([
  crmCustomerSchema.transform((customer) => ({ kind: "customer" as const, customer })),
  z.object({ notFound: z.literal(true) }).transform(() => ({ kind: "not_found" as const })),
]);

/** Parses a value read back from `crm/phone/<digits>`; unknown shapes count as a KV miss. */
export function parseCrmCacheValue(raw: unknown): CrmAnswer | null {
  const parsed = crmCacheValueSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The string written to KV for an answer that came from mock-crm. */
export function encodeCrmCacheValue(answer: CrmAnswer): string {
  if (answer.kind === "not_found") {
    return JSON.stringify({ notFound: true });
  }
  return JSON.stringify(answer.customer);
}

/** The area status read model published by the AreaIncident actor (ADR-005). */
export interface AreaStatusDoc {
  state: "ok" | "outage";
  incidentId: string | null;
  eta: string | null;
  version: number;
  updatedAt: number;
}

const areaStatusSchema = z.object({
  state: z.enum(["ok", "outage"]),
  incidentId: z.string().nullable(),
  eta: z.string().nullable(),
  version: z.number(),
  updatedAt: z.number(),
});

/** Parses a value read back from `area/<postcode>/status`; unknown shapes mean the area was never published. */
export function parseAreaStatus(raw: unknown): AreaStatusDoc | null {
  const parsed = areaStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
