# T15. Demo tooling: flags, simulated outage reports and a reset

**Phase** 2 · **Depends on** T22, and runs before T13 · **Code by** implementer agent

## Goal

The demo can be repeated. One script drives the deployed functions to do three things:

- set the feature flags;
- put simulated outage reports on an area;
- reset the demo state.

A reset clears four things:

- every fixture account's call history, and with it the repeat-caller count;
- every fixture account's verification failures and lock;
- every area's reports;
- every area's incident.

So test calls never leave Thiago's account marked as a repeat caller, or any account locked, on review day. Thiago decided this on 13 October. It replaces the T15 outline in `tasks/later.md`.

## Read first

- `docs/ARCHITECTURE.md`, State and Security model, and `docs/DECISIONS.md`, ADR-004, ADR-005 and ADR-015.
- `functions/voice-tools/src/domain/customer-account.ts`, `domain/area-incident.ts` and the two actors in `src/actors/`.
- `functions/voice-tools/src/routes/internal-sessions.ts`, the pattern for an internal route behind `x-internal-key`.
- `functions/voice-tools/src/flags.ts` and the flag schemas in `functions/voice-context/src/config.ts` and `functions/mock-crm/src/flags.ts`.
- `scripts/provision.ts` and `scripts/provision/`, for the style of a script and its tests.
- `AGENTS.md`, all of it.

## Files

- voice-tools.
  - `src/domain/customer-account.ts` and `src/domain/area-incident.ts`, one pure `reset` each.
  - `src/actors/customer-account.ts` and `src/actors/area-incident.ts`, one `reset` method each.
  - `src/routes/internal-demo.ts`, which is new.
  - `src/index.ts`, routing only, and `src/config.ts`.
  - The tests in `functions/voice-tools/test/`.
- `scripts/demo.ts`, which is new, any helpers under `scripts/demo/`, and `scripts/test/demo.test.ts`.

No new dependency. Leave voice-context, mock-crm and `packages/shared` alone.

## 1. The resets

- **`CustomerAccount`.** The domain function `reset(state)` empties `calls` and sets `verify` back to no failures and no lock. It keeps `tickets`. The actor method `reset()` loads, resets and saves.
- **`AreaIncident`.**
  - The domain function `reset(state, { nowMs })` drops every report and any incident.
  - It sets the status to `ok`, raises the version by one and puts that status in the outbox. It does this even when the area was already `ok`, so KV always gets a fresh status.
  - The actor method publishes the outbox to `area/<postcode>/status` the same way `resolve` does.
  - `nowMs` fails closed when it is not finite.

## 2. Internal routes in voice-tools

Each route checks `x-internal-key` before any state access, like `/internal/sessions`, and a wrong or missing key answers 401. The routes follow the strict routing rules in `AGENTS.md`.

- **`GET /internal/demo/flags`** answers the stored `flags/global` document, or `{}` when there is none.
- **`PUT /internal/demo/flags`** takes a JSON object of flags.
  - Each key must be a known flag with a valid value:
    - `crm_delay_ms`, a finite number of at least 0;
    - `crm_fail`, `dv_force_error` and `diagnostics_enabled`, booleans;
    - `incident_threshold`, `report_window_secs` and `incident_eta_minutes`, integers of at least 1.
  - A value of `null` removes that key, which brings back its default.
  - An unknown key or a bad value answers 400 and writes nothing.
  - The route merges the input into the stored document, writes it to `flags/global` and answers the new document.
  - The functions pick the change up within their 10 s flags lifetime plus one KV read.
- **`POST /internal/demo/reports`** takes `{ "postcode": "8670", "count": 2 }`, and optionally a `symptom`, which defaults to `no_connection`.
  - The postcode must be one of the five areas, and `count` must be from 1 to 10.
  - The route calls `AreaIncident.report` once per simulated reporter, using the current flags' threshold, window and ETA, as `report_outage` does.
  - Reporter ids are `SIM-<n>-<time>`, where `n` counts up from 1 and `<time>` is the request time in base 36. So a second run adds new reporters instead of being deduped.
  - It answers every report's result, then the area's status.
- **`POST /internal/demo/reset`** resets the eight fixture accounts, `DV-100001` to `DV-100008`, and the five areas.
  - One failure does not stop the others.
  - It answers each instance with `ok` or `error`. The status is 200 when all thirteen are `ok`, otherwise 500.

## 3. The script

- **The commands.**
  - `node scripts/demo.ts flags` prints the flags.
  - `node scripts/demo.ts flags set <name> <value>` sets one. The value is read as JSON, so `true`, `false`, numbers and `null` all work.
  - `node scripts/demo.ts reports <postcode> <count>` adds simulated reports.
  - `node scripts/demo.ts reset` resets the demo state.
- **The URL and the key.** The script reads voice-tools' invoke URL from `infra/ids.json` and `INTERNAL_KEY` from the environment, and it never prints the key.
- **Output.** It prints each answer as a short table.
- **After `reports`,** it says the new area status reaches calls within about 15 seconds. The alarm publishes it a few seconds after the report, and warm replicas keep area statuses for 10 seconds.
- **Imports.** Like the provisioning script, it imports nothing from `packages/` or `functions/`.

## Tests

- **The domain resets.**
  - An account with calls, failures, a lock and tickets keeps only its tickets.
  - An area reset from `outage` clears the incident, sets the status to `ok`, raises the version and fills the outbox.
  - An area reset from `ok` with reports clears them and still raises the version.
  - A `nowMs` that is not finite fails closed.
- **The routes.**
  - A wrong key gets 401 with no KV or actor access.
  - An unknown flag and a bad type each get 400.
  - Merging works, and `null` removes a key.
  - `count` is tested at 1 and 10, and at 0 and 11.
  - A postcode outside the five areas gets 400.
  - Reporter ids differ between two runs.
  - A reset carries on after one instance fails and answers 500.
- **The script.**
  - Argument parsing and the usage text work.
  - The URL comes from `infra/ids.json` and the key from the environment.
  - The key never appears in the output.
  - A non-2xx answer exits non-zero with the route's error.

## Acceptance

- [ ] `npm run check` passes.
- [ ] After Thiago ships voice-tools:
  - `reset` answers `ok` for all thirteen instances.
  - `flags set diagnostics_enabled false` shows up as `diagnostics_enabled` `"false"` in the next call's variables.
  - `reports 8670` with one report fewer than the threshold, then Anke's live report, declares the incident once (path I).

## Out of scope

- `scripts/tail.sh`. Claude Code reads the logs with read-only commands.
- Tickets, sessions and voice-context's CRM caches.
- The warm-up (T14).
