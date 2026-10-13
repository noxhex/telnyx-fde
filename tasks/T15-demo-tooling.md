# T15. Demo tooling: flags, simulated outage reports and a reset

**Phase** 2 · **Depends on** T22, and runs before T13 · **Code by** implementer agent

## Goal

The demo can be repeated. One script drives the deployed voice-tools to do three things:

- set the feature flags;
- put simulated outage reports on an area;
- reset the demo state.

A reset clears four things:

- every fixture account's call history, and with it the repeat-caller count;
- every fixture account's verification failures and lock;
- every area's reports;
- every area's incident.

So test calls never leave Thiago's account marked as a repeat caller, or any account locked, on review day. Thiago decided this on 13 October. It replaces the T15 outline in `tasks/later.md`.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read the files under "Read first" and the files you change, and nothing more. The card holds what you need from `docs/`.
- Plan briefly, then write each file in as few steps as you can.
- While you work, run `npx vitest run functions/voice-tools`. Run `npm run check` once at the end, and again only after a fix.
- Do not run `telnyx-edge dev`.

## Read first

- `functions/voice-tools/src/domain/area-incident.ts`. Its `resolve` is the model for the area reset.
- `functions/voice-tools/src/actors/area-incident.ts`. Its `resolve` method is the model for the actor's `reset`.
- `functions/voice-tools/src/domain/customer-account.ts` and `functions/voice-tools/src/actors/customer-account.ts`.
- `functions/voice-tools/src/clients/accounts.ts` and `functions/voice-tools/src/clients/areas.ts`.
- `functions/voice-tools/src/routes/internal-sessions.ts`, the pattern for a route behind `x-internal-key`.
- `functions/voice-tools/src/mcp/tools/report-outage.ts`, which reads the flags and calls `AreaIncident.report`.
- `functions/voice-tools/src/index.ts`, for the routing.
- `scripts/smoke.sh`, the model for the script.

## Files

- voice-tools.
  - `src/domain/customer-account.ts` and `src/domain/area-incident.ts`, one pure `reset` each.
  - `src/actors/customer-account.ts` and `src/actors/area-incident.ts`, one `reset` method each.
  - `src/clients/accounts.ts` and `src/clients/areas.ts`, a `reset` in each client.
  - `src/routes/internal-demo.ts`, which is new.
  - `src/index.ts`, routing and wiring only, `src/config.ts` for the new timeouts, and `src/deps.ts` only if a dependency needs a new field.
  - Tests in `functions/voice-tools/test/`, a new `internal-demo.test.ts` and additions to the existing files.
- `scripts/demo.sh`, which is new.

No new dependency. Leave voice-context, mock-crm, `packages/shared` and `scripts/provision*` alone.

## 1. The resets

- **`CustomerAccount`.**
  - The domain function `reset(state)` empties `calls` and sets `verify` back to no failures and no lock. It keeps `tickets`.
  - The actor method `reset(traceId?)` loads, resets, saves and logs one line, like `verify`. The lock's alarm may still fire later. It finds no lock and does nothing, which it already does.
- **`AreaIncident`.**
  - The domain function `reset(state, { nowMs })` drops every report and any incident.
  - It sets the status to `ok`, raises the version by one and puts that status in the outbox. Unlike `resolve`, it does this even when the area was already `ok`, so KV always gets a fresh status.
  - `nowMs` fails closed when it is not finite, as in `resolve`.
  - The actor method `reset({ nowMs, traceId })` saves the state, records the change in the meta and sets the alarm, exactly as `resolve` does, so the alarm publishes the status to `area/<postcode>/status`.

## 2. Internal routes in voice-tools

Each route checks `x-internal-key` before any state access, the same way as `/internal/sessions`. A wrong or missing key answers 401. Routing stays strict, so any other method on these paths answers 404 before any access. Actor calls carry the trace id `demo-<request time in base 36>`, so their log lines can be found. Each request logs one line at the end, like the other routes.

**Timeouts.** A KV read or write here gets 5,000 ms, because a KV write and read together took up to 3.3 s in the health checks after the T20 ship. Each report and each reset call gets 2,000 ms, so ten reports stay well inside the platform's 30 s limit.

