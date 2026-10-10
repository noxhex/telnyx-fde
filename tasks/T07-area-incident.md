# T07. AreaIncident domain and actor

**Phase** 1 · **Depends on** T02

## Goal

The per-postcode actor that counts outage reports and declares an incident exactly once, then publishes the area status to KV through an outbox (ADR-004, ADR-005). This is the heart of the demo.

## Read first

- `docs/DECISIONS.md`, ADR-004, ADR-005 and ADR-015.
- `docs/ARCHITECTURE.md`, sections Where state lives and KV keys.
- `AGENTS.md`, Conventions and Platform facts (actors and alarms).

## Files

- `functions/voice-tools/src/domain/area-incident.ts` (pure logic).
- `functions/voice-tools/src/actors/area-incident.ts` (actor adapter).
- `functions/voice-tools/src/index.ts`, to re-export the class.
- `functions/voice-tools/telnyx.toml`, adding the binding `AREA_INCIDENT` with type `AreaIncident`, and the KV binding `KV` with the namespace id from `infra/ids.json`.
- `functions/voice-tools/test/area-incident.test.ts`.

## Domain interface

```ts
export type Symptom = "no_connection" | "slow" | "intermittent" | "other";

export interface AreaStatus {
  state: "ok" | "outage";
  incidentId: string | null;
  eta: string | null;      // speakable, for example "by 18:00 today"
  version: number;
  updatedAt: number;
}

export interface AreaIncidentState {
  v: 1;
  areaCode: string;
  status: "ok" | "outage";
  reports: Record<string, { at: number; symptom: Symptom }>;   // keyed by account number
  incident: { id: string; declaredAt: number; etaAt: number; reporters: number } | null;
  version: number;
  outbox: AreaStatus | null;
}

export function initialState(areaCode: string): AreaIncidentState;

export function report(s: AreaIncidentState, i: {
  accountId: string; symptom: Symptom; nowMs: number;
  threshold: number; windowMs: number; etaMs: number;
  formatEta: (etaAt: number) => string;
}): {
  state: AreaIncidentState;
  result: {
    reportsInWindow: number; threshold: number; counted: boolean;
    incidentDeclared: boolean; incidentId: string | null; eta: string | null;
  };
};

export function resolve(s: AreaIncidentState, i: { nowMs: number }): {
  state: AreaIncidentState; result: { resolved: boolean; incidentId: string | null };
};

export function markPublished(s: AreaIncidentState, version: number): AreaIncidentState;
export function currentStatus(s: AreaIncidentState, formatEta: (etaAt: number) => string): AreaStatus;
```

## Behaviour

- **Window.** Every `report` first drops reports strictly older than `windowMs`, so a report exactly `windowMs` old still counts.
- **Dedupe.** A report from an account already in the window is not counted again (`counted: false`), but its timestamp and symptom are refreshed.
- **Declaring.** When the status is `ok` and the distinct reporters in the window reach `threshold`, the report that reaches it declares the incident. The status becomes `outage`, the incident id is `INC-<area>-<UTC yyyyMMddHHmm>`, `etaAt` is `nowMs + etaMs`, the version increments, and the outbox is set to the new status. Only that one report returns `incidentDeclared: true`.
- **During an outage**, further reports are counted and stored but never declare again.
- **`resolve`** sets the status to `ok`, clears the reports and the incident, increments the version and sets the outbox. Resolving an area that is already `ok` changes nothing and returns `resolved: false`.
- **`markPublished`** clears the outbox only if the outbox version equals `version`, so an older publish cannot clear a newer status.
- **Broken inputs.** A `nowMs`, `windowMs` or `etaMs` that is not a finite number, or a `threshold` that is not a positive whole number, makes the domain function throw a `RangeError` instead of returning a result, so nothing is counted, declared or resolved with a broken clock (AGENTS.md, Time inputs fail closed).

## Actor adapter

The class `AreaIncident extends StatefulActor` keeps the state as one JSON document under `state`, with `areaCode` set from the instance name on first use. Its methods are `report` (same inputs minus `s`), `resolve`, and `status` (returns `currentStatus`). `report` and `resolve` also take an optional `traceId`. Each call writes one log line through the shared logger with `event` `"actor"`, `actor` `"AreaIncident"`, the `method`, `trace_id`, the `area`, the reporter's account masked with `maskAccount` (for `report`), the `outcome` and `latency_ms` from the timing helper. The outcome is `"declared"`, `"counted"` or `"duplicate"` for `report`, and `"resolved"` or `"unchanged"` for `resolve`. A method that throws logs `"error"` and rethrows.

After saving, if there is an outbox, the adapter writes it to KV at `kvKeys.areaStatus(areaCode)`, with a 300 ms timeout. On success it calls `markPublished`, saves again and logs `publish`. On failure it logs `publish_retry` and sets the alarm, five seconds ahead the first time. A failed publish never moves the retry ladder back to its start, so repeated failures during a KV outage do not restart it at 5 seconds. Either way the caller gets its result, because the decision is already durable. The actor keeps the `traceId` of the change that set the outbox, and the `publish` and `publish_retry` lines carry it as `trace_id`, also when the alarm writes them, together with the area, the version and `latency_ms` of the KV write.

**Confirming write.** A publish that timed out has an unknown outcome (ADR-015), and it may still land after a newer publish. So after any timed-out publish the actor marks that a confirming write is due. Once at least 30 seconds have passed since the timeout, longer than an actor method's budget, the alarm writes the then-current status again, even if a newer publish succeeded in between. Only that confirming write clears the marker, and a failed confirming write is retried like any publish.

`alarm()` retries the publish, with the next alarm at 5, 15, then every 60 seconds until it succeeds, and also prunes old reports. It is safe to run twice. `formatEta` formats `etaAt` in the `Europe/Brussels` time zone as "by HH:mm today" or "by HH:mm tomorrow".

## Acceptance

- [ ] `npm run check` passes.
- [ ] Domain tests cover the threshold reached at exactly N distinct accounts with only that report declaring, a duplicate reporter not counting, a report exactly `windowMs` old still counting and one 1 ms older leaving the window, no second declaration during an outage, resolve and the resolve no-op, version increments, the outbox set on declare and resolve, `markPublished` ignoring a stale version, and a non-finite `nowMs` throwing in `report` and `resolve`.
- [ ] A test feeds 50 reports from 10 accounts in random order (seeded random) and asserts exactly one declaration.
- [ ] An actor test holds a publish until it times out, lets a newer publish succeed, then releases the held write, and shows KV ending at the newest status after the confirming write.
- [ ] Tests show the `report` and `resolve` log lines, the `publish` and `publish_retry` lines carrying the trace id of the change that set the outbox, also from the alarm, and repeated failed publishes keeping the retry ladder where it is.
- [ ] `telnyx-edge dev` starts `voice-tools` with both actor bindings.
- [ ] Nothing is shipped.

## Out of scope

Subscriptions and notifications (T16), HTTP routes, MCP.
