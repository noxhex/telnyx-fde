# T18. Session domain and actor

**Phase** 1 · **Depends on** T02

## Goal

The per-call actor that holds a call's session (ADR-019). Call setup creates it and every MCP call reads it, each in one actor round trip instead of a KV write or read. It creates the session once per sid, forgets it when it expires, and keeps the verification failures that have no account to live on.

## Read first

- `docs/DECISIONS.md`, ADR-013, ADR-015 and ADR-019.
- `docs/ARCHITECTURE.md`, sections Where state lives, Actors and Identity levels.
- `AGENTS.md`, Conventions (pure domain, thin actors, time inputs fail closed) and Platform facts (actors and alarms).
- `functions/voice-tools/src/actors/customer-account.ts`, whose adapter and log line this card follows.

## Files

- `packages/shared/src/session-types.ts` (the types callers and the actor share), exported from `packages/shared/src/index.ts`.
- `functions/voice-tools/src/domain/session.ts` (pure logic).
- `functions/voice-tools/src/actors/session.ts` (actor adapter).
- `functions/voice-tools/src/index.ts`, to re-export the class.
- `functions/voice-tools/telnyx.toml`, adding the binding `SESSION` with type `Session`.
- `functions/voice-tools/test/session.test.ts`.

## Shared types

`voice-context` (T08) and `voice-tools` (T09) call this actor through a stub, so the shapes they send and get back live in `packages/shared/src/session-types.ts`, types only.

```ts
export type IdentityLevel = "anonymous" | "number_match" | "attested" | "verified";

export interface SessionDoc {
  v: 1;
  sid: string;
  traceId: string;
  identity: IdentityLevel;
  accountNumber: string | null;
  postcode: string | null;
  lineId: string | null;
  callerPhone: string | null;   // E.164, for callbacks
  createdAt: number;
  expiresAt: number;
  disclosedAt: number | null;
  verify: { failures: number; lockedUntil: number | null };
}

/** What a caller sends to create. The sid is the actor's instance name. */
export interface CreateSessionInput {
  traceId: string;
  identity: "anonymous" | "number_match" | "attested";
  accountNumber?: string;
  postcode?: string;
  lineId?: string;
  callerPhone?: string;
  nowMs: number;
  ttlMs?: number;               // default two hours
}

export interface CreateSessionResult { created: boolean; session: SessionDoc }
export interface DisclosureResult { outcome: "logged" | "unchanged" | "missing"; traceId: string | null }
export interface SetVerifiedResult { outcome: "verified" | "locked" | "missing"; lockedUntil: number | null }
export interface VerifyFailureResult {
  outcome: "counted" | "locked" | "missing"; attemptsLeft: number; lockedUntil: number | null;
}
```

## Domain interface

```ts
export function create(s: SessionDoc | null, i: CreateSessionInput & { sid: string }): {
  state: SessionDoc; result: CreateSessionResult;
};

export function get(s: SessionDoc | null, nowMs: number): SessionDoc | null;

export function markDisclosure(s: SessionDoc | null, i: { nowMs: number }): {
  state: SessionDoc | null; result: DisclosureResult;
};

export function setVerified(s: SessionDoc | null, i: {
  accountNumber: string; postcode: string; lineId: string; nowMs: number;
}): { state: SessionDoc | null; result: SetVerifiedResult };

export function recordVerifyFailure(s: SessionDoc | null, i: {
  nowMs: number;
  maxFailures?: number;   // default 3
  lockMs?: number;        // default 15 minutes
}): { state: SessionDoc | null; result: VerifyFailureResult };
```

## Behaviour