- **`GET /internal/demo/flags`** answers the stored `flags/global` document, or `{}` when there is none. A failed read answers 503.
- **`PUT /internal/demo/flags`** takes a JSON object of flags.
  - Each key must be a known flag with a valid value:
    - `crm_delay_ms`, a finite number of at least 0;
    - `crm_fail`, `dv_force_error` and `diagnostics_enabled`, booleans;
    - `incident_threshold`, `report_window_secs` and `incident_eta_minutes`, integers of at least 1.
  - A value of `null` removes that key, which brings back its default.
  - An unknown key or a bad value answers 400 and writes nothing.
  - The route reads the stored document, merges the input into it, writes the result to `flags/global` and answers it. A stored value that is not a JSON object counts as `{}`. When the read or the write fails or times out, it answers 503, and a failed read writes nothing.
  - KV has no compare-and-swap, so two writes at once could lose one. That is fine for one person setting flags by hand. Say so in a comment.
  - The functions pick the change up within their 10 s flags lifetime plus one KV read.
- **`POST /internal/demo/reports`** takes `{ "postcode": "8670", "count": 2 }`, and optionally a `symptom` from the `report_outage` symptoms, which defaults to `no_connection`.
  - The postcode must be one of the five areas in `AREAS` from `packages/shared`, and `count` must be from 1 to 10.
  - The route calls `AreaIncident.report` once per simulated reporter, one after the other, with the current flags' threshold, window and ETA, as `report_outage` does.
  - Reporter ids are `SIM-<n>-<time>`, where `n` counts up from 1 and `<time>` is the request time in base 36. So a second run adds new reporters instead of being deduped.
  - It answers each report's result in order. A failed or timed-out report stops the run and answers 503 with the results so far.
- **`POST /internal/demo/reset`** resets the eight fixture accounts, `DV-100001` to `DV-100008`, and the five areas.
  - The thirteen calls run in parallel, each with its own timeout, and one failure does not stop the others.
  - It answers each instance with `ok` or `error`. The status is 200 when all thirteen are `ok`, otherwise 500.

## 3. The script

`scripts/demo.sh` is a bash script in the style of `scripts/smoke.sh`.

- **The commands.**
  - `scripts/demo.sh flags` prints the flags.
  - `scripts/demo.sh flags set <name> <value>` sets one. The value is read as JSON, so `true`, `false`, numbers and `null` all work.
  - `scripts/demo.sh reports <postcode> <count> [symptom]` adds simulated reports.
  - `scripts/demo.sh reset` resets the demo state.
  - Anything else prints the usage and exits 2.
- **The URL and the key.** As in `smoke.sh`, the URL comes from `infra/ids.json` and the key from `DUINVEZEL_INTERNAL_KEY`. The script stops with a message before any request when either is missing. It never prints the key and never uses `set -x`.
- **Output.** It prints the answer through `jq .` and exits non-zero on a status other than 2xx, after printing the answer.
- **After `reports`,** it says the new area status reaches calls within about 15 seconds. The alarm publishes it a few seconds after the report, and warm replicas keep area statuses for 10 seconds.

## Tests

- **The domain resets.**
  - An account with calls, failures, a lock and tickets keeps only its tickets.
  - An area reset from `outage` clears the incident, sets the status to `ok`, raises the version and fills the outbox.
  - An area reset from `ok` with reports clears them and still raises the version.
  - A `nowMs` that is not finite fails closed.
- **The area actor.** `reset` sets the alarm, and the alarm then publishes the `ok` status to KV, as the `resolve` tests show.
- **The routes.**
  - A wrong key and a missing key get 401 with no KV or actor access.
  - Another method on each path gets 404.
  - An unknown flag and a bad value each get 400 and write nothing.
  - Merging works, `null` removes a key, and a failed KV read gets 503 and writes nothing.
  - `count` is tested at 1 and 10, and at 0 and 11.
  - A postcode outside the five areas gets 400.
  - Reporter ids differ between two runs.
  - A reset carries on after one instance fails and answers 500, and answers 200 when all are `ok`.
- **The script.** `bash -n scripts/demo.sh` and `shellcheck scripts/demo.sh` pass. It has no unit tests, like `smoke.sh`.

## Acceptance

- [ ] `npm run check` passes, and `shellcheck scripts/demo.sh` is clean.
- [ ] After Thiago ships voice-tools:
  - `scripts/demo.sh reset` answers `ok` for all thirteen instances.
  - `scripts/demo.sh flags set diagnostics_enabled false` shows up as `diagnostics_enabled` `"false"` in the next call's variables, and `null` brings it back.
  - `scripts/demo.sh reports 8670 2`, then Anke's live report, declares the incident once (path I, in T13).

## Out of scope

- Tickets, sessions and voice-context's CRM caches.
- The warm-up, which is the runbook's smoke test and Inspector call (README).
