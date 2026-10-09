# T06. CustomerAccount domain and actor

**Phase** 1 · **Depends on** T02

## Goal

The per-account actor that makes verification lockout, repeat-caller detection and ticket creation safe under concurrency (ADR-006).

## Read first

- `docs/DECISIONS.md`, ADR-006, ADR-013 and ADR-015.
- `AGENTS.md`, Conventions (pure domain, thin actors) and Platform facts (actors).
- Actor API at https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/storage.md and https://developers.telnyx.com/docs/edge-compute/stateful-actors/alarms.md (fetch them).

## Files

- `functions/voice-tools/src/domain/customer-account.ts` (pure logic).
- `functions/voice-tools/src/actors/customer-account.ts` (actor adapter).
- `functions/voice-tools/src/index.ts`, to re-export the class.
- `functions/voice-tools/telnyx.toml`, adding the binding `CUSTOMER_ACCOUNT` with type `CustomerAccount`.
- `functions/voice-tools/test/customer-account.test.ts`.

## Domain interface

```ts
export type TicketCategory = "repair_visit" | "callback" | "other";

export interface CustomerAccountState {
  v: 1;
  calls: { id: string; at: number }[];
  verify: { failures: number; lockedUntil: number | null };
  tickets: {
    id: string; dedupeKey: string; category: TicketCategory;
    summary: string; createdAt: number; window: string;
  }[];
}

export function initialState(): CustomerAccountState;

export function recordCall(s: CustomerAccountState, i: { callId: string; nowMs: number }): {
  state: CustomerAccountState;
  result: { callCount24h: number; repeatCaller: boolean; lockedUntil: number | null };
};

export function verify(s: CustomerAccountState, i: {
  mode: "full" | "postcode";
  submitted: { postcode: string; accountNumber?: string };
  expected: { postcode: string; accountNumber: string };
  nowMs: number;
  maxFailures?: number;   // default 3
  lockMs?: number;        // default 15 minutes
}): {
  state: CustomerAccountState;
  result: { outcome: "ok" | "wrong" | "locked"; attemptsLeft: number; lockedUntil: number | null };
};

export function clearExpiredLock(s: CustomerAccountState, nowMs: number): CustomerAccountState;

export function createTicket(s: CustomerAccountState, i: {
  dedupeKey: string; ticketId: string; category: TicketCategory;
  summary: string; nowMs: number; window: string;
}): { state: CustomerAccountState; result: { ticketId: string; created: boolean; window: string } };
```

## Behaviour

- **`recordCall`** drops calls older than 24 hours, ignores a `callId` it already has (webhook retries must not count twice), and reports `repeatCaller` when the count, including this call, is three or more.
- **`verify`** returns `locked` without comparing anything while `lockedUntil` is in the future. Otherwise it compares normalised values (trim, uppercase, spaces removed). Postcode mode compares only the postcode, and full mode compares both. Success resets failures to zero. A failure increments them, and reaching `maxFailures` sets `lockedUntil` to `nowMs + lockMs` and resets failures. `attemptsLeft` is what remains before a lock.
- **`clearExpiredLock`** removes a lock whose time has passed.
- **`createTicket`** returns the existing ticket with `created: false` when the dedupe key already exists. The summary is truncated to 300 characters.

## Actor adapter

The class `CustomerAccount extends StatefulActor` keeps the whole state as one JSON document under the storage key `state`. Its methods `recordCall`, `verify` and `createTicket` take the same inputs minus `s`, load the state, call the domain function, save it and return `result`. `createTicket` generates the ticket id as `T-` plus four random digits, and computes the window as "the next working day between 8 and 12", formatted in the `Europe/Brussels` time zone. `verify` sets the alarm to `lockedUntil` when it locks. `alarm()` calls `clearExpiredLock`, saves, and is safe to run twice. `snapshot()` returns the state for debugging.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Domain tests cover the repeat-caller threshold at exactly three calls, a duplicate call id, calls older than 24 hours dropping out, verify success, the failure count, the lock after three failures, a locked account refusing even correct details, the lock expiring, postcode mode ignoring the account number, normalisation of `" 8630 "` and `"dv-100001"`, a duplicate ticket dedupe key, and summary truncation.
- [ ] `telnyx-edge dev` starts `voice-tools` with the actor binding.
- [ ] Nothing is shipped.

## Out of scope

HTTP routes, MCP, calling the actor from other functions.