- **Live or gone.** A session expires at `expiresAt`, which is `createdAt + ttlMs`. It is live while `nowMs` is before `expiresAt` and expired from that instant on, the same rule as the token's `exp` (T04). Every function treats an expired session exactly like a missing one.
- **`create`** starts a session when there is none or the stored one has expired. It sets `createdAt` to `nowMs`, `expiresAt` to `nowMs + ttlMs`, missing optional fields to `null`, `disclosedAt` to `null` and no failures, and returns `created: true`. For a live session it changes nothing and returns `created: false` with the stored session, whatever the input says, so a retried webhook never resets the identity, the disclosure or the failures (ADR-015).
- **`get`** returns the live session, or `null` when there is none or it has expired.
- **`markDisclosure`** sets `disclosedAt` to `nowMs` the first time (`logged`) and keeps that first time on later calls (`unchanged`). The result carries the session's `traceId`, so the caller can log it.
- **`setVerified`** sets `identity` to `verified` with the given account number, postcode and line id, replacing whatever account the session had (`verified`). While the verify lock is active it changes nothing and returns `locked` with `lockedUntil`.
- **`recordVerifyFailure`** counts one failed verification for an account number that does not exist (T09). While the lock is active it changes nothing and returns `locked`. Otherwise it adds a failure. Reaching `maxFailures` sets `lockedUntil` to `nowMs + lockMs`, resets the failures and returns `locked`, and below that it returns `counted`. `attemptsLeft` is what remains before a lock, and 0 while locked.
- **The lock** is active while `nowMs` is before `lockedUntil`. From that instant on it counts as no lock, and failures count from zero again.
- **No live session.** `markDisclosure`, `setVerified` and `recordVerifyFailure` return `missing` (with `traceId` and `lockedUntil` `null` and `attemptsLeft` 0) and change nothing.
- **Unchanged means the same object.** A function that changes nothing returns the very object it was given as `state`, and no function mutates its input.
- **Broken inputs.** A `nowMs`, `ttlMs` or `lockMs` that is not a finite number, a `ttlMs` or `lockMs` that is not above zero, or a `maxFailures` that is not a positive whole number makes the function throw a `RangeError` instead of returning a result (AGENTS.md, Time inputs fail closed). This holds for `get` too. A `sid` in `create` that is not 32 lowercase hex characters throws a `RangeError` as well, so an instance with any other name can never hold a session.

## Actor adapter

The class `Session extends StatefulActor` keeps the session as one JSON document under the storage key `state`. The instance name (`ctx.id`) is the sid, so `create` takes a `CreateSessionInput` and fills `sid` from the instance name. Its methods are `create(input)`, `get({ nowMs })`, `markDisclosure({ nowMs }, traceId?)`, `setVerified(input, traceId?)` and `recordVerifyFailure(input, traceId?)`. Each loads the state, calls the domain function, saves only when the returned state is a different object, and returns the result (`get` returns the session or `null`). So a method on a missing or expired session writes nothing, and a guessed sid leaves no state behind.

`create` sets the alarm to `expiresAt` when it creates a session. `alarm()` deletes all state with `deleteAll()` when the stored session has expired, sets the alarm again to `expiresAt` when the stored session is live (one created again after an expiry), and does nothing when there is no state. So it is safe to run twice.

`create`, `markDisclosure`, `setVerified` and `recordVerifyFailure` each write one log line through the shared logger with `event` `"actor"`, `actor` `"Session"`, the `method`, `trace_id`, `sid` (the instance name), the session's account masked with `maskAccount` (or `null` without one), the `outcome` and `latency_ms` from the timing helper, the object from `snapshot()` as in `CustomerAccount`. `trace_id` is the input's `traceId` for `create`. For the others it is the `traceId` argument when given, otherwise the stored session's `traceId`, otherwise `null`, because `/tools/disclosure` knows only the sid. The outcome is `"created"` or `"existing"` for `create`, and the result's outcome for the others. A method that throws logs `"error"` and rethrows. `get` writes no line, like `CustomerAccount.snapshot`. No line holds the caller's phone number.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Domain tests cover `create` with and without the optional fields, a second `create` leaving a live session unchanged even with different input, `create` after expiry starting a new session, a session live 1 ms before `expiresAt` and gone exactly at it (in `get` and in each other function), the disclosure logged once and then kept, `setVerified` replacing the account, `setVerified` refused while locked, failures counting `attemptsLeft` down, the lock at exactly three failures, a locked session refusing a further failure, the lock active 1 ms before `lockedUntil` and lifted exactly at it, every function on a missing session, unchanged calls returning the same object, inputs never mutated, and each broken input throwing a `RangeError`.
- [ ] Actor tests with the actor storage fake show the sid coming from the instance name, `create` setting the alarm to `expiresAt`, the alarm deleting an expired session and then running a second time without error, the alarm set again for a live session, and methods on a missing or expired session writing nothing.
- [ ] Tests show each logged method writing one line with `trace_id`, `sid`, the method, the outcome, the masked account and `latency_ms`, `trace_id` falling back to the stored session's, and the failing case logging `"error"`.
- [ ] `telnyx-edge dev` starts `voice-tools` with all three actor bindings.
- [ ] Nothing is shipped.

## Out of scope

The callers (T08 creates the session and marks the disclosure, T09 reads it and records verification), HTTP routes, the token.
