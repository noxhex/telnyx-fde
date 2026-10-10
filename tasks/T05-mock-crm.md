# T05. mock-crm function

**Phase** 1 · **Depends on** T02

## Goal

A fake ISP back office that the other functions call over HTTP, like a real CRM and line-test system. It has realistic latency and can be made slow or broken through flags, so the KV cache, the timeouts and the degraded paths can be demonstrated.

## Read first

- `AGENTS.md`, all of it.
- `docs/ARCHITECTURE.md`, sections Components, KV keys and Security model.
- Bindings and secrets syntax for `telnyx.toml`, at https://developers.telnyx.com/docs/edge-compute/runtime/bindings.md and https://developers.telnyx.com/docs/edge-compute/configuration/secrets.md (fetch them).

## Files

- `functions/mock-crm/telnyx.toml` (KV binding `KV`, secrets `INTERNAL_KEY` and `DEMO_CALLER_PHONE`).
- `functions/mock-crm/src/index.ts`, `src/routes/customers.ts`, `src/routes/accounts.ts`, `src/routes/lines.ts`, `src/domain/fixtures.ts`, `src/domain/line-test.ts`, `src/auth.ts`, `src/flags.ts`.
- `functions/mock-crm/test/*.test.ts`.
- `packages/shared/package.json`, the `package.json` of each of the three functions, and `package-lock.json`, to add zod.

Take the KV namespace id from `infra/ids.json` (key `kvNamespaceId`). If it is missing, stop and ask, because Thiago creates the namespace by hand.

## zod

This is the first card that validates external input, so it installs zod for the whole repo. Add `zod` at one exact version, the current stable release with no `^` or `~`, as a dependency of `packages/shared` and of each function in `functions/`, all on the same version. Later cards (T08, T09) then import it without touching package files. Here it validates the query and path parameters and the flags read back from KV.

## Routes

Every route except `/healthz` requires the header `x-internal-key` to equal the secret `INTERNAL_KEY`, compared in constant time. A missing or wrong key returns 401 before anything else happens.

| Method and path | Result |
|---|---|
| `GET /healthz` | 200 `{ "ok": true, "svc": "mock-crm" }` |
| `GET /customers?phone=<digits>` | 200 with the customer summary, or 404 `{ "error": "not_found" }` |
| `GET /accounts/<accountNumber>` | 200 with the account, or 404 |
| `POST /lines/<lineId>/test` | 200 with a line test result, after a simulated delay of 800 to 1500 ms |
| anything else | 404 |

## Data

`src/domain/fixtures.ts` holds eight accounts across five postcodes, 8620 Nieuwpoort, 8630 Veurne, 8660 De Panne, 8670 Koksijde and 8600 Diksmuide. Each account has `accountNumber` (format `DV-1xxxxx`), `firstName`, `lastName`, `phone` (E.164), `postcode`, `areaName`, `plan` (`Basic`, `Plus` or `Max`), `lineId` and `lineProfile` (`ok`, `degraded` or `down`). Use invented numbers of the form `+325800000N`.

- `DV-100001` (first name Thiago, 8630 Veurne, line `down`) is the demo account. Its line is down so that diagnostics lead to an outage report in the demo. Its phone is not in the fixtures. It comes from the secret `DEMO_CALLER_PHONE`, so no real number is committed.
- Include at least one account per line profile, and at least two more accounts in 8630 for the simulated reports.
- The customer summary has `accountNumber`, `firstName`, `postcode`, `areaName` and `lineId`. The account adds `lastName`, `plan` and `lineProfile`.

## Line test

`src/domain/line-test.ts` is pure. Given the line profile and an injected random function, it returns `{ lineState, signalDbm, lastSeenMinutes, suggestion, nearbyOutageSuspected }`.

| Profile | Result |
|---|---|
| `ok` | `lineState` `"ok"`, signal between -18 and -22, suggestion to restart the fiber box if the caller still has problems |
| `degraded` | `lineState` `"degraded"`, signal between -26 and -28, suggestion to book a repair visit |
| `down` | `lineState` `"down"`, no signal, `nearbyOutageSuspected` true, suggestion to report an outage |

## Flags

Read `flags/global` from KV with a 10-second in-memory cache. `crm_delay_ms` (default 0) adds that delay to every route except `/healthz`. `crm_fail` (default false) makes every route except `/healthz` return 503 `{ "error": "unavailable" }`. Invalid or missing flags fall back to the defaults, and a `crm_delay_ms` that is not a finite, non-negative number counts as invalid (AGENTS.md, Time inputs fail closed). The delay function is injected, so tests do not wait.

## Logging

One log line per request with `event` `"crm_request"`, the route name, `status`, masked phone or account number, and `latency_ms`.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Tests cover the auth check (missing key, wrong key, right key), each route's found and not-found case, the demo caller lookup through the secret, each line profile, both flags with the KV fake, and an unknown path returning 404 with no KV access.
- [ ] `telnyx-edge dev` serves `GET /healthz`, and `GET /customers?phone=...` with the right header returns a fixture.
- [ ] Nothing is shipped.

## Out of scope

Persisting changes, real customer data.
